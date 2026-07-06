const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('./config');

const PROJECTS_ROOT = path.join(DATA_DIR, 'projects');
const PROJECTS_FILE = path.join(PROJECTS_ROOT, 'projects.json');

function newId() {
  return crypto.randomBytes(6).toString('hex');
}

async function ensure() {
  await fs.mkdir(PROJECTS_ROOT, { recursive: true });
}

function projectDir(projectId) {
  if (!projectId || !/^[a-zA-Z0-9_-]+$/.test(projectId)) throw new Error('PROJECT_REQUIRED');
  return path.join(PROJECTS_ROOT, projectId);
}

async function readIndex() {
  await ensure();
  try {
    const raw = await fs.readFile(PROJECTS_FILE, 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data.projects) ? data.projects : [];
  } catch {
    return [];
  }
}

async function writeIndex(projects) {
  await ensure();
  await fs.writeFile(PROJECTS_FILE, JSON.stringify({ projects }, null, 2), 'utf8');
}

async function listProjects() {
  return readIndex();
}

async function createProject({ name } = {}) {
  const projects = await readIndex();
  const id = newId();
  const now = new Date().toISOString();
  const p = { id, name: (name && String(name).trim()) || '未命名项目', createdAt: now, updatedAt: now };
  await fs.mkdir(path.join(projectDir(id), 'sprites'), { recursive: true });
  await fs.mkdir(path.join(projectDir(id), 'walks'), { recursive: true });
  projects.unshift(p);
  await writeIndex(projects);
  return p;
}

async function touchProject(projectId) {
  const projects = await readIndex();
  const p = projects.find((x) => x.id === projectId);
  if (p) {
    p.updatedAt = new Date().toISOString();
    await writeIndex(projects);
  }
}

async function requireProject(projectId) {
  const projects = await readIndex();
  const p = projects.find((x) => x.id === projectId);
  if (!p) throw new Error('PROJECT_NOT_FOUND');
  await fs.mkdir(path.join(projectDir(projectId), 'sprites'), { recursive: true });
  await fs.mkdir(path.join(projectDir(projectId), 'walks'), { recursive: true });
  return p;
}

function projectIdFromReq(req) {
  return req.query.projectId || req.body?.projectId || req.get('x-project-id') || '';
}

module.exports = {
  PROJECTS_ROOT,
  listProjects,
  createProject,
  touchProject,
  requireProject,
  projectDir,
  projectIdFromReq,
};