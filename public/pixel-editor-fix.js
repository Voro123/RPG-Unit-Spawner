(() => {
  let installed = false;
  let lastLoadedKey = '';

  function $(id) { return document.getElementById(id); }

  function selectedCellIndex() {
    const el = document.querySelector('#grid .cell.selected');
    return el ? Number(el.dataset.i) : null;
  }

  function selectedSheetId() {
    return $('sheetSel')?.value || '';
  }

  function syncDefaultTransparentTool() {
    const alpha = $('pixelAlpha');
    const transparent = $('pixelTransparent');
    const swatch = $('pixelCurrentSwatch');
    if (alpha) alpha.value = '0';
    if (transparent) transparent.checked = true;
    if (swatch) swatch.style.background = 'transparent';
  }

  function forceLoadSelectedCell({ force = false } = {}) {
    const box = $('pixelEditorBox');
    const loadBtn = $('loadPixelBtn');
    const sheetId = selectedSheetId();
    const index = selectedCellIndex();
    if (!box || !loadBtn || !sheetId || index === null) return;
    box.open = true;
    const key = `${sheetId}:${index}`;
    if (!force && key === lastLoadedKey) return;
    lastLoadedKey = key;
    loadBtn.click();
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
    if (!box || !grid || !$('loadPixelBtn')) return false;
    installed = true;

    injectFloatingStyle();
    box.open = true;
    syncDefaultTransparentTool();
    setTimeout(() => forceLoadSelectedCell({ force: true }), 80);

    const delayedLoad = (force = false) => setTimeout(() => forceLoadSelectedCell({ force }), 120);

    document.addEventListener('click', (e) => {
      if (e.target?.closest?.('#grid .cell')) delayedLoad(true);
    }, true);

    document.addEventListener('contextmenu', (e) => {
      if (e.target?.closest?.('#grid .cell')) delayedLoad(true);
    }, true);

    document.addEventListener('change', (e) => {
      if (e.target?.id === 'sheetSel') {
        lastLoadedKey = '';
        delayedLoad(true);
      }
    }, true);

    const observer = new MutationObserver(() => delayedLoad(false));
    observer.observe(grid, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    return true;
  }

  function boot() {
    if (install()) return;
    setTimeout(boot, 100);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
