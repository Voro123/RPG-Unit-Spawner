(() => {
  const SESSION_PREVIEW_CACHE = window.__RpgCellPreviewCache || (window.__RpgCellPreviewCache = new Map());
  const DIRTY_PIXEL_CACHE = window.__RpgDirtyPixelCache || (window.__RpgDirtyPixelCache = new Map());
  const REFRESH_DELAYS = [0, 80, 180, 360, 720, 1200, 2000, 3200];
  const CLEAR_DELAYS = [0, 60, 180, 420, 900, 1600];
  const activeRefreshes = new Map();
  let installed = false;

  function $(id) { return document.getElementById(id); }

  function projectId() {
    return localStorage.getItem('rpg-unit-spawner.projectId') || '';
  }

  function cellKey(sheetId, index) {
    return `${projectId() || 'default'}:${sheetId}:${index}`;
  }

  function currentSheetId() {
    return $('sheetSel')?.value || '';
  }

  function selectedIndex() {
    const el = document.querySelector('#grid .cell.selected');
    return el ? Number(el.dataset.i) : null;
  }

  function cellImageUrl(sheetId, index) {
    const pid = projectId();
    const base = `/api/sprites/${sheetId}/cells/${index}?t=${Date.now()}`;
    return pid ? `${base}&projectId=${encodeURIComponent(pid)}` : base;
  }

  function parseCellGenerateUrl(input) {
    const raw = typeof input === 'string' ? input : input?.url || '';
    if (!raw) return null;
    const path = raw.startsWith('http') ? new URL(raw).pathname : raw.split('?')[0];
    const m = path.match(/\/api\/sprites\/([^/]+)\/cells\/(\d+)\/(generate|replace)$/);
    if (!m) return null;
    return { sheetId: decodeURIComponent(m[1]), index: Number(m[2]), action: m[3], kind: 'generate' };
  }

  function parseCellImageWriteUrl(input) {
    const raw = typeof input === 'string' ? input : input?.url || '';
    if (!raw) return null;
    const path = raw.startsWith('http') ? new URL(raw).pathname : raw.split('?')[0];
    const m = path.match(/\/api\/sprites\/([^/]+)\/cells\/(\d+)\/image$/);
    if (!m) return null;
    return { sheetId: decodeURIComponent(m[1]), index: Number(m[2]), action: 'image', kind: 'write' };
  }

  function parseCellDeleteUrl(input) {
    const raw = typeof input === 'string' ? input : input?.url || '';
    if (!raw) return null;
    const path = raw.startsWith('http') ? new URL(raw).pathname : raw.split('?')[0];
    const m = path.match(/\/api\/sprites\/([^/]+)\/cells\/(\d+)$/);
    if (!m) return null;
    return { sheetId: decodeURIComponent(m[1]), index: Number(m[2]), action: 'delete', kind: 'delete' };
  }

  function parseChangedCellUrl(input, method) {
    if (method === 'POST') return parseCellGenerateUrl(input);
    if (method === 'PUT') return parseCellImageWriteUrl(input);
    if (method === 'DELETE') return parseCellDeleteUrl(input);
    return null;
  }

  function clearCellCaches(sheetId, index) {
    const key = cellKey(sheetId, index);
    SESSION_PREVIEW_CACHE.delete(key);
    DIRTY_PIXEL_CACHE.delete(key);
    activeRefreshes.delete(key);
  }

  async function blobToDataUrl(blob) {
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  async function fetchCellDataUrl(sheetId, index) {
    const r = await fetch(cellImageUrl(sheetId, index), { cache: 'no-store' });
    if (!r.ok) throw new Error(`cell ${index} image not ready`);
    const blob = await r.blob();
    if (!blob.size) throw new Error(`cell ${index} image is empty`);
    return blobToDataUrl(blob);
  }

  function ensureGridImage(index) {
    const cellEl = document.querySelector(`#grid .cell[data-i="${index}"]`);
    if (!cellEl) return null;
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
    return img;
  }

  function clearGridCell(index) {
    const cellEl = document.querySelector(`#grid .cell[data-i="${index}"]`);
    if (!cellEl) return;
    cellEl.classList.remove('filled');
    cellEl.querySelectorAll('img').forEach((img) => img.remove());
  }

  function clearEditorIfRelevant(sheetId, index) {
    if (currentSheetId() !== sheetId || selectedIndex() !== Number(index)) return;
    const canvas = $('pixelEditorCanvas');
    if (canvas) {
      const w = canvas.width || 32;
      const h = canvas.height || 32;
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, w, h);
    }
    if ($('pixelEditorMeta')) $('pixelEditorMeta').textContent = `格子 ${index} 已删除。`;
  }

  function setEditorCanvasFromDataUrl(sheetId, index, dataUrl) {
    if (currentSheetId() !== sheetId || selectedIndex() !== Number(index)) return;
    const canvas = $('pixelEditorCanvas');
    if (!canvas) return;
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth || img.width || canvas.width || 32;
      const h = img.naturalHeight || img.height || canvas.height || 32;
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      if ($('pixelEditorMeta')) $('pixelEditorMeta').textContent = `已刷新：格子 ${index} · ${w}×${h}`;
    };
    img.src = dataUrl;
  }

  function forceReloadEditorIfRelevant(sheetId, index) {
    if (currentSheetId() !== sheetId) return;
    if (selectedIndex() !== Number(index)) return;
    const loadBtn = $('loadPixelBtn');
    if (loadBtn) loadBtn.click();
  }

  async function refreshChangedCellNow(sheetId, index, token, attempt) {
    if (activeRefreshes.get(cellKey(sheetId, index)) !== token) return false;
    clearCellCaches(sheetId, index);
    activeRefreshes.set(cellKey(sheetId, index), token);
    try {
      const dataUrl = await fetchCellDataUrl(sheetId, index);
      if (activeRefreshes.get(cellKey(sheetId, index)) !== token) return true;
      const key = cellKey(sheetId, index);
      SESSION_PREVIEW_CACHE.set(key, dataUrl);
      const img = ensureGridImage(index);
      if (img) img.src = dataUrl;
      setEditorCanvasFromDataUrl(sheetId, index, dataUrl);
      if (attempt > 0) forceReloadEditorIfRelevant(sheetId, index);
      return true;
    } catch {
      return false;
    }
  }

  function invalidateGeneratedCell(sheetId, index) {
    const key = cellKey(sheetId, index);
    const token = `${Date.now()}:${Math.random()}`;
    activeRefreshes.set(key, token);
    clearCellCaches(sheetId, index);
    activeRefreshes.set(key, token);

    REFRESH_DELAYS.forEach((delay, attempt) => {
      setTimeout(async () => {
        if (activeRefreshes.get(key) !== token) return;
        const ok = await refreshChangedCellNow(sheetId, index, token, attempt);
        if (ok && attempt >= 2) activeRefreshes.delete(key);
      }, delay);
    });
  }

  function invalidateDeletedCell(sheetId, index) {
    const key = cellKey(sheetId, index);
    const token = `${Date.now()}:${Math.random()}`;
    activeRefreshes.set(key, token);
    CLEAR_DELAYS.forEach((delay) => {
      setTimeout(() => {
        if (activeRefreshes.get(key) !== token) return;
        clearCellCaches(sheetId, index);
        clearGridCell(index);
        clearEditorIfRelevant(sheetId, index);
        activeRefreshes.set(key, token);
      }, delay);
    });
    setTimeout(() => activeRefreshes.delete(key), Math.max(...CLEAR_DELAYS) + 80);
  }

  function patchFetch() {
    if (window.fetch.__pixelRegenerateSyncPatched) return;
    const originalFetch = window.fetch.bind(window);
    const patched = async function pixelRegenerateSyncFetch(input, init = {}) {
      const method = String(init?.method || input?.method || 'GET').toUpperCase();
      const target = parseChangedCellUrl(input, method);
      const response = await originalFetch(input, init);
      if (target && response.ok) {
        if (target.kind === 'delete') invalidateDeletedCell(target.sheetId, target.index);
        else invalidateGeneratedCell(target.sheetId, target.index);
      }
      return response;
    };
    patched.__pixelRegenerateSyncPatched = true;
    patched.__originalFetch = originalFetch;
    window.fetch = patched;
  }

  function install() {
    if (installed) return;
    installed = true;
    patchFetch();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install);
  else install();
})();
