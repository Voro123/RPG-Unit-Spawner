(() => {
  const BG_SETTINGS_KEY = 'rpg-unit-spawner.cellBgSettings.v1';
  const SESSION_PREVIEW_CACHE = window.__RpgCellPreviewCache || (window.__RpgCellPreviewCache = new Map());
  const DIRTY_PIXEL_CACHE = window.__RpgDirtyPixelCache || (window.__RpgDirtyPixelCache = new Map());
  const restoringKeys = new Set();
  let activeScope = { sheetId: '', indexes: new Set(), until: 0, version: 0 };
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

  function readAllBgSettings() {
    try { return JSON.parse(localStorage.getItem(BG_SETTINGS_KEY) || '{}') || {}; }
    catch { return {}; }
  }

  function selectedIndexes() {
    const region = Array.from(document.querySelectorAll('#grid .cell.region'));
    const targets = region.length ? region : Array.from(document.querySelectorAll('#grid .cell.selected'));
    return targets.map((el) => Number(el.dataset.i)).filter((v) => Number.isInteger(v));
  }

  function currentSheetId() {
    return $('sheetSel')?.value || '';
  }

  function markActiveScope(duration = 1400) {
    const sheetId = currentSheetId();
    activeScope = {
      sheetId,
      indexes: new Set(selectedIndexes()),
      until: Date.now() + duration,
      version: activeScope.version + 1,
    };
    return activeScope.version;
  }

  function isInActiveScope(sheetId, index) {
    return Date.now() <= activeScope.until && sheetId === activeScope.sheetId && activeScope.indexes.has(Number(index));
  }

  function hexToRgb(hex) {
    const n = parseInt(String(hex || '#000000').replace('#', ''), 16) || 0;
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  function edgeColorToTransparent(canvas, color, tolerance) {
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

  async function fetchSheet(sheetId) {
    const key = `${projectId()}:${sheetId}`;
    if (metaCache.has(key)) return metaCache.get(key);
    const r = await fetch(withProject(`/api/sprites/${sheetId}`), { cache: 'no-store', headers: projectId() ? { 'x-project-id': projectId() } : {} });
    const meta = await r.json();
    metaCache.set(key, meta);
    return meta;
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

  function setThumbnailSrc(index, src) {
    const cellEl = document.querySelector(`#grid .cell[data-i="${index}"]`);
    if (!cellEl) return;
    let img = cellEl.querySelector('img');
    if (!img) {
      img = document.createElement('img');
      img.alt = '';
      const idx = cellEl.querySelector('.idx');
      if (idx?.nextSibling) cellEl.insertBefore(img, idx.nextSibling);
      else cellEl.appendChild(img);
    }
    img.style.visibility = '';
    img.src = src;
  }

  async function correctPreviewForCell(sheetId, index, version) {
    const key = cellKey(sheetId, index);
    if (restoringKeys.has(key)) return;
    restoringKeys.add(key);
    try {
      const dirty = DIRTY_PIXEL_CACHE.get(key);
      if (dirty) {
        SESSION_PREVIEW_CACHE.set(key, dirty);
        setThumbnailSrc(index, dirty);
        return;
      }

      const settings = readAllBgSettings()[key];
      const sheet = await fetchSheet(sheetId);
      const cell = sheet.cells?.find?.((c) => Number(c.index) === Number(index));
      if (!cell?.imageRef) return;

      if (!settings?.removeBg) {
        SESSION_PREVIEW_CACHE.delete(key);
        setThumbnailSrc(index, withProject(`/api/sprites/${sheetId}/cells/${index}?t=${Date.now()}`));
        return;
      }

      const img = await loadImage(withProject(`/api/sprites/${sheetId}/cells/${index}?t=${Date.now()}`));
      if (version !== activeScope.version && isInActiveScope(sheetId, index)) return;
      const size = Math.max(1, Number(sheet.cellSize) || 32);
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, 0, 0, size, size);
      edgeColorToTransparent(canvas, hexToRgb(settings.bgColor || '#ffffff'), Math.max(0, Math.min(255, Number(settings.bgTolerance || 24))));
      const dataUrl = canvas.toDataURL('image/png');
      SESSION_PREVIEW_CACHE.set(key, dataUrl);
      setThumbnailSrc(index, dataUrl);
    } catch { /* ignore guard restore failures */ }
    finally {
      setTimeout(() => restoringKeys.delete(key), 30);
    }
  }

  function maybeGuardMutation(target) {
    const img = target?.tagName === 'IMG' ? target : null;
    if (!img || restoringKeys.size) return;
    const cellEl = img.closest?.('#grid .cell');
    if (!cellEl) return;
    const sheetId = currentSheetId();
    const index = Number(cellEl.dataset.i);
    if (!sheetId || !Number.isInteger(index)) return;
    if (isInActiveScope(sheetId, index)) return;
    if (!String(img.src || '').startsWith('data:image/')) return;
    const version = activeScope.version;
    setTimeout(() => correctPreviewForCell(sheetId, index, version), 0);
  }

  function install() {
    const grid = $('grid');
    if (!grid || grid.dataset.thumbnailScopeGuard === '1') return false;
    grid.dataset.thumbnailScopeGuard = '1';

    ['bgTolerance', 'bgColor', 'removeBg'].forEach((id) => {
      document.addEventListener(id === 'removeBg' ? 'change' : 'input', (e) => {
        if (e.target?.id === id) markActiveScope();
      }, true);
      if (id !== 'removeBg') {
        document.addEventListener('change', (e) => {
          if (e.target?.id === id) markActiveScope();
        }, true);
      }
    });

    document.addEventListener('click', (e) => {
      if (e.target?.closest?.('#grid .cell')) markActiveScope(800);
    }, true);
    document.addEventListener('contextmenu', (e) => {
      if (e.target?.closest?.('#grid .cell')) markActiveScope(800);
    }, true);
    document.addEventListener('mouseup', (e) => {
      if (e.target?.closest?.('#grid')) markActiveScope(900);
    }, true);
    document.addEventListener('change', (e) => {
      if (e.target?.id === 'sheetSel') {
        metaCache = new Map();
        markActiveScope(900);
      }
    }, true);

    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === 'attributes' && m.attributeName === 'src') maybeGuardMutation(m.target);
        if (m.type === 'childList') {
          m.addedNodes.forEach((node) => {
            if (node.nodeType !== 1) return;
            if (node.tagName === 'IMG') maybeGuardMutation(node);
            node.querySelectorAll?.('img').forEach(maybeGuardMutation);
          });
        }
      }
    });
    observer.observe(grid, { subtree: true, childList: true, attributes: true, attributeFilter: ['src'] });
    markActiveScope(900);
    return true;
  }

  function boot() {
    if (install()) return;
    setTimeout(boot, 120);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
