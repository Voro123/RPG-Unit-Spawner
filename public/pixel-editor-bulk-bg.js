(() => {
  let installed = false;
  let paintActive = false;
  let loadTimer = null;
  const state = {
    sheetId: '',
    loadedKey: '',
    size: 32,
    items: [],
  };

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

  async function fetchJson(url, opt = {}) {
    const headers = { ...(opt.headers || {}) };
    const pid = projectId();
    if (pid) headers['x-project-id'] = pid;
    const useUrl = !opt.method || ['GET', 'HEAD'].includes(String(opt.method).toUpperCase()) ? withProject(url) : url;
    const r = await fetch(useUrl, { ...opt, headers });
    return r.json();
  }

  async function loadImage(url) {
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

  function canvasToBase64(canvas) {
    return canvas.toDataURL('image/png').split(',')[1];
  }

  function cloneCanvas(source) {
    const c = document.createElement('canvas');
    c.width = source.width;
    c.height = source.height;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.drawImage(source, 0, 0);
    return c;
  }

  function createBlankCanvas(size) {
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    return c;
  }

  function hexToRgb(hex) {
    const n = parseInt(String(hex || '#000000').replace('#', ''), 16) || 0;
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  function selectedBgColor() {
    return hexToRgb($('bgColor')?.value || '#ffffff');
  }

  function bgTolerance() {
    return Math.max(0, Math.min(255, Number($('bgTolerance')?.value || 24)));
  }

  function shouldRemoveBg() {
    return !!$('removeBg')?.checked;
  }

  function selectedIndexes() {
    const region = Array.from(document.querySelectorAll('#grid .cell.region'));
    const targets = region.length ? region : Array.from(document.querySelectorAll('#grid .cell.selected'));
    return targets.map((el) => Number(el.dataset.i)).filter((v) => Number.isInteger(v));
  }

  function selectionKey() {
    const sheetId = $('sheetSel')?.value || '';
    const indexes = selectedIndexes();
    return `${sheetId}:${indexes.join(',')}`;
  }

  function setMeta(text) {
    if ($('pixelEditorMeta')) $('pixelEditorMeta').textContent = text;
  }

  function syncSwatch() {
    const sw = $('pixelCurrentSwatch');
    if (!sw) return;
    const transparent = !!$('pixelTransparent')?.checked;
    const rgb = hexToRgb($('pixelColor')?.value || '#000000');
    const alpha = transparent ? 0 : Math.max(0, Math.min(255, Number($('pixelAlpha')?.value || 255)));
    sw.style.background = alpha ? `rgba(${rgb.r},${rgb.g},${rgb.b},${alpha / 255})` : 'transparent';
  }

  function edgeColorToTransparent(canvas, color = selectedBgColor(), tolerance = bgTolerance()) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    const imageData = ctx.getImageData(0, 0, w, h);
    const data = imageData.data;
    const seen = new Uint8Array(w * h);
    const stack = [];
    const isTransparent = (p) => data[p * 4 + 3] <= 8;
    const isBg = (p) => {
      const i = p * 4;
      return data[i + 3] > 8
        && Math.abs(data[i] - color.r) <= tolerance
        && Math.abs(data[i + 1] - color.g) <= tolerance
        && Math.abs(data[i + 2] - color.b) <= tolerance;
    };
    const isPassable = (p) => isTransparent(p) || isBg(p);
    const push = (x, y) => {
      if (x < 0 || y < 0 || x >= w || y >= h) return;
      const p = y * w + x;
      if (seen[p] || !isPassable(p)) return;
      seen[p] = 1;
      stack.push(p);
    };
    for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
    for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y); }
    while (stack.length) {
      const p = stack.pop();
      if (isBg(p)) data[p * 4 + 3] = 0;
      const x = p % w, y = Math.floor(p / w);
      push(x + 1, y); push(x - 1, y); push(x, y + 1); push(x, y - 1);
    }
    ctx.putImageData(imageData, 0, 0);
  }

  function renderDisplayCanvas() {
    const canvas = $('pixelEditorCanvas');
    if (!canvas) return;
    const size = Math.max(1, state.size || 32);
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, size, size);
    const item = state.items[0];
    if (item?.currentCanvas) ctx.drawImage(item.currentCanvas, 0, 0);
  }

  function updateMetaLoaded() {
    if (!state.items.length) {
      setMeta('请选择一个或多个格子后载入。');
      return;
    }
    const indexes = state.items.map((item) => item.index);
    if (state.items.length === 1) {
      setMeta(`已载入：格子 ${indexes[0]} · ${state.size}×${state.size}。相近色调整会直接反映到像素编辑器；左键绘制，右键吸色。`);
      return;
    }
    setMeta(`已载入 ${state.items.length} 个格子：${indexes.join(', ')} · ${state.size}×${state.size}。当前画布显示第一个格子，像素编辑与相近色调整会同时作用到全部选中格子。`);
  }

  function reapplyBgPreviewToEditor() {
    if (!state.items.length) return;
    for (const item of state.items) {
      item.currentCanvas = cloneCanvas(item.baseCanvas);
      if (shouldRemoveBg()) edgeColorToTransparent(item.currentCanvas, selectedBgColor(), bgTolerance());
    }
    renderDisplayCanvas();
    updateMetaLoaded();
  }

  async function loadSelectedPixelTargets(force = false) {
    const sheetId = $('sheetSel')?.value || '';
    const indexes = selectedIndexes();
    const key = `${sheetId}:${indexes.join(',')}`;
    const box = $('pixelEditorBox');
    if (!box || !box.open) return;
    if (!sheetId || !indexes.length) {
      state.loadedKey = '';
      state.items = [];
      renderDisplayCanvas();
      setMeta('请先选择一个或多个格子。');
      return;
    }
    if (!force && key === state.loadedKey) return;
    setMeta('载入中…');
    const sheet = await fetchJson(`/api/sprites/${sheetId}`);
    const size = Math.max(1, Number(sheet.cellSize) || 32);
    const items = [];
    for (const index of indexes) {
      const cell = sheet.cells?.find?.((c) => Number(c.index) === Number(index)) || { index, tag: '', imageRef: null };
      const baseCanvas = createBlankCanvas(size);
      const ctx = baseCanvas.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      if (cell?.imageRef) {
        const img = await loadImage(withProject(`/api/sprites/${sheetId}/cells/${index}?t=${Date.now()}`));
        ctx.clearRect(0, 0, size, size);
        ctx.drawImage(img, 0, 0, size, size);
      }
      const currentCanvas = cloneCanvas(baseCanvas);
      if (shouldRemoveBg()) edgeColorToTransparent(currentCanvas, selectedBgColor(), bgTolerance());
      items.push({ sheetId, index, tag: cell.tag || '', baseCanvas, currentCanvas });
    }
    state.sheetId = sheetId;
    state.size = size;
    state.items = items;
    state.loadedKey = key;
    renderDisplayCanvas();
    updateMetaLoaded();
  }

  function editorCoordsFromEvent(e) {
    const canvas = $('pixelEditorCanvas');
    if (!canvas || !canvas.width) return null;
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor((e.clientX - rect.left) / rect.width * canvas.width);
    const y = Math.floor((e.clientY - rect.top) / rect.height * canvas.height);
    if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return null;
    return { x, y };
  }

  function paintPixel(x, y) {
    if (!state.items.length) return;
    const transparent = !!$('pixelTransparent')?.checked;
    const rgb = hexToRgb($('pixelColor')?.value || '#000000');
    const alpha = transparent ? 0 : Math.max(0, Math.min(255, Number($('pixelAlpha')?.value || 255)));
    for (const item of state.items) {
      [item.baseCanvas, item.currentCanvas].forEach((canvas) => {
        const ctx = canvas.getContext('2d');
        const img = ctx.getImageData(x, y, 1, 1);
        img.data[0] = rgb.r;
        img.data[1] = rgb.g;
        img.data[2] = rgb.b;
        img.data[3] = alpha;
        ctx.putImageData(img, x, y);
      });
    }
    renderDisplayCanvas();
    syncSwatch();
    setMeta(`已修改 ${state.items.length} 个格子的像素 (${x}, ${y}) = rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`);
  }

  function pickPixel(x, y) {
    const item = state.items[0];
    if (!item?.currentCanvas) return;
    const d = item.currentCanvas.getContext('2d').getImageData(x, y, 1, 1).data;
    $('pixelColor').value = '#' + [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, '0')).join('');
    $('pixelAlpha').value = String(d[3]);
    $('pixelTransparent').checked = d[3] === 0;
    syncSwatch();
    setMeta(`已吸取像素 (${x}, ${y}) = rgba(${d[0]}, ${d[1]}, ${d[2]}, ${d[3]})`);
  }

  function updateGridCellPreview(index, dataUrl) {
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
    img.src = dataUrl;
  }

  async function saveSelectedPixelTargets() {
    if (!state.items.length) {
      setMeta('没有可保存的像素图。');
      return;
    }
    setMeta(`保存中…（${state.items.length} 个格子）`);
    for (const item of state.items) {
      const tag = state.items.length === 1 ? ($('tagEdit')?.value ?? item.tag) : item.tag;
      const r = await fetch(`/api/sprites/${item.sheetId}/cells/${item.index}/image`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          ...(projectId() ? { 'x-project-id': projectId() } : {}),
        },
        body: JSON.stringify({ image: canvasToBase64(item.currentCanvas), tag, projectId: projectId() }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || `保存格子 ${item.index} 失败`);
      item.tag = tag;
      item.baseCanvas = cloneCanvas(item.currentCanvas);
      updateGridCellPreview(item.index, item.currentCanvas.toDataURL('image/png'));
    }
    state.loadedKey = selectionKey();
    updateMetaLoaded();
    if ($('opStatus')) $('opStatus').textContent = `像素修改已保存（${state.items.length} 个格子）`;
  }

  function replacePixelCanvasAndBind() {
    const oldCanvas = $('pixelEditorCanvas');
    if (!oldCanvas || oldCanvas.dataset.bulkEditorBound === '1') return;
    const canvas = oldCanvas.cloneNode(false);
    canvas.id = oldCanvas.id;
    canvas.className = oldCanvas.className;
    canvas.width = oldCanvas.width;
    canvas.height = oldCanvas.height;
    canvas.dataset.bulkEditorBound = '1';
    oldCanvas.parentNode.replaceChild(canvas, oldCanvas);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const pos = editorCoordsFromEvent(e);
      if (!pos) return;
      if (e.button === 2) {
        pickPixel(pos.x, pos.y);
        return;
      }
      paintActive = true;
      paintPixel(pos.x, pos.y);
    });
    canvas.addEventListener('mousemove', (e) => {
      if (!paintActive) return;
      const pos = editorCoordsFromEvent(e);
      if (!pos) return;
      paintPixel(pos.x, pos.y);
    });
    document.addEventListener('mouseup', () => { paintActive = false; });
  }

  function moveBgControlsIntoEditor() {
    const box = $('pixelEditorBox');
    const removeBg = $('removeBg');
    const bgToleranceEl = $('bgTolerance');
    if (!box || !removeBg || !bgToleranceEl) return false;
    let wrapper = $('pixelEditorBgControls');
    if (!wrapper) {
      wrapper = document.createElement('div');
      wrapper.id = 'pixelEditorBgControls';
      wrapper.className = 'pixel-editor-bg-controls';
      wrapper.innerHTML = '<div style="font-weight:700;margin:8px 0 6px">相近色调整</div><p class="muted" style="margin-top:0">这里的相近色设置会直接同步到像素编辑器当前显示内容；若框选多个格子，将同时作用到全部选中格子。</p>';
      const stage = box.querySelector('.pixel-editor-stage');
      box.insertBefore(wrapper, stage || box.lastChild);
    }
    const removeRow = removeBg.closest('.row');
    const bgTitle = removeRow?.previousElementSibling;
    const toleranceLabel = bgToleranceEl.previousElementSibling;
    const previewRow = $('bgPreview')?.closest('.row');
    const note = previewRow?.nextElementSibling;
    [bgTitle, removeRow, toleranceLabel, bgToleranceEl, previewRow, note].forEach((node) => {
      if (node && node.parentElement !== wrapper) wrapper.appendChild(node);
    });
    return true;
  }

  function scheduleLoad(force = false) {
    clearTimeout(loadTimer);
    loadTimer = setTimeout(() => loadSelectedPixelTargets(force).catch((e) => setMeta(e.message || String(e))), 120);
  }

  function overrideButtons() {
    if ($('loadPixelBtn')) $('loadPixelBtn').onclick = () => loadSelectedPixelTargets(true).catch((e) => setMeta(e.message || String(e)));
    if ($('savePixelBtn')) $('savePixelBtn').onclick = () => saveSelectedPixelTargets().catch((e) => setMeta('保存失败：' + (e.message || e)));
  }

  function bindEditorSync() {
    const box = $('pixelEditorBox');
    if (!box || box.dataset.bulkEditorSyncBound === '1') return;
    box.dataset.bulkEditorSyncBound = '1';

    document.addEventListener('click', (e) => {
      if (e.target?.closest?.('#grid .cell')) scheduleLoad(true);
    }, true);
    document.addEventListener('contextmenu', (e) => {
      if (e.target?.closest?.('#grid .cell')) scheduleLoad(true);
    }, true);
    document.addEventListener('mouseup', () => {
      if (document.querySelector('#grid .cell.region')) scheduleLoad(true);
    }, true);
    document.addEventListener('change', (e) => {
      if (e.target?.id === 'sheetSel') {
        state.loadedKey = '';
        scheduleLoad(true);
      }
    }, true);

    ['bgTolerance', 'bgColor', 'removeBg'].forEach((id) => {
      const el = $(id);
      if (!el || el.dataset.editorPreviewBound === '1') return;
      el.dataset.editorPreviewBound = '1';
      const eventName = id === 'removeBg' ? 'change' : 'input';
      el.addEventListener(eventName, () => reapplyBgPreviewToEditor());
      if (eventName !== 'change') el.addEventListener('change', () => reapplyBgPreviewToEditor());
    });

    ['pixelColor', 'pixelAlpha', 'pixelTransparent'].forEach((id) => {
      const el = $(id);
      if (!el || el.dataset.editorSwatchBound === '1') return;
      el.dataset.editorSwatchBound = '1';
      el.addEventListener('input', syncSwatch);
      el.addEventListener('change', syncSwatch);
    });
    $('applyBgBtn')?.addEventListener('click', () => setTimeout(() => scheduleLoad(true), 220));
    box.addEventListener('toggle', () => { if (box.open) scheduleLoad(true); });
  }

  function install() {
    if (installed) return true;
    const box = $('pixelEditorBox');
    if (!box || !$('pixelEditorCanvas') || !$('bgTolerance') || !$('loadPixelBtn') || !$('savePixelBtn')) return false;
    installed = true;
    moveBgControlsIntoEditor();
    replacePixelCanvasAndBind();
    overrideButtons();
    bindEditorSync();
    syncSwatch();
    box.open = true;
    scheduleLoad(true);
    return true;
  }

  function boot() {
    if (install()) return;
    setTimeout(boot, 120);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
