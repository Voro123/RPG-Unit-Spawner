(() => {
  const KEY = 'rpg-unit-spawner.projectId';
  let currentProjectId = '';
  let projectsCache = [];
  let activeGeneration = null;
  let promptPreviewTimer = null;

  function $(id) { return document.getElementById(id); }

  function enc(v) { return encodeURIComponent(v || ''); }

  function withProject(url) {
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}projectId=${enc(currentProjectId)}`;
  }

  function isGenerationEndpoint(url) {
    return /\/api\/sprites\/[^/]+\/cells\/[^/]+\/(generate|replace)$/.test(url)
      || /\/api\/sprites\/[^/]+\/generate-raw$/.test(url)
      || url === '/api/walks/generate'
      || url === '/api/generate';
  }

  function currentEditableFinalPrompt() {
    const t = $('promptPreviewText');
    return t ? t.value.trim() : '';
  }

  async function api(url, opt = {}) {
    const method = (opt.method || 'GET').toUpperCase();
    const headers = { ...(opt.headers || {}) };
    const signal = opt.signal || activeGeneration?.controller?.signal;
    if (currentProjectId) headers['x-project-id'] = currentProjectId;

    if (method === 'GET' || method === 'HEAD') {
      return fetch(withProject(url), { ...opt, headers, signal });
    }

    let body = opt.body;
    if (headers['Content-Type'] === 'application/json' && body) {
      try {
        const json = JSON.parse(body);
        const finalPrompt = isGenerationEndpoint(url) ? currentEditableFinalPrompt() : '';
        body = JSON.stringify({ ...json, projectId: currentProjectId, ...(finalPrompt ? { finalPrompt } : {}) });
      } catch { /* keep body */ }
    }

    return fetch(url, { ...opt, headers, body, signal });
  }

  function injectStyle() {
    if ($('projectStyle')) return;
    const s = document.createElement('style');
    s.id = 'projectStyle';
    s.textContent = `
      .project-bar{position:fixed;right:16px;top:12px;z-index:2000;display:flex;gap:8px;align-items:center;background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:8px;box-shadow:0 8px 24px rgba(0,0,0,.25)}
      .project-bar select{width:180px;margin:0;padding:7px 10px}.project-bar button{padding:7px 10px}
      .project-overlay{position:fixed;inset:0;z-index:5000;background:rgba(0,0,0,.72);display:flex;align-items:center;justify-content:center;padding:24px}
      .project-modal{width:min(520px,100%);background:var(--panel);border:1px solid var(--border);border-radius:16px;padding:22px;box-shadow:0 14px 60px rgba(0,0,0,.5)}
      .prompt-preview-box{margin-top:14px;border:1px solid var(--border);border-radius:10px;background:var(--panel2);padding:10px}
      .prompt-preview-box summary{cursor:pointer;font-weight:700}.prompt-preview-box textarea{min-height:180px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.5}.prompt-preview-meta{font-size:12px;margin-top:6px;color:var(--muted)}.prompt-preview-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:8px 0}
      @media(max-width:760px){.project-bar{position:static;margin:10px 12px}.project-bar select{width:100%}}
    `;
    document.head.appendChild(s);
  }

  async function loadProjects() {
    projectsCache = await (await fetch('/api/projects')).json();
    return projectsCache;
  }

  async function createProject(name) {
    const r = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const p = await r.json();
    if (!p.id) throw new Error(p.error || '创建项目失败');
    localStorage.setItem(KEY, p.id);
    currentProjectId = p.id;
    return p;
  }

  function showCreateOverlay() {
    if ($('projectOverlay')) return;
    const div = document.createElement('div');
    div.id = 'projectOverlay';
    div.className = 'project-overlay';
    div.innerHTML = `
      <div class="project-modal">
        <h1 style="margin-top:0">创建第一个项目</h1>
        <p class="muted">项目会隔离精灵图、行走图等运行时数据。开始前请先创建一个项目。</p>
        <label>项目名称</label>
        <input id="firstProjectName" placeholder="如：像素城镇 RPG" />
        <div class="row" style="margin-top:14px"><button id="createFirstProject">创建项目</button><span id="firstProjectStatus" class="muted"></span></div>
      </div>`;
    document.body.appendChild(div);
    setTimeout(() => $('firstProjectName')?.focus(), 0);
    $('createFirstProject').onclick = async () => {
      try {
        $('firstProjectStatus').textContent = '创建中…';
        await createProject($('firstProjectName').value.trim());
        location.reload();
      } catch (e) {
        $('firstProjectStatus').textContent = e.message || e;
      }
    };
  }

  function renderBar() {
    if (!projectsCache.length) return;
    if ($('projectBar')) $('projectBar').remove();
    const bar = document.createElement('div');
    bar.id = 'projectBar';
    bar.className = 'project-bar';
    bar.innerHTML = `
      <span class="muted">项目</span>
      <select id="projectSelect">${projectsCache.map((p) => `<option value="${p.id}" ${p.id === currentProjectId ? 'selected' : ''}>${p.name}</option>`).join('')}</select>
      <button class="ghost" id="addProjectBtn">新增</button>`;
    document.body.appendChild(bar);
    $('projectSelect').onchange = () => {
      currentProjectId = $('projectSelect').value;
      localStorage.setItem(KEY, currentProjectId);
      location.reload();
    };
    $('addProjectBtn').onclick = async () => {
      const name = prompt('新项目名称');
      if (!name) return;
      await createProject(name);
      location.reload();
    };
  }

  function installSpriteBackgroundKindGuard() {
    const radios = Array.from(document.querySelectorAll('input[name=assetKind]'));
    const removeBg = $('removeBg');
    const bgColor = $('bgColor');
    const bgTolerance = $('bgTolerance');
    const bgPreview = $('bgPreview');
    const applyBtn = $('applyBgBtn');
    if (!radios.length || !removeBg) return;

    const bgTitle = removeBg.closest('.row')?.previousElementSibling;
    const removeRow = removeBg.closest('.row');
    const toleranceLabel = bgTolerance?.previousElementSibling;
    const previewRow = bgPreview?.closest('.row');
    const note = previewRow?.nextElementSibling;
    const elements = [bgTitle, removeRow, toleranceLabel, bgTolerance, previewRow, note];
    const controls = [removeBg, bgColor, bgTolerance, applyBtn];

    function visible(el, on) { if (el) el.style.display = on ? '' : 'none'; }

    function sync() {
      const kind = document.querySelector('input[name=assetKind]:checked')?.value || 'sprite';
      const isSprite = kind === 'sprite';
      if (isSprite) {
        if (removeBg.dataset.spriteChecked !== undefined) removeBg.checked = removeBg.dataset.spriteChecked === 'true';
      } else {
        removeBg.dataset.spriteChecked = String(removeBg.checked);
        removeBg.checked = false;
      }
      elements.forEach((el) => visible(el, isSprite));
      controls.forEach((el) => { if (el) el.disabled = !isSprite; });
      removeBg.dispatchEvent(new Event('change', { bubbles: true }));
    }

    removeBg.addEventListener('change', () => {
      const kind = document.querySelector('input[name=assetKind]:checked')?.value || 'sprite';
      if (kind === 'sprite') removeBg.dataset.spriteChecked = String(removeBg.checked);
    });
    radios.forEach((r) => r.addEventListener('change', sync));
    sync();
  }

  function isAbortError(e) { return e && (e.name === 'AbortError' || e.code === DOMException.ABORT_ERR); }

  function installCancelableGenerationButtons() {
    const candidates = [
      { id: 'genBtn', label: '取消生成' },
      { id: 'replaceBtn', label: '取消生成' },
    ];
    const buttons = candidates.map((c) => ({ ...c, el: $(c.id) })).filter((c) => c.el && c.el.onclick && !c.el.dataset.cancelWrapped);
    if (!buttons.length) return;
    const status = $('opStatus') || $('status');

    for (const item of buttons) {
      const btn = item.el;
      const originalClick = btn.onclick;
      const originalText = btn.textContent;
      btn.dataset.cancelWrapped = '1';

      btn.onclick = async (event) => {
        if (activeGeneration) {
          activeGeneration.controller.abort();
          if (status) status.textContent = '正在取消生成…';
          return;
        }

        const controller = new AbortController();
        activeGeneration = { controller, button: btn };
        btn.textContent = item.label;
        for (const other of buttons) if (other.el !== btn) other.el.disabled = true;

        try {
          await originalClick.call(btn, event);
        } catch (e) {
          if (isAbortError(e)) {
            if (status) status.textContent = '已取消生成';
          } else {
            throw e;
          }
        } finally {
          if (activeGeneration?.controller === controller) activeGeneration = null;
          btn.textContent = originalText;
          for (const other of buttons) other.el.disabled = false;
        }
      };
    }
  }

  function currentRefForPreview() {
    const mode = document.querySelector('input[name=ref]:checked')?.value || 'auto';
    if (mode === 'none') return false;
    if (mode === 'upload') return !!$('refUpload')?.files?.length;
    if (mode === 'sub' || mode === 'existing') return true;
    return null;
  }

  function promptPreviewPayload() {
    const prompt = $('prompt')?.value?.trim() || '';
    const reference = currentRefForPreview();
    if ($('sheetSel') && document.querySelector('input[name=assetKind]')) {
      return {
        kind: 'sprite',
        url: `/api/sprites/${$('sheetSel').value}/prompt-preview`,
        body: { prompt, reference, assetKind: document.querySelector('input[name=assetKind]:checked')?.value || 'sprite' },
      };
    }
    if ($('dirs') && $('frames') && $('cell')) {
      return {
        kind: 'walk',
        url: '/api/walks/prompt-preview',
        body: { prompt, reference, dirs: Number($('dirs').value), frames: Number($('frames').value), cellSize: Number($('cell').value) },
      };
    }
    return null;
  }

  function updateManualPromptMeta() {
    const textarea = $('promptPreviewText');
    const meta = $('promptPreviewMeta');
    if (!textarea || !meta) return;
    meta.textContent = `手动编辑中 · 长度 ${textarea.value.trim().length}/1500 · 生成时将发送此框内容`;
  }

  async function refreshPromptPreview({ force = false } = {}) {
    const textarea = $('promptPreviewText');
    const meta = $('promptPreviewMeta');
    if (!textarea || !meta || !currentProjectId) return;
    if (textarea.dataset.manual === '1' && !force) {
      updateManualPromptMeta();
      return;
    }
    const payload = promptPreviewPayload();
    if (!payload || !payload.body.prompt || payload.url.includes('/undefined/')) {
      textarea.value = '';
      textarea.dataset.manual = '0';
      meta.textContent = '填写提示词后显示最终 prompt。';
      return;
    }
    meta.textContent = '刷新中…';
    try {
      const r = await api(payload.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload.body),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || '预览失败');
      textarea.dataset.manual = '0';
      textarea.value = j.prompt || '';
      meta.textContent = `自动生成 · 长度 ${j.promptLength || 0}/1500 · 参考图：${j.hasReference ? j.referenceSource : 'none'} · 可直接修改后生成`;
    } catch (e) {
      textarea.value = '';
      textarea.dataset.manual = '0';
      meta.textContent = '预览失败：' + (e.message || e);
    }
  }

  function schedulePromptPreview({ force = false } = {}) {
    clearTimeout(promptPreviewTimer);
    promptPreviewTimer = setTimeout(() => refreshPromptPreview({ force }), 180);
  }

  function installPromptPreviewPane() {
    if ($('promptPreviewBox') || !$('prompt')) return;
    const anchor = $('opStatus') || $('status') || $('seed') || $('prompt');
    if (!anchor?.parentElement) return;
    const details = document.createElement('details');
    details.id = 'promptPreviewBox';
    details.className = 'prompt-preview-box';
    details.innerHTML = `
      <summary>查看 / 修改本次将发送给 AI 的最终提示词</summary>
      <div class="prompt-preview-actions">
        <button type="button" class="ghost" id="refreshPromptPreviewBtn">按当前参数重新生成提示词</button>
        <span class="muted">修改下方内容后，生成时会直接发送修改后的文本。</span>
      </div>
      <textarea id="promptPreviewText" placeholder="填写提示词后显示最终 prompt；也可以直接在这里编辑要发给 AI 的内容"></textarea>
      <div id="promptPreviewMeta" class="prompt-preview-meta">填写提示词后显示最终 prompt。</div>`;
    anchor.parentElement.insertBefore(details, anchor.nextSibling);

    const textarea = $('promptPreviewText');
    textarea.dataset.manual = '0';
    textarea.addEventListener('input', () => {
      textarea.dataset.manual = '1';
      updateManualPromptMeta();
    });
    $('refreshPromptPreviewBtn').onclick = () => schedulePromptPreview({ force: true });

    const selectors = ['prompt', 'sheetSel', 'dirs', 'frames', 'cell', 'refUpload'];
    selectors.forEach((id) => {
      const el = $(id);
      if (el) el.addEventListener('input', schedulePromptPreview);
      if (el) el.addEventListener('change', schedulePromptPreview);
    });
    document.querySelectorAll('input[name=assetKind],input[name=ref]').forEach((el) => el.addEventListener('change', schedulePromptPreview));
    document.addEventListener('click', (e) => {
      if (e.target?.closest?.('#subPick,#walkPick')) schedulePromptPreview();
    });
    details.addEventListener('toggle', () => { if (details.open) refreshPromptPreview(); });
    schedulePromptPreview();
  }

  async function init({ requireProject = true } = {}) {
    injectStyle();
    const list = await loadProjects();
    if (!list.length) {
      if (requireProject) showCreateOverlay();
      return '';
    }
    const saved = localStorage.getItem(KEY);
    currentProjectId = list.some((p) => p.id === saved) ? saved : list[0].id;
    localStorage.setItem(KEY, currentProjectId);
    renderBar();
    schedulePromptPreview();
    return currentProjectId;
  }

  document.addEventListener('DOMContentLoaded', () => {
    installSpriteBackgroundKindGuard();
    installCancelableGenerationButtons();
    installPromptPreviewPane();
  });

  window.Project = {
    init,
    id: () => currentProjectId,
    projects: () => projectsCache,
    withProject,
    fetch: api,
  };
})();