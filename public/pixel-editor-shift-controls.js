(() => {
  const SESSION_PREVIEW_CACHE = window.__RpgCellPreviewCache || (window.__RpgCellPreviewCache = new Map());
  const DIRTY_PIXEL_CACHE = window.__RpgDirtyPixelCache || (window.__RpgDirtyPixelCache = new Map());
  let installed = false;
  let metaCache = new Map();

  function $(id) { return document.getElementById(id); }

  function ensureRegenerateSyncScript() {
    if ($('pixelEditorRegenerateSyncScript')) return;
    const script = document.createElement('script');
    script.id = 'pixelEditorRegenerateSyncScript';
    script.src = '/pixel-editor-regenerate-sync.js';
    document.head.appendChild(script);
  }

  function ensureUndoRedoScript() {
    if ($('pixelEditorUndoRedoScript')) return;
    const script = document.createElement('script');
    script.id = 'pixelEditorUndoRedoScript';
    script.src = '/pixel-editor-undo-redo.js';
    document.head.appendChild(script);
  }

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

  async function fetchJson(url) {
    const headers = projectId() ? { 'x-project-id': projectId() } : {};
    const r = await fetch(withProject(url), { headers, cache: 'no-store' });
    return r.json();
  }

  async function loadImage(src) {
    return await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  async function getSheetMeta(sheetId) {
    const key = `${projectId()}:${sheetId}`;
    if (metaCache.has(key)) return metaCache.get(key);
    const meta = await fetchJson(`/api/sprites/${sheetId}`);
    metaCache.set(key, meta);
    return meta;
  }

  function currentSheetId() {
    return $('sheetSel')?.value || '';
  }

  function selectedIndexes() {
    const region = Array.from(document.querySelectorAll('#grid .cell.region'));
    const targets = region.length ? region : Array.from(document.querySelectorAll('#grid .cell.selected'));
    return targets.map((el) => Number(el.dataset.i)).filter((v) => Number.isInteger(v));
  }

  function inferAssetKind(cell) {
    if (cell?.assetKind === 'tile' || cell?.assetKind === 'sprite') return cell.assetKind;
    const tag = String(cell?.tag || '');
    if (tag.startsWith('地块：')) return 'tile';
    if (tag.startsWith('非地块：')) return 'sprite';
    return '';
  }

  function displaySrc(index) {
    return document.querySelector(`#grid .cell[data-i="${index}"] img`)?.src || '';
  }

  function sourceForCell(sheetId, index) {
    const key = cellKey(sheetId, index);
    return DIRTY_PIXEL_CACHE.get(key)
      || SESSION_PREVIEW_CACHE.get(key)
      || displaySrc(index)
      || withProject(`/api/sprites/${sheetId}/cells/${index}?t=${Date.now()}`);
  }

  function makeCanvas(size) {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    return canvas;
  }

  async function canvasFromSource(src, size) {
    const canvas = makeCanvas(size);
    const ctx = canvas.getContext('2d');
    if (src) {
      const img = await loadImage(src);
      ctx.clearRect(0, 0, size, size);
      ctx.drawImage(img, 0, 0, size, size);
    }
    return canvas;
  }

  function shiftedCanvas(source, dy) {
    const canvas = makeCanvas(source.width);
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(source, 0, dy);
    return canvas;
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

  function setEditorCanvas(canvas) {
    const target = $('pixelEditorCanvas');
    if (!target) return;
    target.width = canvas.width;
    target.height = canvas.height;
    const ctx = target.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, target.width, target.height);
    ctx.drawImage(canvas, 0, 0);
  }

  async function saveCanvas(sheetId, index, canvas, cell) {
    const r = await fetch(`/api/sprites/${sheetId}/cells/${index}/image`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...(projectId() ? { 'x-project-id': projectId() } : {}),
      },
      body: JSON.stringify({
        image: canvas.toDataURL('image/png').split(',')[1],
        tag: cell?.tag || '',
        assetKind: inferAssetKind(cell) || 'sprite',
        projectId: projectId(),
      }),
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || `保存格子 ${index} 失败`);
  }

  function stepValue() {
    return Math.max(1, Math.min(64, Number($('pixelShiftStep')?.value || 1)));
  }

  async function shiftSelected(dySign) {
    const sheetId = currentSheetId();
    const indexes = selectedIndexes();
    if (!sheetId || !indexes.length) {
      if ($('pixelEditorMeta')) $('pixelEditorMeta').textContent = '请先选择一个或多个非地块格子。';
      return;
    }

    const meta = await getSheetMeta(sheetId);
    const size = Math.max(1, Number(meta.cellSize) || 32);
    const step = stepValue();
    const dy = dySign * step;
    let moved = 0;
    let skippedTiles = 0;
    let firstCanvas = null;

    for (const index of indexes) {
      const cell = meta.cells?.find?.((c) => Number(c.index) === Number(index));
      if (!cell?.imageRef) continue;
      const kind = inferAssetKind(cell);
      if (kind === 'tile') {
        skippedTiles += 1;
        continue;
      }
      const source = sourceForCell(sheetId, index);
      const current = await canvasFromSource(source, size);
      const shifted = shiftedCanvas(current, dy);
      const dataUrl = shifted.toDataURL('image/png');
      const key = cellKey(sheetId, index);
      SESSION_PREVIEW_CACHE.set(key, dataUrl);
      DIRTY_PIXEL_CACHE.set(key, dataUrl);
      setGridPreview(index, dataUrl);
      if (!firstCanvas) firstCanvas = shifted;
      await saveCanvas(sheetId, index, shifted, cell);
      DIRTY_PIXEL_CACHE.delete(key);
      SESSION_PREVIEW_CACHE.set(key, dataUrl);
      moved += 1;
    }

    if (firstCanvas) setEditorCanvas(firstCanvas);
    const direction = dy < 0 ? '上移' : '下移';
    const msg = `${direction} ${step}px：已处理 ${moved} 个非地块${skippedTiles ? `，跳过 ${skippedTiles} 个地块` : ''}`;
    if ($('pixelEditorMeta')) $('pixelEditorMeta').textContent = msg;
    if ($('opStatus')) $('opStatus').textContent = msg;
  }

  function injectControls() {
    const box = $('pixelEditorBox');
    if (!box || $('pixelShiftControls')) return false;
    const controls = document.createElement('div');
    controls.id = 'pixelShiftControls';
    controls.className = 'pixel-shift-controls';
    controls.innerHTML = `
      <div style="font-weight:700;margin:8px 0 6px">非地块位置微调</div>
      <div class="row" style="align-items:center;gap:6px">
        <button class="ghost" id="pixelShiftUpBtn" type="button">上移</button>
        <button class="ghost" id="pixelShiftDownBtn" type="button">下移</button>
        <label style="margin:0;display:flex;align-items:center;gap:6px">步长 <input id="pixelShiftStep" type="number" min="1" max="64" value="1" style="width:72px;margin:0" /> px</label>
      </div>
      <p class="muted" style="margin-top:6px">只移动非地块；框选多个非地块时会一起移动。新露出的像素保持透明。</p>
    `;
    const stage = box.querySelector('.pixel-editor-stage');
    box.insertBefore(controls, stage || box.firstChild);
    $('pixelShiftUpBtn').onclick = () => shiftSelected(-1).catch((e) => {
      if ($('pixelEditorMeta')) $('pixelEditorMeta').textContent = '上移失败：' + (e.message || e);
    });
    $('pixelShiftDownBtn').onclick = () => shiftSelected(1).catch((e) => {
      if ($('pixelEditorMeta')) $('pixelEditorMeta').textContent = '下移失败：' + (e.message || e);
    });
    return true;
  }

  function install() {
    if (installed) return true;
    if (!injectControls()) return false;
    installed = true;
    ensureRegenerateSyncScript();
    ensureUndoRedoScript();
    document.addEventListener('change', (e) => {
      if (e.target?.id === 'sheetSel') metaCache = new Map();
    }, true);
    return true;
  }

  function boot() {
    if (install()) return;
    setTimeout(boot, 120);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
