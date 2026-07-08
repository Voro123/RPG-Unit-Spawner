(() => {
  const SESSION_PREVIEW_CACHE = window.__RpgCellPreviewCache || (window.__RpgCellPreviewCache = new Map());
  const DIRTY_PIXEL_CACHE = window.__RpgDirtyPixelCache || (window.__RpgDirtyPixelCache = new Map());
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
    return { sheetId: decodeURIComponent(m[1]), index: Number(m[2]), action: m[3] };
  }

  function clearCellCaches(sheetId, index) {
    const key = cellKey(sheetId, index);
    SESSION_PREVIEW_CACHE.delete(key);
    DIRTY_PIXEL_CACHE.delete(key);
  }

  function refreshGridThumbnailFromServer(sheetId, index) {
    const img = document.querySelector(`#grid .cell[data-i="${index}"] img`);
    if (img) {
      img.style.visibility = '';
      img.src = cellImageUrl(sheetId, index);
    }
  }

  function forceReloadEditorIfRelevant(sheetId, index) {
    if (currentSheetId() !== sheetId) return;
    if (selectedIndex() !== Number(index)) return;
    const loadBtn = $('loadPixelBtn');
    if (loadBtn) loadBtn.click();
  }

  function invalidateGeneratedCell(sheetId, index) {
    clearCellCaches(sheetId, index);
    refreshGridThumbnailFromServer(sheetId, index);
    [120, 420, 900, 1600].forEach((delay) => {
      setTimeout(() => {
        clearCellCaches(sheetId, index);
        refreshGridThumbnailFromServer(sheetId, index);
        forceReloadEditorIfRelevant(sheetId, index);
      }, delay);
    });
  }

  function patchFetch() {
    if (window.fetch.__pixelRegenerateSyncPatched) return;
    const originalFetch = window.fetch.bind(window);
    const patched = async function pixelRegenerateSyncFetch(input, init = {}) {
      const target = parseCellGenerateUrl(input);
      const method = String(init?.method || input?.method || 'GET').toUpperCase();
      const response = await originalFetch(input, init);
      if (target && method === 'POST' && response.ok) {
        invalidateGeneratedCell(target.sheetId, target.index);
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
