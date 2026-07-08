(() => {
  let installed = false;
  let trailingRightClickUntil = 0;

  function isCellTarget(target) {
    return !!target?.closest?.('#grid .cell');
  }

  function isMenuTarget(target) {
    return !!target?.closest?.('#cellContextMenu');
  }

  function closeMenu() {
    document.getElementById('cellContextMenu')?.remove();
  }

  function markRightMenuOpen() {
    trailingRightClickUntil = Date.now() + 140;
  }

  function isRightButtonEvent(e) {
    return e.button === 2 || (typeof e.buttons === 'number' && (e.buttons & 2) === 2);
  }

  function stopOnlyThisEvent(e) {
    e.stopImmediatePropagation();
  }

  function install() {
    if (installed) return;
    installed = true;

    ['pointerdown', 'mousedown'].forEach((type) => {
      document.addEventListener(type, (e) => {
        if (!isCellTarget(e.target)) return;
        if (isRightButtonEvent(e)) {
          markRightMenuOpen();
          // 阻止 sprite.html 的 cell.onmousedown 把右键当成左键框选，但不要 preventDefault，保留 contextmenu。
          stopOnlyThisEvent(e);
          return;
        }
        if (e.button === 0) {
          // 左键点击格子时，先关掉右键菜单，再让原本的选择/框选逻辑继续执行。
          closeMenu();
        }
      }, true);
    });

    document.addEventListener('contextmenu', (e) => {
      if (isCellTarget(e.target)) markRightMenuOpen();
    }, true);

    ['pointerup', 'mouseup', 'auxclick'].forEach((type) => {
      document.addEventListener(type, (e) => {
        if (Date.now() > trailingRightClickUntil) return;
        if (isMenuTarget(e.target)) return;
        if (isRightButtonEvent(e) || e.button === 1) stopOnlyThisEvent(e);
      }, true);
    });

    document.addEventListener('click', (e) => {
      if (isMenuTarget(e.target)) return;
      // 只吞右键菜单刚打开后浏览器可能补发的 click；真正的左键点击会在 mousedown 阶段关闭菜单并继续走选择逻辑。
      if (Date.now() <= trailingRightClickUntil) {
        stopOnlyThisEvent(e);
        return;
      }
      if (e.button === 0) closeMenu();
    }, true);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install);
  else install();
})();
