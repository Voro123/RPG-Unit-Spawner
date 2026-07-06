(() => {
  const KEY = 'rpg-unit-spawner.projectId';
  let currentProjectId = '';
  let projectsCache = [];

  function $(id) { return document.getElementById(id); }

  function enc(v) { return encodeURIComponent(v || ''); }

  function withProject(url) {
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}projectId=${enc(currentProjectId)}`;
  }

  async function api(url, opt = {}) {
    const method = (opt.method || 'GET').toUpperCase();
    if (method === 'GET' || method === 'HEAD') return fetch(withProject(url), opt);
    let body = opt.body;
    const headers = { ...(opt.headers || {}) };
    if (headers['Content-Type'] === 'application/json' && body) {
      try {
        const json = JSON.parse(body);
        body = JSON.stringify({ ...json, projectId: currentProjectId });
      } catch { /* keep body */ }
    }
    return fetch(url, { ...opt, headers, body });
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
    return currentProjectId;
  }

  window.Project = {
    init,
    id: () => currentProjectId,
    projects: () => projectsCache,
    withProject,
    fetch: api,
  };
})();