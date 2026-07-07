(() => {
  let installed = false;
  let lastLoadedKey = '';

  function $(id) { return document.getElementById(id); }

  function selectedCellElement() {
    return document.querySelector('#grid .cell.selected');
  }

  function selectedCellIndex() {
    const el = selectedCellElement();
    return el ? Number(el.dataset.i) : null;
  }

  function selectedSheetId() {
    return $('sheetSel')?.value || '';
  }

  function selectedGridImageSrc() {
    return selectedCellElement()?.querySelector('img')?.src || '';
  }

  function syncDefaultTransparentTool() {
    const alpha = $('pixelAlpha');
    const transparent = $('pixelTransparent');
    const swatch = $('pixelCurrentSwatch');
    if (alpha) alpha.value = '0';
    if (transparent) transparent.checked = true;
    if (swatch) swatch.style.background = 'transparent';
  }

  function ensureBulkEnhancerScript() {
    if ($('pixelEditorBulkBgScript')) return;
    const script = document.createElement('script');
    script.id = 'pixelEditorBulkBgScript';
    script.src = '/pixel-editor-bulk-bg.js';
    document.head.appendChild(script);
  }

  async function loadImage(src) {
    const img = new Image();
    img.decoding = 'async';
    return await new Promise((resolve, reject) => {
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  async function syncPixelEditorFromSelection({ force = false } = {}) {
    const box = $('pixelEditorBox');
    const canvas = $('pixelEditorCanvas');
    const meta = $('pixelEditorMeta');
    const sheetId = selectedSheetId();
    const index = selectedCellIndex();
    if (!box || !canvas || !sheetId || index === null) return;
    box.open = true;

    const src = selectedGridImageSrc();
    const key = `${sheetId}:${index}:${src}`;
    if (!force && key === lastLoadedKey) return;
    lastLoadedKey = key;

    canvas.dataset.sheetId = sheetId;
    canvas.dataset.index = String(index);
    canvas.dataset.tag = $('tagEdit')?.value || '';

    if (!src) {
      const w = canvas.width || 32;
      const h = canvas.height || 32;
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, w, h);
      if (meta) meta.textContent = `格子 ${index} 没有图片。`;
      return;
    }

    try {
      const img = await loadImage(src);
      const w = img.naturalWidth || img.width || canvas.width || 32;
      const h = img.naturalHeight || img.height || canvas.height || 32;
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      if (meta) meta.textContent = `已载入：格子 ${index} · ${w}×${h}。当前画布会跟随相近色预览同步；左键画，右键吸色。`;
    } catch {
      if (meta) meta.textContent = `格子 ${index} 图片载入失败。`;
    }
  }

  function moveBgAdjustSection() {
    const box = $('pixelEditorBox');
    const section = $('bgAdjustSection');
    if (!box || !section) return;
    let host = $('pixelBgAdjustHost');
    if (!host) {
      host = document.createElement('div');
      host.id = 'pixelBgAdjustHost';
      host.className = 'pixel-bg-adjust-host';
      host.innerHTML = `<div class="pixel-editor-divider"></div><h3 class="pixel-bg-adjust-title">相近色 / 背景处理</h3>`;
      box.appendChild(host);
    }
    if (section.parentElement !== host) host.appendChild(section);
  }

  function injectFloatingStyle() {
    if ($('pixelEditorFloatingStyle')) return;
    const style = document.createElement('style');
    style.id = 'pixelEditorFloatingStyle';
    style.textContent = `
      #pixelEditorBox.pixel-editor-box{
        position:fixed;
        right:16px;
        top:72px;
        z-index:3600;
        width:380px;
        max-width:calc(100vw - 32px);
        max-height:calc(100vh - 88px);
        overflow:auto;
        margin-top:0!important;
        box-shadow:0 16px 52px rgba(0,0,0,.55);
      }
      #pixelEditorBox .pixel-editor-stage{display:block;}
      #pixelEditorBox .pixel-editor-canvas{
        width:340px;
        height:340px;
        max-width:100%;
        max-height:calc(100vh - 260px);
      }
      #pixelEditorBox .pixel-editor-meta{margin-top:8px;}
      #pixelEditorBox .pixel-editor-tools{gap:6px;}
      #pixelEditorBox .pixel-editor-tools button{padding:6px 9px;}
      #pixelBgAdjustHost{margin-top:12px;}
      #pixelBgAdjustHost .pixel-editor-divider{height:1px;background:var(--border);margin:12px 0;}
      #pixelBgAdjustHost .pixel-bg-adjust-title{margin:0 0 8px 0;font-size:15px;}
      #bgAdjustSection{margin-top:0!important;}
      #bgAdjustSection label:first-child{margin-top:0;}
      @media(max-width:900px){
        #pixelEditorBox.pixel-editor-box{position:static;width:auto;max-width:none;max-height:none;margin-top:16px!important;}
        #pixelEditorBox .pixel-editor-canvas{width:min(512px,90vw);height:min(512px,90vw);max-height:none;}
      }
    `;
    document.head.appendChild(style);
  }

  function install() {
    if (installed) return true;
    const box = $('pixelEditorBox');
    const grid = $('grid');
    if (!box || !grid || !$('pixelEditorCanvas')) return false;
    installed = true;

    injectFloatingStyle();
    moveBgAdjustSection();
    ensureBulkEnhancerScript();
    box.open = true;
    syncDefaultTransparentTool();
    setTimeout(() => syncPixelEditorFromSelection({ force: true }), 80);

    const delayedSync = (force = false, delay = 120) => setTimeout(() => syncPixelEditorFromSelection({ force }), delay);

    document.addEventListener('click', (e) => {
      if (e.target?.closest?.('#grid .cell')) delayedSync(true, 60);
    }, true);

    document.addEventListener('contextmenu', (e) => {
      if (e.target?.closest?.('#grid .cell')) delayedSync(true, 60);
    }, true);

    document.addEventListener('change', (e) => {
      if (e.target?.id === 'sheetSel') {
        lastLoadedKey = '';
        delayedSync(true, 100);
      }
      if (e.target?.id === 'removeBg' || e.target?.id === 'bgColor') delayedSync(true, 160);
    }, true);

    document.addEventListener('input', (e) => {
      if (e.target?.id === 'bgTolerance') delayedSync(true, 160);
    }, true);

    document.addEventListener('click', (e) => {
      if (e.target?.id === 'applyBgBtn' || e.target?.closest?.('#applyBgBtn')) delayedSync(true, 220);
      if (e.target?.id === 'loadPixelBtn' || e.target?.closest?.('#loadPixelBtn')) delayedSync(true, 30);
    }, true);

    const observer = new MutationObserver(() => {
      moveBgAdjustSection();
      delayedSync(false, 30);
    });
    observer.observe(grid, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'src'] });
    return true;
  }

  function boot() {
    if (install()) return;
    setTimeout(boot, 100);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
