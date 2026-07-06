const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('./config');

const SPRITES_DIR = path.join(DATA_DIR, 'sprites');

async function ensure() {
  await fs.mkdir(SPRITES_DIR, { recursive: true });
}
function sheetDir(id) {
  return path.join(SPRITES_DIR, id);
}
function metaFile(id) {
  return path.join(sheetDir(id), 'meta.json');
}
function cellFile(id, index) {
  return path.join(sheetDir(id), 'cells', `${index}.png`);
}
function skillFile(id) {
  return path.join(sheetDir(id), 'SKILL.md');
}
function newId() {
  return crypto.randomBytes(6).toString('hex');
}

async function listSheets() {
  await ensure();
  let dirs = [];
  try {
    dirs = await fs.readdir(SPRITES_DIR);
  } catch {
    return [];
  }
  const out = [];
  for (const id of dirs) {
    try {
      const meta = JSON.parse(await fs.readFile(metaFile(id), 'utf8'));
      const stat = await fs.stat(metaFile(id));
      out.push({
        id,
        name: meta.name,
        cellSize: meta.cellSize,
        cols: meta.cols,
        rows: meta.rows,
        cellCount: meta.cells.length,
        filled: meta.cells.filter((c) => c.imageRef).length,
        updatedAt: stat.mtimeMs,
      });
    } catch {
      /* skip broken */
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

async function getSheet(id) {
  return JSON.parse(await fs.readFile(metaFile(id), 'utf8'));
}

async function createSheet({ name, cellSize = 32, cols = 8, rows = 8 } = {}) {
  await ensure();
  const id = newId();
  const cells = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      cells.push({ index: cells.length, col: c, row: r, imageRef: null, tag: null });
    }
  }
  const meta = {
    id,
    name: name || '未命名精灵图',
    cellSize: Number(cellSize),
    cols: Number(cols),
    rows: Number(rows),
    cells,
  };
  await fs.mkdir(path.join(sheetDir(id), 'cells'), { recursive: true });
  await fs.writeFile(metaFile(id), JSON.stringify(meta, null, 2));
  await writeSkill(id, meta);
  return meta;
}

async function writeSkill(id, meta) {
  const lines = [
    `# 精灵图：${meta.name}`,
    '',
    `用途：<待补>　cellSize：${meta.cellSize}x${meta.cellSize}　网格：${meta.cols}x${meta.rows}`,
    '',
    '## 格子清单',
  ];
  for (const cell of meta.cells) {
    const desc = cell.tag ? cell.tag : '（空）';
    lines.push(`- 格子${cell.index}(${cell.col},${cell.row})：${desc}`);
  }
  await fs.writeFile(skillFile(id), lines.join('\n'));
}

function base64ToBuf(base64) {
  // 支持纯 base64 或 data URL
  const m = /^data:image\/[a-zA-Z+]+;base64,(.*)$/.exec(base64);
  const b = m ? m[1] : base64;
  return Buffer.from(b, 'base64');
}

async function saveCellImage(id, index, base64) {
  await fs.writeFile(cellFile(id, index), base64ToBuf(base64));
}

async function readCellImage(id, index) {
  return fs.readFile(cellFile(id, index));
}

function findCell(meta, index) {
  return meta.cells.find((c) => c.index === Number(index));
}

async function nextEmpty(id) {
  const meta = await getSheet(id);
  return meta.cells.find((c) => !c.imageRef) || null;
}

async function applyCell(id, index, base64, tag) {
  const meta = await getSheet(id);
  const cell = findCell(meta, index);
  if (!cell) throw new Error('CELL_NOT_FOUND');
  await saveCellImage(id, index, base64);
  cell.imageRef = `cells/${index}.png`;
  if (tag) cell.tag = tag;
  await fs.writeFile(metaFile(id), JSON.stringify(meta, null, 2));
  await writeSkill(id, meta);
  return meta;
}

async function deleteCell(id, index) {
  const meta = await getSheet(id);
  const cell = findCell(meta, index);
  if (cell) {
    cell.imageRef = null;
    cell.tag = null;
  }
  try {
    await fs.unlink(cellFile(id, index));
  } catch {
    /* ignore */
  }
  await fs.writeFile(metaFile(id), JSON.stringify(meta, null, 2));
  await writeSkill(id, meta);
  return meta;
}

async function updateTag(id, index, tag) {
  const meta = await getSheet(id);
  const cell = findCell(meta, index);
  if (cell) cell.tag = tag;
  await fs.writeFile(metaFile(id), JSON.stringify(meta, null, 2));
  await writeSkill(id, meta);
  return meta;
}

async function firstImageDataUrl(id) {
  const meta = await getSheet(id);
  const cell = meta.cells.find((c) => c.imageRef);
  if (!cell) return null;
  const buf = await readCellImage(id, cell.index);
  return `data:image/png;base64,${buf.toString('base64')}`;
}

async function firstImageOfAnyOther(id) {
  const sheets = await listSheets();
  for (const s of sheets) {
    if (s.id === id) continue;
    const dataUrl = await firstImageDataUrl(s.id);
    if (dataUrl) return dataUrl;
  }
  return null;
}

module.exports = {
  SPRITES_DIR,
  listSheets,
  getSheet,
  createSheet,
  saveCellImage,
  readCellImage,
  nextEmpty,
  applyCell,
  deleteCell,
  updateTag,
  firstImageDataUrl,
  firstImageOfAnyOther,
  skillFile,
};
