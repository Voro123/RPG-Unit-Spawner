(() => {
  const BG_SETTINGS_KEY = 'rpg-unit-spawner.cellBgSettings.v1';
  const SESSION_PREVIEW_CACHE = window.__RpgCellPreviewCache || (window.__RpgCellPreviewCache = new Map());
  const DIRTY_PIXEL_CACHE = window.__RpgDirtyPixelCache || (window.__RpgDirtyPixelCache = new Map());
  const MAX_HISTORY = 50;
  const undoStack = [];
  const redoStack = [];
  let installed = false;
  let activeAction = null;
  let finishTimer = null;
  let restoring = false;
  let metaCache = new Map();

  function $(id) { return document.getElementById(id); }

  function projectId() {
    return localStorage.getItem('rpg-unit-spawner.projectId') || '';
  }

  function withProject(url) {
    const pid = projectId();
    if (!pid) return url;
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}projectId=${encodeURIComponent(pid)}`;
  }

  function cellKey(sheetId, index) {
    return `${projectId() || 'default'}:${sheetId}:${index}`;
  }

  function currentSheetId() {
    return $('sheetSel')?.value || '';
  }

  function selectedIndexes() {
    const region = Array.from(document.querySelectorAll('#grid .cell.region'));
    const targets = region.length ? region : Array.from(document.querySelectorAll('#grid .cell.selected'));
    return targets.map((el) => Number(el.dataset.i)).filter((v) => Number.isInteger(v));
  }

  function readAllBgSettings() {
    try { return JSON.parse(localStorage.getItem(BG_SETTINGS_KEY) || '{}') || {}; }
    catch { return {}; }
  }

  function writeAllBgSettings(settings) {
    localStorage.setItem(BG_SETTINGS_KEY, JSON.stringify(settings));
  }

  function defaultBgSettings() {
    return { bgTolerance: '24', bgColor: '#ffffff', removeBg: true };
  }

  function setMeta(text) {
    if ($('pixelEditorMeta')) $('pixelEditorMeta').textContent = text;
  }

  async function fetchJson(url) {
    const headers = projectId() ? { 'x-project-id': projectId() } : {};
    const r = await fetch(withProject(url), { headers, cache: 'no-store' });
    return r.json();
  }

  async function getSheetMeta(sheetId) {
    const key = `${projectId()}:${sheetId}`;
    if (metaCache.has(key)) return metaCache.get(key);
    const meta = await fetchJson(`/api/sprites/${sheetId}`);
    metaCache.set(key, meta);
    return meta;
  }

  function inferAssetKind(cell) {
    if (cell?.assetKind === 'tile' || cell?.assetKind === 'sprite') return cell.assetKind;
    const tag = String(cell?.tag || '');
    if (tag.startsWith('地块：')) return 'tile';
    if (tag.startsWith('非地块：')) return 'sprite';
    return 'sprite';
  }

  function displayedSrc(index) {
    return document.querySelector(`#grid .cell[data-i="${index}"] img`)?.src || '';
  }

  function sourceForSnapshot(sheetId, index, cell) {
    const key = cellKey(sheetId, index);
    return DIRTY_PIXEL_CACHE.get(key)
      || SESSION_PREVIEW_CACHE.get(key)
      || displayedSrc(index)
      || (cell?.imageRef ? withProject(`/api/sprites/${sheetId}/cells/${index}?t=${Date.now()}`) : '');
  }

  async function loadImage(src) {
    return await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  function makeCanvas(size) {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    return canvas;
  }

  async function normalizeImageToDataUrl(src, size) {
    const canvas = makeCanvas(size);
    if (src) {
      const img = await loadImage(src);
      canvas.getContext('2d').drawImage(img, 0, 0, size, size);
    }
    return canvas.toDataURL('image/png');
  }

  async function snapshotSelection(label = '') {
    const sheetId = currentSheetId();
    const indexes = selectedIndexes();
    if (!sheetId || !indexes.length) return null;

    const sheet = await getSheetMeta(sheetId);
    const size = Math.max(1, Number(sheet.cellSize) || 32);
    const allBgSettings = readAllBgSettings();
    const immediate = indexes.map((index) => {
      const cell = sheet.cells?.find?.((c) => Number(c.index) === Number(index));
      return {
        index,
        cell,
        src: sourceForSnapshot(sheetId, index, cell),
        bgSettings: allBgSettings[cellKey(sheetId, index)] || null,
      };
    });

    const items = [];
    for (const item of immediate) {
      if (!item.cell?.imageRef && !item.src) continue;
      const dataUrl = await normalizeImageToDataUrl(item.src, size);
      items.push({
        index: item.index,
        dataUrl,
        tag: item.cell?.tag || '',
        assetKind: inferAssetKind(item.cell),
        bgSettings: item.bgSettings,
      });
    }
    if (!items.length) return null;
    return { sheetId, size, label, items, at: Date.now() };
  }

  function snapshotSignature(snapshot) {
    if (!snapshot) return '';
    return JSON.stringify({
      sheetId: snapshot.sheetId,
      items: snapshot.items.map((item) => ({
        index: item.index,
        dataUrl: item.dataUrl,
        bgSettings: item.bgSettings || null,
      })),
    });
  }

  function snapshotsDiffer(a, b) {
    return snapshotSignature(a) !== snapshotSignature(b);
  }

  function setButtonState() {
    const undoBtn = $('pixelUndoBtn');
    const redoBtn = $('pixelRedoBtn');
    if (undoBtn) undoBtn.disabled = undoStack.length === 0;
    if (redoBtn) redoBtn.disabled = redoStack.length === 0;
  }

  function pushHistory(action) {
    if (!action?.before || !action?.after || !snapshotsDiffer(action.before, action.after)) return;
    undoStack.push(action);
    while (undoStack.length > MAX_HISTORY) undoStack.shift();
    redoStack.length = 0;
    setButtonState();
  }

  async function beginAction(label) {
    if (restoring || activeAction) return;
    const before = await snapshotSelection(label);
    if (!before) return;
    activeAction = { label, before };
  }

  function finishActionSoon(delay = 180) {
    if (restoring) return;
    clearTimeout(finishTimer);
    finishTimer = setTimeout(async () => {
      if (!activeAction) return;
      const action = activeAction;
      activeAction = null;
      const after = await snapshotSelection(action.label);
      if (!after) return;
      pushHistory({ label: action.label, before: action.before, after });
    }, delay);
  }

  function setGridPreview(index, dataUrl) {
    const cellEl = document.querySelector(`#grid .cell[data-i="${index}"]`);
    if (!cellEl) return;
    cellEl.classList.add('filled');
    let img = cellEl.querySelector('img');
    if (!img) {
      img = document.createElement('img');
      img.alt = '';
      const idx = cellEl.querySelector('.idx');
      if (idx?.nextSibling) cellEl.insertBefore(img, idx.nextSibling);
      else cellEl.appendChild(img);
    }
    img.style.visibility = '';
    img.src = dataUrl;
  }

  function setEditorCanvasFromDataUrl(dataUrl, size) {
    const canvas = $('pixelEditorCanvas');
    if (!canvas) return;
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, size, size);
    const img = new Image();
    img.onload = () => ctx.drawImage(img, 0, 0, size, size);
    img.src = dataUrl;
  }

  async function saveRestoredItem(sheetId, item) {
    const base64 = String(item.dataUrl).split(',')[1] || '';
    const r = await fetch(`/api/sprites/${sheetId}/cells/${item.index}/image`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...(projectId() ? { 'x-project-id': projectId() } : {}),
      },
      body: JSON.stringify({
        image: base64,
        tag: item.tag || '',
        assetKind: item.assetKind || 'sprite',
        projectId: projectId(),
      }),
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || `恢复格子 ${item.index} 失败`);
  }

  function restoreBgSettings(snapshot) {
    const all = readAllBgSettings();
    for (const item of snapshot.items) {
      const key = cellKey(snapshot.sheetId, item.index);
      if (item.bgSettings) all[key] = item.bgSettings;
      else delete all[key];
    }
    writeAllBgSettings(all);

    const selected = selectedIndexes();
    const firstSelected = snapshot.items.find((item) => selected.includes(item.index));
    const settings = firstSelected?.bgSettings || defaultBgSettings();
    if ($('bgTolerance')) $('bgTolerance').value = String(settings.bgTolerance ?? 24);
    if ($('bgToleranceValue')) $('bgToleranceValue').textContent = String(settings.bgTolerance ?? 24);
    if ($('bgColor')) $('bgColor').value = settings.bgColor || '#ffffff';
    if ($('removeBg')) $('removeBg').checked = !!settings.removeBg;
  }

  async function restoreSnapshot(snapshot) {
    if (!snapshot) return;
    restoring = true;
    try {
      restoreBgSettings(snapshot);
      for (const item of snapshot.items) {
        const key = cellKey(snapshot.sheetId, item.index);
        SESSION_PREVIEW_CACHE.set(key, item.dataUrl);
        DIRTY_PIXEL_CACHE.set(key, item.dataUrl);
        setGridPreview(item.index, item.dataUrl);
        await saveRestoredItem(snapshot.sheetId, item);
        DIRTY_PIXEL_CACHE.delete(key);
        SESSION_PREVIEW_CACHE.set(key, item.dataUrl);
      }
      const selected = selectedIndexes();
      const first = snapshot.items.find((item) => selected.includes(item.index)) || snapshot.items[0];
      if (currentSheetId() === snapshot.sheetId && first) setEditorCanvasFromDataUrl(first.dataUrl, snapshot.size);
      const loadBtn = $('loadPixelBtn');
      if (loadBtn) setTimeout(() => loadBtn.click(), 80);
    } finally {
      restoring = false;
      setButtonState();
    }
  }

  async function undo() {
    if (!undoStack.length || restoring) return;
    const action = undoStack.pop();
    redoStack.push(action);
    setMeta(`撤回：${action.label}`);
    await restoreSnapshot(action.before);
  }

  async function redo() {
    if (!redoStack.length || restoring) return;
    const action = redoStack.pop();
    undoStack.push(action);
    setMeta(`重做：${action.label}`);
    await restoreSnapshot(action.after);
  }

  function injectControls() {
    const box = $('pixelEditorBox');
    if (!box || $('pixelUndoRedoControls')) return false;
    const controls = document.createElement('div');
    controls.id = 'pixelUndoRedoControls';
    controls.className = 'pixel-undo-redo-controls';
    controls.innerHTML = `
      <div class="row" style="align-items:center;gap:6px;margin-bottom:8px">
        <button class="ghost" id="pixelUndoBtn" type="button" disabled>撤回</button>
        <button class="ghost" id="pixelRedoBtn" type="button" disabled>重做</button>
        <span class="muted" style="font-size:12px">Ctrl+Z / Ctrl+Y，刷新后历史清空</span>
      </div>
    `;
    const stage = box.querySelector('.pixel-editor-stage');
    box.insertBefore(controls, stage || box.firstChild);
    $('pixelUndoBtn').onclick = () => undo().catch((e) => setMeta('撤回失败：' + (e.message || e)));
    $('pixelRedoBtn').onclick = () => redo().catch((e) => setMeta('重做失败：' + (e.message || e)));
    return true;
  }

  function bindHistoryCapture() {
    const canvas = $('pixelEditorCanvas');
    if (canvas && canvas.dataset.undoRedoBound !== '1') {
      canvas.dataset.undoRedoBound = '1';
      canvas.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        beginAction('像素绘制');
      }, true);
      document.addEventListener('mouseup', () => finishActionSoon(220), true);
    }

    document.addEventListener('pointerdown', (e) => {
      if (restoring) return;
      const id = e.target?.id;
      if (id === 'pixelShiftUpBtn' || id === 'pixelShiftDownBtn') beginAction(id === 'pixelShiftUpBtn' ? '上移' : '下移');
      if (id === 'applyBgBtn' || e.target?.closest?.('#applyBgBtn')) beginAction('应用相近色');
      if (id === 'bgTolerance' || id === 'bgColor' || id === 'removeBg') beginAction('相近色调整');
    }, true);

    document.addEventListener('click', (e) => {
      const id = e.target?.id;
      if (id === 'pixelShiftUpBtn' || id === 'pixelShiftDownBtn') finishActionSoon(1000);
      if (id === 'applyBgBtn' || e.target?.closest?.('#applyBgBtn')) finishActionSoon(1000);
    }, true);

    document.addEventListener('input', (e) => {
      if (['bgTolerance', 'bgColor'].includes(e.target?.id)) {
        beginAction('相近色调整');
        finishActionSoon(420);
      }
    }, true);

    document.addEventListener('change', (e) => {
      if (['bgTolerance', 'bgColor', 'removeBg'].includes(e.target?.id)) {
        beginAction('相近色调整');
        finishActionSoon(420);
      }
      if (e.target?.id === 'sheetSel') metaCache = new Map();
    }, true);

    document.addEventListener('keydown', (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo().catch((err) => setMeta('撤回失败：' + (err.message || err)));
      } else if (key === 'y' || (key === 'z' && e.shiftKey)) {
        e.preventDefault();
        redo().catch((err) => setMeta('重做失败：' + (err.message || err)));
      }
    }, true);
  }

  function install() {
    if (installed) return true;
    if (!injectControls()) return false;
    installed = true;
    bindHistoryCapture();
    setButtonState();
    return true;
  }

  function boot() {
    if (install()) return;
    setTimeout(boot, 120);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
