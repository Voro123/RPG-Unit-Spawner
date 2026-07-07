(() => {
  const KEY = 'rpg-unit-spawner.projectId';
  let currentProjectId = '';
  let projectsCache = [];
  let activeGeneration = null;
  let promptPreviewTimer = null;
  let generationTargetIndex = null;
  let deferredSelectedIndex = null;
  let selectionLockInstalled = false;
  let assetKindRestoreInstalled = false;

  function $(id) { return document.getElementById(id); }

  function enc(v) { return encodeURIComponent(v || ''); }

  function withProject(url) {
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}projectId=${enc(currentProjectId)}`;
  }

  function isGenerationEndpoint(url) {
    return /\/api\/sprites\/[^/]+\/cells\/[^/]+\/(generate|replace)$/.test(url)
      || /\/api\/sprites\/[^/]+\/generate-raw$/.test(url)
      || url === '/api/generate';
  }

  function cellGenerationMatch(url) {
    return /\/api\/sprites\/([^/]+)\/cells\/([^/]+)\/(generate|replace)$/.exec(url || '');
  }

  function domSelectedCellIndex() {
    const el = document.querySelector('#grid .cell.selected');
    return el ? Number(el.dataset.i) : null;
  }

  function currentEditableFinalPrompt() {
    const t = $('promptPreviewText');
    return t ? t.value.trim() : '';
  }

  async function rawJson(url, opt = {}) {
    const headers = { ...(opt.headers || {}) };
    if (currentProjectId) headers['x-project-id'] = currentProjectId;
    const r = await fetch(opt.method === 'GET' || !opt.method ? withProject(url) : url, { ...opt, headers });
    return r.json();
  }

  async function loadImageFromBlobUrl(url) {
    const blob = await (await fetch(url, { cache: 'no-store' })).blob();
    const objectUrl = URL.createObjectURL(blob);
    try {
      return await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = objectUrl;
      });
    } finally {
      setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
    }
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  function canvasToBase64(canvas) {
    return canvas.toDataURL('image/png').split(',')[1];
  }

  function drawImageToCellCanvas(img, size) {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, size, size);
    ctx.drawImage(img, 0, 0, size, size);
    return canvas;
  }

  async function resizeCellImageToSheetSize(sheetId, index, meta) {
    const sheet = meta?.cellSize ? meta : await rawJson(`/api/sprites/${sheetId}`);
    const size = Math.max(1, Number(sheet.cellSize) || 32);
    const cell = sheet.cells?.find?.((c) => Number(c.index) === Number(index));
    if (!cell?.imageRef) return meta || sheet;
    const img = await loadImageFromBlobUrl(withProject(`/api/sprites/${sheetId}/cells/${index}?t=${Date.now()}`));
    if ((img.naturalWidth || img.width) === size && (img.naturalHeight || img.height) === size) return meta || sheet;
    const canvas = drawImageToCellCanvas(img, size);
    const tag = cell.tag || '';
    const updated = await rawJson(`/api/sprites/${sheetId}/cells/${index}/image`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: canvasToBase64(canvas), tag, projectId: currentProjectId }),
    });
    return updated.ok ? updated.meta : (meta || sheet);
  }

  async function maybePostprocessCellGeneration(url, response) {
    const m = cellGenerationMatch(url);
    if (!m) return response;
    const text = await response.text();
    let json;
    try { json = JSON.parse(text); } catch { return new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers }); }
    if (json?.ok && json.meta) {
      try {
        json.meta = await resizeCellImageToSheetSize(m[1], m[2], json.meta);
        json.postprocessedSize = json.meta?.cellSize || null;
      } catch (e) {
        json.postprocessError = e.message || String(e);
      }
    }
    return new Response(JSON.stringify(json), { status: response.status, statusText: response.statusText, headers: { 'Content-Type': 'application/json' } });
  }

  async function api(url, opt = {}) {
    const method = (opt.method || 'GET').toUpperCase();
    const headers = { ...(opt.headers || {}) };
    const signal = opt.signal || activeGeneration?.controller?.signal;
    if (currentProjectId) headers['x-project-id'] = currentProjectId;

    if (method === 'GET' || method === 'HEAD') {
      return fetch(withProject(url), { ...opt, headers, signal });
    }

    let body = opt.body;
    if (headers['Content-Type'] === 'application/json' && body) {
      try {
        const json = JSON.parse(body);
        const finalPrompt = isGenerationEndpoint(url) ? currentEditableFinalPrompt() : '';
        body = JSON.stringify({ ...json, projectId: currentProjectId, ...(finalPrompt ? { finalPrompt } : {}) });
      } catch { /* keep body */ }
    }

    const response = await fetch(url, { ...opt, headers, body, signal });
    return maybePostprocessCellGeneration(url, response);
  }

  function injectStyle() {
    if ($('projectStyle')) return;
    const s = document.createElement('style');
    s.id = 'projectStyle';
    s.textContent = `
      .project-bar{position:fixed;right:16px;top:12px;z-index:2000;display:flex;gap:8px;align-items:center;background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:8px;box-shadow:0 8px 24px rgba(0,0,0,.25)}
      .project-bar select{width:180px;margin:0;padding:7px 10px}.project-bar button{padding:7px 10px}
      .project-overlay{position:fixed;inset:0;z-index:5000;background:rgba(0,0,0,.72);display:flex;align-items:center;justify-content:center;padding:24px}
      .project-modal{width:min(520px,100%);background:var(--panel);border:1px solid var(--border);border-radius:16px;padding:22px;box-shadow:0 14px 60px rgba(0,0,0,.5)}
      .prompt-preview-box{margin-top:14px;border:1px solid var(--border);border-radius:10px;background:var(--panel2);padding:10px}
      .prompt-preview-box summary{cursor:pointer;font-weight:700}.prompt-preview-box textarea{min-height:180px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.5}.prompt-preview-meta{font-size:12px;margin-top:6px;color:var(--muted)}.prompt-preview-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:8px 0}
      .pixel-editor-box,.cell-copy-box{margin-top:16px;border:1px solid var(--border);border-radius:10px;background:var(--panel2);padding:10px}.pixel-editor-box summary,.cell-copy-box summary{cursor:pointer;font-weight:700}.pixel-editor-tools,.cell-copy-tools{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:8px 0}.pixel-editor-tools input[type=color]{width:44px;height:34px;padding:2px;margin:0}.pixel-editor-tools input[type=number]{width:92px}.pixel-editor-stage{display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap}.pixel-editor-canvas{width:min(512px,90vw);height:min(512px,90vw);image-rendering:pixelated;border:1px solid var(--border);border-radius:8px;background-color:#20242e;background-image:linear-gradient(45deg,rgba(255,255,255,.16) 25%,transparent 25%),linear-gradient(-45deg,rgba(255,255,255,.16) 25%,transparent 25%),linear-gradient(45deg,transparent 75%,rgba(255,255,255,.16) 75%),linear-gradient(-45deg,transparent 75%,rgba(255,255,255,.16) 75%);background-size:16px 16px;background-position:0 0,0 8px,8px -8px,-8px 0;cursor:crosshair}.pixel-editor-meta,.cell-copy-meta{font-size:12px;color:var(--muted);line-height:1.7}.pixel-editor-swatch{display:inline-block;width:16px;height:16px;border:1px solid var(--border);vertical-align:middle;margin-right:4px}.cell-copy-box input[type=text]{min-width:260px;flex:1}
      @media(max-width:760px){.project-bar{position:static;margin:10px 12px}.project-bar select{width:100%}}
    `;
    document.head.appendChild(s);
  }

  async function loadProjects() {
    projectsCache = await (await fetch('/api/projects')).json();
    return projectsCache;
  }

  async function createProject(name) {
    const r = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const p = await r.json();
    if (!p.id) throw new Error(p.error || '创建项目失败');
    localStorage.setItem(KEY, p.id);
    currentProjectId = p.id;
    return p;
  }

  function showCreateOverlay() {
    if ($('projectOverlay')) return;
    const div = document.createElement('div');
    div.id = 'projectOverlay';
    div.className = 'project-overlay';
    div.innerHTML = `
      <div class="project-modal">
        <h1 style="margin-top:0">创建第一个项目</h1>
        <p class="muted">项目会隔离精灵图等运行时数据。开始前请先创建一个项目。</p>
        <label>项目名称</label>
        <input id="firstProjectName" placeholder="如：像素城镇 RPG" />
        <div class="row" style="margin-top:14px"><button id="createFirstProject">创建项目</button><span id="firstProjectStatus" class="muted"></span></div>
      </div>`;
    document.body.appendChild(div);
    setTimeout(() => $('firstProjectName')?.focus(), 0);
    $('createFirstProject').onclick = async () => {
      try {
        $('firstProjectStatus').textContent = '创建中…';
        await createProject($('firstProjectName').value.trim());
        location.reload();
      } catch (e) {
        $('firstProjectStatus').textContent = e.message || e;
      }
    };
  }

  function renderBar() {
    if (!projectsCache.length) return;
    if ($('projectBar')) $('projectBar').remove();
    const bar = document.createElement('div');
    bar.id = 'projectBar';
    bar.className = 'project-bar';
    bar.innerHTML = `
      <span class="muted">项目</span>
      <select id="projectSelect">${projectsCache.map((p) => `<option value="${p.id}" ${p.id === currentProjectId ? 'selected' : ''}>${p.name}</option>`).join('')}</select>
      <button class="ghost" id="addProjectBtn">新增</button>`;
    document.body.appendChild(bar);
    $('projectSelect').onchange = () => {
      currentProjectId = $('projectSelect').value;
      localStorage.setItem(KEY, currentProjectId);
      location.reload();
    };
    $('addProjectBtn').onclick = async () => {
      const name = prompt('新项目名称');
      if (!name) return;
      await createProject(name);
      location.reload();
    };
  }

  function installSpriteBackgroundKindGuard() {
    const radios = Array.from(document.querySelectorAll('input[name=assetKind]'));
    const removeBg = $('removeBg');
    const bgColor = $('bgColor');
    const bgTolerance = $('bgTolerance');
    const bgPreview = $('bgPreview');
    const applyBtn = $('applyBgBtn');
    if (!radios.length || !removeBg) return;

    const bgTitle = removeBg.closest('.row')?.previousElementSibling;
    const removeRow = removeBg.closest('.row');
    const toleranceLabel = bgTolerance?.previousElementSibling;
    const previewRow = bgPreview?.closest('.row');
    const note = previewRow?.nextElementSibling;
    const elements = [bgTitle, removeRow, toleranceLabel, bgTolerance, previewRow, note];
    const controls = [removeBg, bgColor, bgTolerance, applyBtn];

    function visible(el, on) { if (el) el.style.display = on ? '' : 'none'; }

    function sync() {
      const kind = document.querySelector('input[name=assetKind]:checked')?.value || 'sprite';
      const isSprite = kind === 'sprite';
      if (isSprite) {
        if (removeBg.dataset.spriteChecked !== undefined) removeBg.checked = removeBg.dataset.spriteChecked === 'true';
      } else {
        removeBg.dataset.spriteChecked = String(removeBg.checked);
        removeBg.checked = false;
      }
      elements.forEach((el) => visible(el, isSprite));
      controls.forEach((el) => { if (el) el.disabled = !isSprite; });
      removeBg.dispatchEvent(new Event('change', { bubbles: true }));
    }

    removeBg.addEventListener('change', () => {
      const kind = document.querySelector('input[name=assetKind]:checked')?.value || 'sprite';
      if (kind === 'sprite') removeBg.dataset.spriteChecked = String(removeBg.checked);
    });
    radios.forEach((r) => r.addEventListener('change', sync));
    sync();
  }

  function inferAssetKindFromCell(cell) {
    if (cell?.assetKind === 'tile' || cell?.assetKind === 'sprite') return cell.assetKind;
    const tag = String(cell?.tag || '');
    if (tag.startsWith('地块：')) return 'tile';
    if (tag.startsWith('非地块：')) return 'sprite';
    return '';
  }

  function setAssetKindRadio(kind) {
    if (kind !== 'tile' && kind !== 'sprite') return;
    const radio = document.querySelector(`input[name=assetKind][value="${kind}"]`);
    if (!radio || radio.checked) return;
    radio.checked = true;
    radio.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function syncAssetKindForSelectedCell() {
    const sheetId = selectedSheetId();
    const index = selectedCellIndex();
    if (!sheetId || index === null) return;
    try {
      const sheet = await rawJson(`/api/sprites/${sheetId}`);
      const cell = sheet.cells?.find?.((c) => Number(c.index) === Number(index));
      const kind = inferAssetKindFromCell(cell);
      if (kind) setAssetKindRadio(kind);
    } catch { /* ignore */ }
  }

  function installAssetKindRestore() {
    if (assetKindRestoreInstalled) return;
    assetKindRestoreInstalled = true;
    document.addEventListener('click', (e) => {
      if (e.target?.closest?.('#grid .cell')) setTimeout(syncAssetKindForSelectedCell, 100);
    });
    document.addEventListener('change', (e) => {
      if (e.target?.id === 'sheetSel') setTimeout(syncAssetKindForSelectedCell, 180);
    });
    setTimeout(syncAssetKindForSelectedCell, 500);
  }

  function isAbortError(e) { return e && (e.name === 'AbortError' || e.code === DOMException.ABORT_ERR); }

  function installGenerationSelectionLock() {
    if (selectionLockInstalled) return;
    selectionLockInstalled = true;

    const wrapSelectCell = () => {
      const fn = window.selectCell;
      if (typeof fn !== 'function' || fn.__generationTargetLocked) return;
      const wrapped = function lockedSelectCell(i, ...rest) {
        const nextIndex = Number(i);
        if (generationTargetIndex !== null && nextIndex !== generationTargetIndex) return;
        return fn.call(this, i, ...rest);
      };
      wrapped.__generationTargetLocked = true;
      wrapped.__original = fn;
      window.selectCell = wrapped;
    };

    wrapSelectCell();
    setTimeout(wrapSelectCell, 0);

    document.addEventListener('mousedown', (e) => {
      if (generationTargetIndex === null) return;
      const cell = e.target?.closest?.('#grid .cell');
      if (!cell) return;
      const nextIndex = Number(cell.dataset.i);
      if (Number.isFinite(nextIndex) && nextIndex !== generationTargetIndex) deferredSelectedIndex = nextIndex;
    }, true);
  }

  function installCancelableGenerationButtons() {
    installGenerationSelectionLock();
    const candidates = [
      { id: 'genBtn', label: '取消生成' },
      { id: 'replaceBtn', label: '取消生成' },
    ];
    const buttons = candidates.map((c) => ({ ...c, el: $(c.id) })).filter((c) => c.el && c.el.onclick && !c.el.dataset.cancelWrapped);
    if (!buttons.length) return;
    const status = $('opStatus') || $('status');

    for (const item of buttons) {
      const btn = item.el;
      const originalClick = btn.onclick;
      const originalText = btn.textContent;
      btn.dataset.cancelWrapped = '1';

      btn.onclick = async (event) => {
        if (activeGeneration) {
          activeGeneration.controller.abort();
          if (status) status.textContent = '正在取消生成…';
          return;
        }

        const controller = new AbortController();
        activeGeneration = { controller, button: btn };
        generationTargetIndex = domSelectedCellIndex();
        deferredSelectedIndex = null;
        btn.textContent = item.label;
        for (const other of buttons) if (other.el !== btn) other.el.disabled = true;

        try {
          await originalClick.call(btn, event);
        } catch (e) {
          if (isAbortError(e)) {
            if (status) status.textContent = '已取消生成';
          } else {
            throw e;
          }
        } finally {
          const pendingSelection = deferredSelectedIndex;
          generationTargetIndex = null;
          deferredSelectedIndex = null;
          if (activeGeneration?.controller === controller) activeGeneration = null;
          btn.textContent = originalText;
          for (const other of buttons) other.el.disabled = false;
          if (pendingSelection !== null && typeof window.selectCell === 'function') setTimeout(() => window.selectCell(pendingSelection), 0);
        }
      };
    }
  }

  function currentRefForPreview() {
    const mode = document.querySelector('input[name=ref]:checked')?.value || 'auto';
    if (mode === 'none') return false;
    if (mode === 'upload') return !!$('refUpload')?.files?.length;
    if (mode === 'sub') return true;
    return null;
  }

  function promptPreviewPayload() {
    const prompt = $('prompt')?.value?.trim() || '';
    const reference = currentRefForPreview();
    if ($('sheetSel') && document.querySelector('input[name=assetKind]')) {
      return {
        kind: 'sprite',
        url: `/api/sprites/${$('sheetSel').value}/prompt-preview`,
        body: { prompt, reference, assetKind: document.querySelector('input[name=assetKind]:checked')?.value || 'sprite' },
      };
    }
    return null;
  }

  function updateManualPromptMeta() {
    const textarea = $('promptPreviewText');
    const meta = $('promptPreviewMeta');
    if (!textarea || !meta) return;
    meta.textContent = `手动编辑中 · 长度 ${textarea.value.trim().length}/1500 · 生成时将发送此框内容`;
  }

  async function refreshPromptPreview({ force = false } = {}) {
    const textarea = $('promptPreviewText');
    const meta = $('promptPreviewMeta');
    if (!textarea || !meta || !currentProjectId) return;
    if (textarea.dataset.manual === '1' && !force) {
      updateManualPromptMeta();
      return;
    }
    const payload = promptPreviewPayload();
    if (!payload || !payload.body.prompt || payload.url.includes('/undefined/')) {
      textarea.value = '';
      textarea.dataset.manual = '0';
      meta.textContent = '填写提示词后显示最终 prompt。';
      return;
    }
    meta.textContent = '刷新中…';
    try {
      const r = await api(payload.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload.body),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || '预览失败');
      textarea.dataset.manual = '0';
      textarea.value = j.prompt || '';
      meta.textContent = `自动生成 · 长度 ${j.promptLength || 0}/1500 · 参考图：${j.hasReference ? j.referenceSource : 'none'} · 可直接修改后生成`;
    } catch (e) {
      textarea.value = '';
      textarea.dataset.manual = '0';
      meta.textContent = '预览失败：' + (e.message || e);
    }
  }

  function schedulePromptPreview({ force = false } = {}) {
    clearTimeout(promptPreviewTimer);
    promptPreviewTimer = setTimeout(() => refreshPromptPreview({ force }), 180);
  }

  function installPromptPreviewPane() {
    if ($('promptPreviewBox') || !$('prompt')) return;
    const anchor = $('opStatus') || $('status') || $('seed') || $('prompt');
    if (!anchor?.parentElement) return;
    const details = document.createElement('details');
    details.id = 'promptPreviewBox';
    details.className = 'prompt-preview-box';
    details.innerHTML = `
      <summary>查看 / 修改本次将发送给 AI 的最终提示词</summary>
      <div class="prompt-preview-actions">
        <button type="button" class="ghost" id="refreshPromptPreviewBtn">按当前参数重新生成提示词</button>
        <span class="muted">修改下方内容后，生成时会直接发送修改后的文本。</span>
      </div>
      <textarea id="promptPreviewText" placeholder="填写提示词后显示最终 prompt；也可以直接在这里编辑要发给 AI 的内容"></textarea>
      <div id="promptPreviewMeta" class="prompt-preview-meta">填写提示词后显示最终 prompt。</div>`;
    anchor.parentElement.insertBefore(details, anchor.nextSibling);

    const textarea = $('promptPreviewText');
    textarea.dataset.manual = '0';
    textarea.addEventListener('input', () => {
      textarea.dataset.manual = '1';
      updateManualPromptMeta();
    });
    $('refreshPromptPreviewBtn').onclick = () => schedulePromptPreview({ force: true });

    const selectors = ['prompt', 'sheetSel', 'refUpload'];
    selectors.forEach((id) => {
      const el = $(id);
      if (el) el.addEventListener('input', schedulePromptPreview);
      if (el) el.addEventListener('change', schedulePromptPreview);
    });
    document.querySelectorAll('input[name=assetKind],input[name=ref]').forEach((el) => el.addEventListener('change', schedulePromptPreview));
    document.addEventListener('click', (e) => {
      if (e.target?.closest?.('#subPick')) schedulePromptPreview();
    });
    details.addEventListener('toggle', () => { if (details.open) refreshPromptPreview(); });
    schedulePromptPreview();
  }

  function selectedSheetId() { return $('sheetSel')?.value || ''; }
  function selectedCellIndex() { return domSelectedCellIndex(); }

  function pixelEditorState() {
    const canvas = $('pixelEditorCanvas');
    return canvas ? { canvas, ctx: canvas.getContext('2d') } : null;
  }

  function setPixelMeta(text) { if ($('pixelEditorMeta')) $('pixelEditorMeta').textContent = text; }
  function setCopyMeta(text) { if ($('cellCopyMeta')) $('cellCopyMeta').textContent = text; }

  async function loadSelectedPixelCell() {
    const sheetId = selectedSheetId();
    const index = selectedCellIndex();
    const st = pixelEditorState();
    if (!st || !sheetId || index === null) { setPixelMeta('请先选择一个有图片的格子。'); return; }
    const sheet = await rawJson(`/api/sprites/${sheetId}`);
    const size = Number(sheet.cellSize) || 32;
    const cell = sheet.cells?.find?.((c) => Number(c.index) === Number(index));
    if (!cell?.imageRef) { st.canvas.width = size; st.canvas.height = size; st.ctx.clearRect(0, 0, size, size); setPixelMeta(`格子 ${index} 没有图片。`); return; }
    const img = await loadImageFromBlobUrl(withProject(`/api/sprites/${sheetId}/cells/${index}?t=${Date.now()}`));
    st.canvas.width = size;
    st.canvas.height = size;
    st.ctx.imageSmoothingEnabled = false;
    st.ctx.clearRect(0, 0, size, size);
    st.ctx.drawImage(img, 0, 0, size, size);
    st.canvas.dataset.sheetId = sheetId;
    st.canvas.dataset.index = String(index);
    st.canvas.dataset.tag = cell.tag || '';
    setPixelMeta(`已载入：格子 ${index} · ${size}×${size}。点击或拖动即可改单个像素。`);
  }

  function hexToRgb(hex) {
    const n = parseInt(String(hex || '#000000').replace('#', ''), 16) || 0;
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  function paintPixelFromEvent(e) {
    const st = pixelEditorState();
    if (!st || !st.canvas.width) return;
    const rect = st.canvas.getBoundingClientRect();
    const x = Math.floor((e.clientX - rect.left) / rect.width * st.canvas.width);
    const y = Math.floor((e.clientY - rect.top) / rect.height * st.canvas.height);
    if (x < 0 || y < 0 || x >= st.canvas.width || y >= st.canvas.height) return;
    const transparent = $('pixelTransparent')?.checked;
    const rgb = hexToRgb($('pixelColor')?.value || '#000000');
    const alpha = transparent ? 0 : Math.max(0, Math.min(255, Number($('pixelAlpha')?.value || 255)));
    const img = st.ctx.getImageData(x, y, 1, 1);
    img.data[0] = rgb.r; img.data[1] = rgb.g; img.data[2] = rgb.b; img.data[3] = alpha;
    st.ctx.putImageData(img, x, y);
    const sw = $('pixelCurrentSwatch');
    if (sw) sw.style.background = alpha ? `rgba(${rgb.r},${rgb.g},${rgb.b},${alpha / 255})` : 'transparent';
    setPixelMeta(`像素 (${x}, ${y}) = rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`);
  }

  function pickPixelFromEvent(e) {
    const st = pixelEditorState();
    if (!st || !st.canvas.width) return;
    const rect = st.canvas.getBoundingClientRect();
    const x = Math.floor((e.clientX - rect.left) / rect.width * st.canvas.width);
    const y = Math.floor((e.clientY - rect.top) / rect.height * st.canvas.height);
    if (x < 0 || y < 0 || x >= st.canvas.width || y >= st.canvas.height) return;
    const d = st.ctx.getImageData(x, y, 1, 1).data;
    $('pixelColor').value = '#' + [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, '0')).join('');
    $('pixelAlpha').value = String(d[3]);
    $('pixelTransparent').checked = d[3] === 0;
    setPixelMeta(`已吸取像素 (${x}, ${y}) = rgba(${d[0]}, ${d[1]}, ${d[2]}, ${d[3]})`);
  }

  async function savePixelEditorCell() {
    const st = pixelEditorState();
    const sheetId = st?.canvas?.dataset?.sheetId;
    const index = st?.canvas?.dataset?.index;
    if (!st || !sheetId || index === undefined) { setPixelMeta('没有可保存的像素图。'); return; }
    const tag = $('tagEdit')?.value ?? st.canvas.dataset.tag ?? '';
    const r = await api(`/api/sprites/${sheetId}/cells/${index}/image`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: canvasToBase64(st.canvas), tag }),
    });
    const j = await r.json();
    if (!j.ok) { setPixelMeta('保存失败：' + (j.error || '')); return; }
    setPixelMeta(`已保存格子 ${index} 的像素修改。`);
    const img = document.querySelector(`#grid .cell.selected img`);
    if (img) img.src = withProject(`/api/sprites/${sheetId}/cells/${index}?t=${Date.now()}`);
    if ($('opStatus')) $('opStatus').textContent = '像素修改已保存';
  }

  function installPixelEditor() {
    if ($('pixelEditorBox') || !$('grid') || !$('tagEdit')) return;
    const card = $('tagEdit').closest('.card') || $('grid').closest('.card');
    if (!card) return;
    const box = document.createElement('details');
    box.id = 'pixelEditorBox';
    box.className = 'pixel-editor-box';
    box.innerHTML = `
      <summary>像素编辑器 / 生成后尺寸修正</summary>
      <p class="muted">生成到单格后会自动重采样为当前精灵图 cellSize×cellSize。这里可对选中格逐像素二次编辑，支持透明像素。</p>
      <div class="pixel-editor-tools">
        <button type="button" class="ghost" id="loadPixelBtn">载入选中格</button>
        <button type="button" class="ghost" id="savePixelBtn">保存像素修改</button>
        <label style="margin:0;display:flex;align-items:center;gap:6px">颜色 <input id="pixelColor" type="color" value="#000000"></label>
        <label style="margin:0;display:flex;align-items:center;gap:6px">Alpha <input id="pixelAlpha" type="number" min="0" max="255" value="255"></label>
        <label style="margin:0"><input id="pixelTransparent" type="checkbox" style="width:auto;margin-right:6px">透明</label>
        <span class="muted"><span id="pixelCurrentSwatch" class="pixel-editor-swatch"></span>左键画，右键吸色</span>
      </div>
      <div class="pixel-editor-stage">
        <canvas id="pixelEditorCanvas" class="pixel-editor-canvas" width="32" height="32"></canvas>
        <div class="pixel-editor-meta" id="pixelEditorMeta">选择一个有图片的格子后点击“载入选中格”。</div>
      </div>`;
    card.appendChild(box);

    let painting = false;
    const canvas = $('pixelEditorCanvas');
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('mousedown', (e) => {
      e.preventDefault();
      if (e.button === 2) { pickPixelFromEvent(e); return; }
      painting = true;
      paintPixelFromEvent(e);
    });
    canvas.addEventListener('mousemove', (e) => { if (painting) paintPixelFromEvent(e); });
    document.addEventListener('mouseup', () => { painting = false; });
    $('loadPixelBtn').onclick = loadSelectedPixelCell;
    $('savePixelBtn').onclick = savePixelEditorCell;
    document.addEventListener('click', (e) => {
      if (e.target?.closest?.('#grid .cell')) setTimeout(() => { if ($('pixelEditorBox')?.open) loadSelectedPixelCell(); }, 80);
    });
    box.addEventListener('toggle', () => { if (box.open) loadSelectedPixelCell(); });
  }

  function parseCellTargets(text, maxIndex) {
    const out = new Set();
    String(text || '').split(/[，,\s]+/).forEach((part) => {
      if (!part) return;
      const range = /^(\d+)\s*-\s*(\d+)$/.exec(part);
      if (range) {
        const a = Number(range[1]), b = Number(range[2]);
        const start = Math.min(a, b), end = Math.max(a, b);
        for (let i = start; i <= end; i++) if (i >= 0 && i <= maxIndex) out.add(i);
        return;
      }
      const n = Number(part);
      if (Number.isInteger(n) && n >= 0 && n <= maxIndex) out.add(n);
    });
    return [...out];
  }

  function regionTargetIndices(sourceIndex) {
    return [...document.querySelectorAll('#grid .cell.region')]
      .map((el) => Number(el.dataset.i))
      .filter((i) => Number.isInteger(i) && i !== sourceIndex);
  }

  async function sourceCellImageBase64(sheetId, sourceIndex) {
    const r = await fetch(withProject(`/api/sprites/${sheetId}/cells/${sourceIndex}?t=${Date.now()}`), { cache: 'no-store' });
    if (!r.ok) throw new Error('源格没有可复制的图片');
    return blobToBase64(await r.blob());
  }

  function numberedTag(baseTag, n, total) {
    const clean = String(baseTag || '').replace(/\s*\(\d+\/\d+\)\s*$/, '');
    return total > 1 ? `${clean}(${n}/${total})` : clean;
  }

  async function copySelectedCellToTargets(mode) {
    const sheetId = selectedSheetId();
    const sourceIndex = selectedCellIndex();
    if (!sheetId || sourceIndex === null) { setCopyMeta('请先选择一个有图片的源格。'); return; }
    const sheet = await rawJson(`/api/sprites/${sheetId}`);
    const sourceCell = sheet.cells?.find?.((c) => Number(c.index) === Number(sourceIndex));
    if (!sourceCell?.imageRef) { setCopyMeta(`源格 ${sourceIndex} 没有图片。`); return; }

    let targets = [];
    if (mode === 'empty') {
      targets = sheet.cells.filter((c) => !c.imageRef && Number(c.index) !== Number(sourceIndex)).map((c) => Number(c.index));
    } else {
      const maxIndex = Math.max(...sheet.cells.map((c) => Number(c.index)));
      targets = parseCellTargets($('copyTargetCells')?.value || '', maxIndex);
      if (!targets.length) targets = regionTargetIndices(sourceIndex);
      targets = targets.filter((i) => i !== sourceIndex && sheet.cells.some((c) => Number(c.index) === i));
    }
    targets = [...new Set(targets)];
    if (!targets.length) { setCopyMeta('没有目标格。可拖选区域，或输入如 1,2,5-8。'); return; }

    const image = await sourceCellImageBase64(sheetId, sourceIndex);
    const autoNumber = $('copyNumberTags')?.checked !== false;
    setCopyMeta(`正在复制格子 ${sourceIndex} 到 ${targets.length} 个目标格…`);
    for (let i = 0; i < targets.length; i++) {
      const tag = autoNumber ? numberedTag(sourceCell.tag || '', i + 1, targets.length) : (sourceCell.tag || '');
      const r = await api(`/api/sprites/${sheetId}/cells/${targets[i]}/image`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image, tag }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || `复制到格子 ${targets[i]} 失败`);
    }
    setCopyMeta(`完成 ✓ 已复制到：${targets.join(', ')}`);
    if ($('opStatus')) $('opStatus').textContent = `已复制图块内容到 ${targets.length} 个格子`;
    $('refreshBtn')?.click?.();
  }

  function installCellCopyTools() {
    if ($('cellCopyBox') || !$('grid') || !$('tagEdit')) return;
    const card = $('tagEdit').closest('.card') || $('grid').closest('.card');
    if (!card) return;
    const box = document.createElement('details');
    box.id = 'cellCopyBox';
    box.className = 'cell-copy-box';
    box.innerHTML = `
      <summary>自动复制图块内容到其他格</summary>
      <p class="muted">选择一个已有图片的源格后，可拖选目标区域，或输入目标格号，把源格图片复制到其他格子。适合重复地块、同款装饰、批量占位。</p>
      <div class="cell-copy-tools">
        <input id="copyTargetCells" type="text" placeholder="目标格号：如 1,2,5-8；留空则使用拖选区域" />
        <button type="button" class="ghost" id="copyToTargetsBtn">复制到目标</button>
        <button type="button" class="ghost" id="copyToEmptyBtn">复制到所有空格</button>
        <label style="margin:0"><input id="copyNumberTags" type="checkbox" checked style="width:auto;margin-right:6px">Tag 自动编号</label>
      </div>
      <div id="cellCopyMeta" class="cell-copy-meta">源格=当前选中格；目标=输入格号或拖选区域。</div>`;
    card.appendChild(box);
    $('copyToTargetsBtn').onclick = async () => { try { await copySelectedCellToTargets('targets'); } catch (e) { setCopyMeta('复制失败：' + (e.message || e)); } };
    $('copyToEmptyBtn').onclick = async () => { try { await copySelectedCellToTargets('empty'); } catch (e) { setCopyMeta('复制失败：' + (e.message || e)); } };
  }

  async function init({ requireProject = true } = {}) {
    injectStyle();
    const list = await loadProjects();
    if (!list.length) {
      if (requireProject) showCreateOverlay();
      return '';
    }
    const saved = localStorage.getItem(KEY);
    currentProjectId = list.some((p) => p.id === saved) ? saved : list[0].id;
    localStorage.setItem(KEY, currentProjectId);
    renderBar();
    schedulePromptPreview();
    return currentProjectId;
  }

  document.addEventListener('DOMContentLoaded', () => {
    installSpriteBackgroundKindGuard();
    installAssetKindRestore();
    installCancelableGenerationButtons();
    installPromptPreviewPane();
    installPixelEditor();
    installCellCopyTools();
  });

  window.Project = {
    init,
    id: () => currentProjectId,
    projects: () => projectsCache,
    withProject,
    fetch: api,
  };
})();