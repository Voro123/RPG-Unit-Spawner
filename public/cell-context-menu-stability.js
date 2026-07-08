(() => {
  let installed = false;
  let recentCellContextUntil = 0;

  function isCellTarget(target) {
    return !!target?.closest?.('#grid .cell');
  }

  function isMenuTarget(target) {
    return !!target?.closest?.('#cellContextMenu');
  }

  function markRecentCellContext() {
    recentCellContextUntil = Date.now() + 900;
  }

  function shouldSwallowCloseEvent(e) {
    if (Date.now() > recentCellContextUntil) return false;
    if (isMenuTarget(e.target)) return false;
    if (isCellTarget(e.target)) return true;
    return ['click', 'auxclick', 'mouseup', 'pointerup'].includes(e.type);
  }

  function install() {
    if (installed) return;
    installed = true;

    document.addEventListener('contextmenu', (e) => {
      if (isCellTarget(e.target)) markRecentCellContext();
    }, true);

    ['click', 'auxclick', 'mouseup', 'pointerup'].forEach((type) => {
      document.addEventListener(type, (e) => {
        if (!shouldSwallowCloseEvent(e)) return;
        e.stopImmediatePropagation();
      }, true);
    });

    document.addEventListener('pointerdown', (e) => {
      if (e.button === 2 && isCellTarget(e.target)) markRecentCellContext();
    }, true);

    document.addEventListener('mousedown', (e) => {
      if (e.button === 2 && isCellTarget(e.target)) markRecentCellContext();
    }, true);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install);
  else install();
})();
