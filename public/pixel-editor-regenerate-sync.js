(() => {
  const SESSION_PREVIEW_CACHE = window.__RpgCellPreviewCache || (window.__RpgCellPreviewCache = new Map());
  const DIRTY_PIXEL_CACHE = window.__RpgDirtyPixelCache || (window.__RpgDirtyPixelCache = new Map());
  const REFRESH_DELAYS = [0, 80, 180, 360, 720, 1200, 2000, 3200];
  const CLEAR_DELAYS = [0, 60, 180, 420, 900, 1600];
  const activeRefreshes = new Map();
  const FILL_OPTION_KEY = 'rpg-unit-spawner.spriteFillSelectedAreaPrompt.v1';
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

  function currentAssetKind() {
    return document.querySelector('input[name="assetKind"]:checked')?.value || 'sprite';
  }

  function isSpriteAssetKind() {
    return currentAssetKind() === 'sprite';
  }

  function fillOptionEnabled() {
    return localStorage.getItem(FILL_OPTION_KEY) === '1';
  }

  function setFillOptionEnabled(enabled) {
    localStorage.setItem(FILL_OPTION_KEY, enabled ? '1' : '0');
  }

  function setStatus(text) {
    if ($('opStatus')) $('opStatus').textContent = text;
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

  function selectedRegionCells() {
    const region = Array.from(document.querySelectorAll('#grid .cell.region'));
    if (region.length) return region;
    const selected = document.querySelector('#grid .cell.selected');
    return selected ? [selected] : [];
  }

  function selectedRegionSize() {
    const cells = selectedRegionCells();
    if (!cells.length) return { width: 1, height: 1, count: 1 };
    const xs = [];
    const ys = [];
    for (const cell of cells) {
      const rect = cell.getBoundingClientRect();
      xs.push(Math.round(rect.left));
      ys.push(Math.round(rect.top));
    }
    const width = Math.max(1, new Set(xs).size);
    const height = Math.max(1, new Set(ys).size);
    return { width, height, count: cells.length };
  }

  function fillPromptAddon() {
    const { width, height, count } = selectedRegionSize();
    const areaText = count > 1 ? `${width} cells wide by ${height} cells tall` : 'single-cell';
    return [
      'Composition constraint for non-tile asset generation:',
      `This asset should visually fill the selected ${areaText} canvas area as much as possible.`,
      'Scale the main subject up so it occupies most of the frame, roughly 85% to 95% of the available width and height while remaining fully visible.',
      count > 1
        ? 'If multiple cells are selected, the subject should span the full selected area instead of appearing only one-cell tall or leaving a large empty region.'
        : 'Do not render a tiny centered object with large empty margins around it.',
      'Minimize empty transparent or background padding. Keep the subject close to the top, bottom, left, and right bounds without being cropped.'
    ].join(' ');
  }

  function appendAddonToPrompt(prompt, addon) {
    if (typeof prompt !== 'string' || !prompt.trim()) return { changed: false, value: prompt };
    if (prompt.includes('Composition constraint for non-tile asset generation:')) return { changed: false, value: prompt };
    return { changed: true, value: `${prompt.trim()}\n\n${addon}` };
  }

  function injectPromptAddonIntoPayload(payload, addon) {
    let changed = false;
    function visit(node) {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        node.forEach(visit);
        return;
      }
      for (const key of ['prompt', 'finalPrompt', 'final_prompt', 'translatedPrompt']) {
        if (typeof node[key] === 'string') {
          const next = appendAddonToPrompt(node[key], addon);
          if (next.changed) {
            node[key] = next.value;
            changed = true;
          }
        }
      }
      for (const value of Object.values(node)) visit(value);
    }
    visit(payload);
    return changed;
  }

  function maybeInjectFillPrompt(input, init, method) {
    if (method !== 'POST') return init;
    if (!parseCellGenerateUrl(input)) return init;
    if (!fillOptionEnabled() || !isSpriteAssetKind()) return init;
    if (typeof init?.body !== 'string') return init;
    try {
      const payload = JSON.parse(init.body);
      const addon = fillPromptAddon();
      const changed = injectPromptAddonIntoPayload(payload, addon);
      if (!changed) return init;
      const nextInit = { ...init, body: JSON.stringify(payload) };
      setStatus('已为本次非地块生成注入“尽量占满格子”提示词');
      return nextInit;
    } catch {
      return init;
    }
  }

  function updateFillOptionUiState() {
    const wrap = $('spriteFillAreaPromptWrap');
    const checkbox = $('spriteFillAreaPrompt');
    const note = $('spriteFillAreaPromptNote');
    if (!wrap || !checkbox || !note) return;
    const sprite = isSpriteAssetKind();
    wrap.style.opacity = sprite ? '1' : '.55';
    checkbox.disabled = !sprite;
    note.textContent = sprite ? '生成时追加占满选区约束' : '地块模式不生效';
  }

  function insertAfter(reference, node) {
    if (!reference?.parentElement) return false;
    reference.parentElement.insertBefore(node, reference.nextSibling);
    return true;
  }

  function assetKindAnchor(spriteRadio) {
    const label = spriteRadio?.closest('label');
    const radioGroup = label?.parentElement;
    if (radioGroup?.querySelectorAll?.('input[name="assetKind"]').length >= 2) return radioGroup;
    return spriteRadio?.closest('.row') || radioGroup || label;
  }

  function injectFillOptionUi() {
    if ($('spriteFillAreaPromptWrap')) return true;
    const spriteRadio = document.querySelector('input[name="assetKind"][value="sprite"]');
    const promptInput = $('prompt') || document.querySelector('textarea');
    const fallbackHost = promptInput?.parentElement;
    const anchor = assetKindAnchor(spriteRadio) || fallbackHost;
    if (!anchor) return false;

    const wrap = document.createElement('div');
    wrap.id = 'spriteFillAreaPromptWrap';
    wrap.className = 'row sprite-fill-area-prompt-wrap';
    wrap.style.marginTop = '8px';
    wrap.innerHTML = `
      <label id="spriteFillAreaPromptLabel" for="spriteFillAreaPrompt" class="muted" style="display:flex;align-items:center;gap:8px;cursor:pointer;margin:0;line-height:1.35;font-size:13px">
        <input id="spriteFillAreaPrompt" type="checkbox" style="margin:0" />
        <span><strong style="color:var(--text,#e5e7eb);font-weight:650">非地块尽量占满格子</strong><span id="spriteFillAreaPromptNote" style="margin-left:8px;font-size:12px;color:var(--muted,#9ca3af)"></span></span>
      </label>
    `;

    if (!insertAfter(anchor, wrap) && fallbackHost) fallbackHost.appendChild(wrap);

    const checkbox = $('spriteFillAreaPrompt');
    checkbox.checked = fillOptionEnabled();
    checkbox.addEventListener('change', () => {
      setFillOptionEnabled(checkbox.checked);
      updateFillOptionUiState();
      setStatus(checkbox.checked
        ? '已开启：非地块尽量占满格子（发送前自动注入提示词）'
        : '已关闭：非地块尽量占满格子');
    });
    document.querySelectorAll('input[name="assetKind"]').forEach((radio) => {
      radio.addEventListener('change', updateFillOptionUiState, true);
    });
    updateFillOptionUiState();
    return true;
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
      const nextInit = maybeInjectFillPrompt(input, init, method);
      const response = await originalFetch(input, nextInit);
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
    if (!injectFillOptionUi()) {
      const retry = () => injectFillOptionUi() || setTimeout(retry, 120);
      setTimeout(retry, 120);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install);
  else install();
})();
