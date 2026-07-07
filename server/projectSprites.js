const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { projectDir, touchProject } = require('./projects');

function dir(projectId) { return path.join(projectDir(projectId), 'sprites'); }
function sheetDir(projectId, id) { return path.join(dir(projectId), id); }
function metaFile(projectId, id) { return path.join(sheetDir(projectId, id), 'meta.json'); }
function cellFile(projectId, id, index) { return path.join(sheetDir(projectId, id), 'cells', `${index}.png`); }
function skillFile(projectId, id) { return path.join(sheetDir(projectId, id), 'SKILL.md'); }
function newId() { return crypto.randomBytes(6).toString('hex'); }

async function ensure(projectId) { await fs.mkdir(dir(projectId), { recursive: true }); }

function base64ToBuf(base64) {
  const m = /^data:image\/[a-zA-Z+]+;base64,(.*)$/.exec(base64);
  return Buffer.from(m ? m[1] : base64, 'base64');
}

function normalizeAssetKind(kind) {
  return kind === 'tile' ? 'tile' : (kind === 'sprite' ? 'sprite' : null);
}

function inferAssetKindFromTag(tag) {
  const s = String(tag || '').trim();
  if (s.startsWith('地块：')) return 'tile';
  if (s.startsWith('非地块：')) return 'sprite';
  return null;
}

function cellAssetKind(cell) {
  return normalizeAssetKind(cell?.assetKind) || inferAssetKindFromTag(cell?.tag);
}

async function listSheets(projectId) {
  await ensure(projectId);
  let names = [];
  try { names = await fs.readdir(dir(projectId)); } catch { return []; }
  const out = [];
  for (const id of names) {
    try {
      const meta = JSON.parse(await fs.readFile(metaFile(projectId, id), 'utf8'));
      const stat = await fs.stat(metaFile(projectId, id));
      out.push({ id, name: meta.name, cellSize: meta.cellSize, cols: meta.cols, rows: meta.rows, cellCount: meta.cells.length, filled: meta.cells.filter((c) => c.imageRef).length, updatedAt: stat.mtimeMs });
    } catch { /* skip */ }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

async function getSheet(projectId, id) { return JSON.parse(await fs.readFile(metaFile(projectId, id), 'utf8')); }

async function writeSkill(projectId, id, meta) {
  const lines = [`# 精灵图：${meta.name}`, '', `用途：<待补>　cellSize：${meta.cellSize}x${meta.cellSize}　网格：${meta.cols}x${meta.rows}`, '', '## 格子清单'];
  for (const c of meta.cells) lines.push(`- 格子${c.index}(${c.col},${c.row})：${c.tag || '（空）'}`);
  await fs.writeFile(skillFile(projectId, id), lines.join('\n'));
}

async function createSheet(projectId, { name, cellSize = 32, cols = 8, rows = 8 } = {}) {
  await ensure(projectId);
  const id = newId();
  const cells = [];
  for (let r = 0; r < Number(rows); r++) for (let c = 0; c < Number(cols); c++) cells.push({ index: cells.length, col: c, row: r, imageRef: null, tag: null, assetKind: null });
  const meta = { id, name: name || '未命名精灵图', cellSize: Number(cellSize), cols: Number(cols), rows: Number(rows), cells };
  await fs.mkdir(path.join(sheetDir(projectId, id), 'cells'), { recursive: true });
  await fs.writeFile(metaFile(projectId, id), JSON.stringify(meta, null, 2));
  await writeSkill(projectId, id, meta);
  await touchProject(projectId);
  return meta;
}

async function readCellImage(projectId, id, index) { return fs.readFile(cellFile(projectId, id, index)); }
async function saveCellImage(projectId, id, index, base64) { await fs.writeFile(cellFile(projectId, id, index), base64ToBuf(base64)); }
function findCell(meta, index) { return meta.cells.find((c) => c.index === Number(index)); }

async function applyCell(projectId, id, index, base64, tag, assetKind) {
  const meta = await getSheet(projectId, id);
  const cell = findCell(meta, index);
  if (!cell) throw new Error('CELL_NOT_FOUND');
  await saveCellImage(projectId, id, index, base64);
  cell.imageRef = `cells/${index}.png`;
  if (tag) cell.tag = tag;
  const nextKind = normalizeAssetKind(assetKind) || inferAssetKindFromTag(tag) || cellAssetKind(cell);
  if (nextKind) cell.assetKind = nextKind;
  await fs.writeFile(metaFile(projectId, id), JSON.stringify(meta, null, 2));
  await writeSkill(projectId, id, meta);
  await touchProject(projectId);
  return meta;
}

async function deleteCell(projectId, id, index) {
  const meta = await getSheet(projectId, id);
  const cell = findCell(meta, index);
  if (cell) { cell.imageRef = null; cell.tag = null; cell.assetKind = null; }
  try { await fs.unlink(cellFile(projectId, id, index)); } catch { /* ignore */ }
  await fs.writeFile(metaFile(projectId, id), JSON.stringify(meta, null, 2));
  await writeSkill(projectId, id, meta);
  await touchProject(projectId);
  return meta;
}

async function updateTag(projectId, id, index, tag) {
  const meta = await getSheet(projectId, id);
  const cell = findCell(meta, index);
  if (cell) {
    cell.tag = tag;
    const kind = inferAssetKindFromTag(tag);
    if (kind) cell.assetKind = kind;
  }
  await fs.writeFile(metaFile(projectId, id), JSON.stringify(meta, null, 2));
  await writeSkill(projectId, id, meta);
  await touchProject(projectId);
  return meta;
}

async function firstImageDataUrl(projectId, id) {
  const meta = await getSheet(projectId, id);
  const cell = meta.cells.find((c) => c.imageRef);
  if (!cell) return null;
  const buf = await readCellImage(projectId, id, cell.index);
  return `data:image/png;base64,${buf.toString('base64')}`;
}
function prefix(kind) { return kind === 'tile' ? '地块：' : '非地块：'; }
async function firstImageDataUrlByKind(projectId, id, kind) {
  const meta = await getSheet(projectId, id);
  const cell = meta.cells.find((c) => c.imageRef && (cellAssetKind(c) === kind || (typeof c.tag === 'string' && c.tag.startsWith(prefix(kind)))));
  if (!cell) return null;
  const buf = await readCellImage(projectId, id, cell.index);
  return `data:image/png;base64,${buf.toString('base64')}`;
}
async function firstImageOfAnyOther(projectId, id) {
  for (const s of await listSheets(projectId)) {
    if (s.id === id) continue;
    const u = await firstImageDataUrl(projectId, s.id);
    if (u) return u;
  }
  return null;
}
async function firstImageOfAnyOtherByKind(projectId, id, kind) {
  for (const s of await listSheets(projectId)) {
    if (s.id === id) continue;
    const u = await firstImageDataUrlByKind(projectId, s.id, kind);
    if (u) return u;
  }
  return null;
}

module.exports = { listSheets, getSheet, createSheet, readCellImage, applyCell, deleteCell, updateTag, firstImageDataUrl, firstImageOfAnyOther, firstImageDataUrlByKind, firstImageOfAnyOtherByKind, skillFile };