const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { projectDir, touchProject } = require('./projects');

function newId() {
  return crypto.randomBytes(6).toString('hex');
}

function walksDir(projectId) {
  return path.join(projectDir(projectId), 'walks');
}

function walkDir(projectId, id) {
  return path.join(walksDir(projectId), id);
}

function metaFile(projectId, id) {
  return path.join(walkDir(projectId, id), 'meta.json');
}

function imageFile(projectId, id) {
  return path.join(walkDir(projectId, id), 'walk.png');
}

function base64ToBuf(base64) {
  const m = /^data:image\/[a-zA-Z+]+;base64,(.*)$/.exec(base64);
  const b = m ? m[1] : base64;
  return Buffer.from(b, 'base64');
}

async function ensure(projectId) {
  await fs.mkdir(walksDir(projectId), { recursive: true });
}

async function readMeta(projectId, id) {
  return JSON.parse(await fs.readFile(metaFile(projectId, id), 'utf8'));
}

async function writeMeta(projectId, id, meta) {
  await fs.writeFile(metaFile(projectId, id), JSON.stringify(meta, null, 2), 'utf8');
  await touchProject(projectId);
  return meta;
}

async function listWalks(projectId) {
  await ensure(projectId);
  let dirs = [];
  try { dirs = await fs.readdir(walksDir(projectId)); } catch { return []; }
  const out = [];
  for (const id of dirs) {
    try {
      const meta = await readMeta(projectId, id);
      const stat = await fs.stat(metaFile(projectId, id));
      out.push({ ...meta, updatedAt: stat.mtimeMs });
    } catch { /* skip broken */ }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

async function saveWalk(projectId, { name, prompt, dirs, frames, cellSize, imageBase64 } = {}) {
  await ensure(projectId);
  const id = newId();
  const dir = walkDir(projectId, id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(imageFile(projectId, id), base64ToBuf(imageBase64));
  const meta = {
    id,
    name: name || prompt || '未命名行走图',
    prompt: prompt || '',
    dirs: Number(dirs) || 4,
    frames: Number(frames) || 3,
    cellSize: Number(cellSize) || 32,
    imageRef: 'walk.png',
    createdAt: new Date().toISOString(),
  };
  await writeMeta(projectId, id, meta);
  return meta;
}

async function renameWalk(projectId, id, name) {
  const meta = await readMeta(projectId, id);
  const nextName = String(name || '').trim();
  if (!nextName) throw new Error('NAME_REQUIRED');
  meta.name = nextName.slice(0, 80);
  meta.updatedAt = new Date().toISOString();
  return writeMeta(projectId, id, meta);
}

async function deleteWalk(projectId, id) {
  await fs.rm(walkDir(projectId, id), { recursive: true, force: true });
  await touchProject(projectId);
  return { ok: true, id };
}

async function readWalkImage(projectId, id) {
  return fs.readFile(imageFile(projectId, id));
}

async function firstWalkDataUrl(projectId) {
  const list = await listWalks(projectId);
  if (!list.length) return null;
  const buf = await readWalkImage(projectId, list[0].id);
  return `data:image/png;base64,${buf.toString('base64')}`;
}

module.exports = { listWalks, saveWalk, renameWalk, deleteWalk, readWalkImage, firstWalkDataUrl };