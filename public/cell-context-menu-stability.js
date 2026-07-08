(() => {
  let installed = false;
  let trailingRightClickUntil = 0;
  let clipboard = null;

  function $(id) { return document.getElementById(id); }

  function isCellTarget(target) {
    return !!target?.closest?.('#grid .cell');
  }

  function cellElement(target) {
    return target?.closest?.('#grid .cell') || null;
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

  function projectId() {
    return localStorage.getItem('rpg-unit-spawner.projectId') || '';
  }

  function withProject(url) {
    if (window.Project?.withProject) return window.Project.withProject(url);
    const pid = projectId();
    if (!pid) return url;
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}projectId=${encodeURIComponent(pid)}`;
  }

  async function api(url, opt = {}) {
    if (window.Project?.fetch) return window.Project.fetch(url, opt);
    const headers = { ...(opt.headers || {}) };
    if (projectId()) headers['x-project-id'] = projectId();
    return fetch(withProject(url), { ...opt, headers });
  }

  function selectedSheetId() {
    return $('sheetSel')?.value || '';
  }

  async function spriteSheet() {
    const sheetId = selectedSheetId();
    if (!sheetId) return null;
    return (await api(`/api/sprites/${sheetId}`)).json();
  }

  function cellIndexFromElement(el) {
    const index = Number(el?.dataset?.i);
    return Number.isInteger(index) ? index : null;
  }

  function regionIndexes() {
    return Array.from(document.querySelectorAll('#grid .cell.region'))
      .map((el) => cellIndexFromElement(el))
      .filter((v) => Number.isInteger(v));
  }

  function activeSourceIndexes(clickedIndex) {
    const region = regionIndexes();
    if (region.length && region.includes(Number(clickedIndex))) return region;
    return [Number(clickedIndex)];
  }

  function inferAssetKind(cell) {
    if (cell?.assetKind === 'tile' || cell?.assetKind === 'sprite') return cell.assetKind;
    const tag = String(cell?.tag || '');
    if (tag.startsWith('地块：')) return 'tile';
    if (tag.startsWith('非地块：')) return 'sprite';
    return undefined;
  }

  async function blobToBase64(blob) {
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  async function fetchCellBase64(sheetId, index) {
    const r = await fetch(withProject(`/api/sprites/${sheetId}/cells/${index}?t=${Date.now()}`), { cache: 'no-store' });
    if (!r.ok) throw new Error(`格子 ${index} 没有图片`);
    return blobToBase64(await r.blob());
  }

  function sortedCellsByGrid(cells) {
    return [...cells].sort((a, b) => (a.row - b.row) || (a.col - b.col));
  }

  async function setClipboardFromIndexes(indexes, mode) {
    const sheet = await spriteSheet();
    if (!sheet) return;
    const cells = sortedCellsByGrid(indexes
      .map((index) => sheet.cells?.find?.((c) => Number(c.index) === Number(index)))
      .filter((c) => c?.imageRef));
    if (!cells.length) throw new Error('当前选择里没有图片可复制/移动');
    const minCol = Math.min(...cells.map((c) => c.col));
    const minRow = Math.min(...cells.map((c) => c.row));
    clipboard = {
      mode,
      sheetId: sheet.id,
      width: Math.max(...cells.map((c) => c.col)) - minCol + 1,
      height: Math.max(...cells.map((c) => c.row)) - minRow + 1,
      items: [],
    };
    for (const cell of cells) {
      clipboard.items.push({
        sourceIndex: cell.index,
        relCol: cell.col - minCol,
        relRow: cell.row - minRow,
        image: await fetchCellBase64(sheet.id, cell.index),
        tag: cell.tag || '',
        assetKind: inferAssetKind(cell),
      });
    }
    const label = clipboard.items.length > 1 ? `${clipboard.width}×${clipboard.height} 区域（${clipboard.items.length} 张图）` : `格子 ${clipboard.items[0].sourceIndex}`;
    if ($('opStatus')) $('opStatus').textContent = mode === 'move' ? `已选择移动源：${label}` : `已复制：${label}`;
  }

  function targetCellsForPaste(sheet, anchorIndex) {
    if (!clipboard) return [];
    const anchor = sheet.cells?.find?.((c) => Number(c.index) === Number(anchorIndex));
    if (!anchor) throw new Error('目标格不存在');
    return clipboard.items.map((item) => {
      const target = sheet.cells?.find?.((c) => c.col === anchor.col + item.relCol && c.row === anchor.row + item.relRow);
      if (!target) throw new Error('粘贴区域超出当前精灵图范围');
      return { item, target };
    });
  }

  async function pasteClipboard(anchorIndex) {
    if (!clipboard) return;
    const sheet = await spriteSheet();
    if (!sheet) return;
    const targets = targetCellsForPaste(sheet, anchorIndex);
    const occupied = targets.filter(({ target }) => target.imageRef);
    if (occupied.length && !confirm(`目标区域已有 ${occupied.length} 个格子有图片，是否覆盖？`)) return;
    for (const { item, target } of targets) {
      const r = await api(`/api/sprites/${sheet.id}/cells/${target.index}/image`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: item.image, tag: item.tag, assetKind: item.assetKind, projectId: projectId() }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || `粘贴到格子 ${target.index} 失败`);
    }
    if (clipboard.mode === 'move') {
      const movedToSame = new Set(targets
        .filter(({ item, target }) => clipboard.sheetId === sheet.id && Number(item.sourceIndex) === Number(target.index))
        .map(({ item }) => Number(item.sourceIndex)));
      for (const item of clipboard.items) {
        if (movedToSame.has(Number(item.sourceIndex))) continue;
        await api(`/api/sprites/${clipboard.sheetId}/cells/${item.sourceIndex}`, { method: 'DELETE' });
      }
      clipboard = null;
    }
    if ($('opStatus')) $('opStatus').textContent = `已粘贴 ${targets.length} 个图块`;
    await refreshSheet(sheet.id, anchorIndex);
  }

  async function deleteIndexes(indexes) {
    const sheet = await spriteSheet();
    if (!sheet) return;
    const filled = indexes
      .map((index) => sheet.cells?.find?.((c) => Number(c.index) === Number(index)))
      .filter((cell) => cell?.imageRef);
    if (!filled.length) return;
    if (!confirm(`删除当前选择中的 ${filled.length} 个图块和 Tag？`)) return;
    for (const cell of filled) {
      const r = await api(`/api/sprites/${sheet.id}/cells/${cell.index}`, { method: 'DELETE' });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || `删除格子 ${cell.index} 失败`);
    }
    if ($('opStatus')) $('opStatus').textContent = `已删除 ${filled.length} 个图块`;
    await refreshSheet(sheet.id, indexes[0]);
  }

  async function refreshSheet(sheetId, index) {
    if (typeof window.openSheet === 'function') {
      await window.openSheet(sheetId);
      if (index !== undefined && typeof window.selectCell === 'function') setTimeout(() => window.selectCell(index), 0);
      return;
    }
    $('refreshBtn')?.click?.();
  }

  function menuButton(label, disabled, onClick, className = '') {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.disabled = !!disabled;
    if (className) b.className = className;
    b.onclick = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeMenu();
      try { await onClick(); }
      catch (err) { if ($('opStatus')) $('opStatus').textContent = '操作失败：' + (err.message || err); }
    };
    return b;
  }

  async function openRegionAwareMenu(event, clickedIndex) {
    event.preventDefault();
    event.stopImmediatePropagation();
    markRightMenuOpen();
    closeMenu();

    const sheet = await spriteSheet();
    if (!sheet) return;
    const indexes = activeSourceIndexes(clickedIndex);
    const cells = indexes.map((index) => sheet.cells?.find?.((c) => Number(c.index) === Number(index))).filter(Boolean);
    const imageCount = cells.filter((c) => c.imageRef).length;
    const isRegion = indexes.length > 1;
    const title = isRegion ? `区域 ${indexes.length} 格 · ${imageCount} 张图` : `格子 ${clickedIndex}`;

    const menu = document.createElement('div');
    menu.id = 'cellContextMenu';
    menu.className = 'cell-context-menu';
    menu.innerHTML = `<div class="menu-title">${title}${clipboard ? ` · 剪贴板：${clipboard.items.length} 张图` : ''}</div>`;
    menu.appendChild(menuButton(isRegion ? '复制区域图块' : '复制图块', imageCount === 0, () => setClipboardFromIndexes(indexes, 'copy')));
    menu.appendChild(menuButton(isRegion ? '移动区域图块（剪切）' : '移动图块（剪切）', imageCount === 0, () => setClipboardFromIndexes(indexes, 'move')));
    const sep = document.createElement('div'); sep.className = 'sep'; menu.appendChild(sep);
    menu.appendChild(menuButton(clipboard?.items?.length > 1 ? '以此格为左上角粘贴区域' : '粘贴到此格', !clipboard, () => pasteClipboard(clickedIndex)));
    const sep2 = document.createElement('div'); sep2.className = 'sep'; menu.appendChild(sep2);
    menu.appendChild(menuButton(isRegion ? '删除区域图块' : '删除此格', imageCount === 0, () => deleteIndexes(indexes), 'danger'));
    document.body.appendChild(menu);

    const pad = 8;
    let x = event.clientX, y = event.clientY;
    const rect = menu.getBoundingClientRect();
    if (x + rect.width > innerWidth - pad) x = innerWidth - rect.width - pad;
    if (y + rect.height > innerHeight - pad) y = innerHeight - rect.height - pad;
    menu.style.left = Math.max(pad, x) + 'px';
    menu.style.top = Math.max(pad, y) + 'px';
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
      const cell = cellElement(e.target);
      if (!cell) return;
      const index = cellIndexFromElement(cell);
      if (!Number.isInteger(index)) return;
      openRegionAwareMenu(e, index).catch((err) => {
        closeMenu();
        if ($('opStatus')) $('opStatus').textContent = '打开右键菜单失败：' + (err.message || err);
      });
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
