(() => {
  const SESSION_PREVIEW_CACHE = window.__RpgCellPreviewCache || (window.__RpgCellPreviewCache = new Map());
  const DIRTY_PIXEL_CACHE = window.__RpgDirtyPixelCache || (window.__RpgDirtyPixelCache = new Map());
  let sheetMetaCache = new Map();
  let installed = false;
  let guardTimer = null;

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

  async function fetchJson(url) {
    const headers = projectId() ? { 'x-project-id': projectId() } : {};
    const r = await fetch(withProject(url), { headers, cache: 'no-store' });
    return r.json();
  }

  async function fetchText(url) {
    const headers = projectId() ? { 'x-project-id': projectId() } : {};
    const r = await fetch(withProject(url), { headers, cache: 'no-store' });
    return r.text();
  }

  async function loadImage(src) {
    return await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  function inferAssetKind(cell) {
    if (cell?.assetKind === 'tile' || cell?.assetKind === 'sprite') return cell.assetKind;
    const tag = String(cell?.tag || '');
    if (tag.startsWith('地块：')) return 'tile';
    if (tag.startsWith('非地块：')) return 'sprite';
    return '';
  }

  function selectedIndexes() {
    const region = Array.from(document.querySelectorAll('#grid .cell.region'));
    const targets = region.length ? region : Array.from(document.querySelectorAll('#grid .cell.selected'));
    return targets.map((el) => Number(el.dataset.i)).filter((v) => Number.isInteger(v));
  }

  function currentSheetId() {
    return $('sheetSel')?.value || '';
  }

  async function getSheetMeta(sheetId) {
    const cacheKey = `${projectId()}:${sheetId}`;
    if (sheetMetaCache.has(cacheKey)) return sheetMetaCache.get(cacheKey);
    const meta = await fetchJson(`/api/sprites/${sheetId}`);
    sheetMetaCache.set(cacheKey, meta);
    return meta;
  }

  function clearBgPreviewCanvas() {
    const cv = $('bgPreview');
    if (!cv) return;
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, cv.width, cv.height);
  }

  function setGridCellSrc(index, src) {
    const img = document.querySelector(`#grid .cell[data-i="${index}"] img`);
    if (img && img.src !== src) img.src = src;
  }

  function restoreTileCellPreview(sheetId, index) {
    const key = cellKey(sheetId, index);
    const dirty = DIRTY_PIXEL_CACHE.get(key);
    if (dirty) {
      SESSION_PREVIEW_CACHE.set(key, dirty);
      setGridCellSrc(index, dirty);
      return;
    }
    SESSION_PREVIEW_CACHE.delete(key);
    setGridCellSrc(index, withProject(`/api/sprites/${sheetId}/cells/${index}?t=${Date.now()}`));
  }

  async function guardTileBgPreview() {
    const sheetId = currentSheetId();
    const indexes = selectedIndexes();
    if (!sheetId || !indexes.length) return;
    try {
      const meta = await getSheetMeta(sheetId);
      const cells = indexes
        .map((index) => meta.cells?.find?.((c) => Number(c.index) === Number(index)))
        .filter(Boolean);
      if (!cells.length) return;
      let anySprite = false;
      for (const cell of cells) {
        const kind = inferAssetKind(cell);
        if (kind === 'tile') restoreTileCellPreview(sheetId, cell.index);
        if (kind === 'sprite') anySprite = true;
      }
      if (!anySprite) clearBgPreviewCanvas();
    } catch { /* ignore guard failures */ }
  }

  function scheduleTileGuard(delay = 80) {
    clearTimeout(guardTimer);
    guardTimer = setTimeout(() => guardTileBgPreview(), delay);
  }

  function displayedCellSrc(index) {
    return document.querySelector(`#grid .cell[data-i="${index}"] img`)?.src || '';
  }

  function previewSourceForCell(sheetId, index) {
    const key = cellKey(sheetId, index);
    return DIRTY_PIXEL_CACHE.get(key) || SESSION_PREVIEW_CACHE.get(key) || displayedCellSrc(index) || withProject(`/api/sprites/${sheetId}/cells/${index}?t=${Date.now()}`);
  }

  function crc32(buf) {
    let table = crc32._t;
    if (!table) {
      table = crc32._t = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
      }
    }
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xFF];
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function makeZip(files) {
    const enc = new TextEncoder();
    const chunks = [], central = [];
    let offset = 0;
    for (const f of files) {
      const nameBytes = enc.encode(f.name);
      const data = f.data instanceof Uint8Array ? f.data : enc.encode(f.data);
      const crc = crc32(data);
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true);
      lh.setUint16(4, 20, true);
      lh.setUint16(6, 0x0800, true);
      lh.setUint16(8, 0, true);
      lh.setUint16(10, 0, true);
      lh.setUint16(12, 0, true);
      lh.setUint32(14, crc, true);
      lh.setUint32(18, data.length, true);
      lh.setUint32(22, data.length, true);
      lh.setUint16(26, nameBytes.length, true);
      lh.setUint16(28, 0, true);
      chunks.push(new Uint8Array(lh.buffer), nameBytes, data);

      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true);
      ch.setUint16(4, 20, true);
      ch.setUint16(6, 20, true);
      ch.setUint16(8, 0x0800, true);
      ch.setUint16(10, 0, true);
      ch.setUint16(12, 0, true);
      ch.setUint16(14, 0, true);
      ch.setUint32(16, crc, true);
      ch.setUint32(20, data.length, true);
      ch.setUint32(24, data.length, true);
      ch.setUint16(28, nameBytes.length, true);
      ch.setUint16(30, 0, true);
      ch.setUint16(32, 0, true);
      ch.setUint16(34, 0, true);
      ch.setUint16(36, 0, true);
      ch.setUint32(38, 0, true);
      ch.setUint32(42, offset, true);
      central.push(new Uint8Array(ch.buffer), nameBytes);
      offset += 30 + nameBytes.length + data.length;
    }

    const centralSize = central.reduce((s, c) => s + c.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(4, 0, true);
    end.setUint16(6, 0, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, offset, true);
    end.setUint16(20, 0, true);
    return new Blob([...chunks, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
  }

  async function exportUsingCurrentPreview() {
    const sheetId = currentSheetId();
    if (!sheetId) return;
    const meta = await fetchJson(`/api/sprites/${sheetId}`);
    const cs = Number(meta.cellSize) || 32;
    const cv = document.createElement('canvas');
    cv.width = Number(meta.cols) * cs;
    cv.height = Number(meta.rows) * cs;
    const ctx = cv.getContext('2d');
    ctx.imageSmoothingEnabled = false;

    for (const cell of meta.cells || []) {
      if (!cell?.imageRef) continue;
      const src = previewSourceForCell(sheetId, cell.index);
      const img = await loadImage(src);
      ctx.drawImage(img, cell.col * cs, cell.row * cs, cs, cs);
    }

    const pngBlob = await new Promise((resolve) => cv.toBlob(resolve, 'image/png'));
    const pngBytes = new Uint8Array(await pngBlob.arrayBuffer());
    const skillText = await fetchText(`/api/sprites/${sheetId}/skill`).catch(() => '');
    const folder = String(meta.name || 'sheet').replace(/[\\/:*?"<>|]/g, '_');
    const zip = makeZip([
      { name: `${folder}/${folder}.png`, data: pngBytes },
      { name: `${folder}/meta.json`, data: JSON.stringify(meta, null, 2) },
      { name: `${folder}/SKILL.md`, data: skillText },
    ]);
    const a = document.createElement('a');
    a.download = `${folder}.zip`;
    a.href = URL.createObjectURL(zip);
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function install() {
    if (installed) return true;
    if (!$('exportBtn') || !$('grid') || !$('sheetSel')) return false;
    installed = true;

    $('exportBtn').onclick = () => exportUsingCurrentPreview().catch((e) => {
      const status = $('opStatus');
      if (status) status.textContent = '导出失败：' + (e.message || e);
    });

    document.addEventListener('click', (e) => {
      if (e.target?.closest?.('#grid .cell')) scheduleTileGuard(90);
      if (e.target?.id === 'applyBgBtn' || e.target?.closest?.('#applyBgBtn')) scheduleTileGuard(180);
    }, true);
    document.addEventListener('mouseup', (e) => {
      if (e.target?.closest?.('#grid')) scheduleTileGuard(100);
    }, true);
    document.addEventListener('contextmenu', (e) => {
      if (e.target?.closest?.('#grid .cell')) scheduleTileGuard(90);
    }, true);
    document.addEventListener('change', (e) => {
      if (['bgColor', 'removeBg', 'sheetSel'].includes(e.target?.id)) {
        if (e.target?.id === 'sheetSel') sheetMetaCache = new Map();
        scheduleTileGuard(120);
      }
    }, true);
    document.addEventListener('input', (e) => {
      if (e.target?.id === 'bgTolerance') scheduleTileGuard(120);
    }, true);

    scheduleTileGuard(300);
    return true;
  }

  function boot() {
    if (install()) return;
    setTimeout(boot, 120);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
