#!/usr/bin/env node
const fs = require('fs/promises');
const path = require('path');
const { PNG } = require('pngjs');
const minimax = require('../server/minimax');
const { getConfig, maskKey } = require('../server/config');
const promptBuilder = require('../server/promptBuilder');
const tilePrompt = require('../server/tilePrompt');
const projects = require('../server/projects');
const sprites = require('../server/projectSprites');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_OUTPUT_DIR = path.join(ROOT, 'data', 'mcp-images');
const SERVER_INFO = { name: 'rpg-unit-spawner-minimax', version: '0.3.0' };
const PROTOCOL_VERSION = '2025-06-18';

function isInsideRoot(target) {
  const relative = path.relative(ROOT, target);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveOutputDir(outputDir) {
  const dir = outputDir ? path.resolve(ROOT, String(outputDir)) : DEFAULT_OUTPUT_DIR;
  if (!isInsideRoot(dir)) throw new Error('OUTPUT_DIR_OUTSIDE_PROJECT');
  return dir;
}

function cleanFilePart(value, fallback) {
  const s = String(value || '').trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return (s || fallback).slice(0, 80);
}

function dataUrlToBase64(value) {
  const s = String(value || '').trim();
  const m = /^data:image\/[a-zA-Z+.-]+;base64,(.*)$/.exec(s);
  return m ? m[1] : s;
}

async function saveImages(images, { outputDir, fileNamePrefix } = {}) {
  const dir = resolveOutputDir(outputDir);
  await fs.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const prefix = cleanFilePart(fileNamePrefix, 'minimax-image');
  const files = [];
  for (let i = 0; i < images.length; i += 1) {
    const file = path.join(dir, `${prefix}-${stamp}-${i + 1}.png`);
    await fs.writeFile(file, Buffer.from(dataUrlToBase64(images[i]), 'base64'));
    files.push(file);
  }
  return files;
}

function imageRequestPreview(args) {
  return {
    endpoint: '/v1/image_generation',
    body: minimax.redactImageRequest(minimax.buildImageRequestBody(args)),
  };
}

function toolContentText(value) {
  return { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) };
}

function okResult(content, structuredContent) {
  return { content, structuredContent };
}

function errorResult(error) {
  return { isError: true, content: [toolContentText({ error: error.message || String(error) })] };
}

function requirePrompt(args) {
  const prompt = String(args?.prompt || '').trim();
  const finalPrompt = String(args?.finalPrompt || '').trim();
  if (!prompt && !finalPrompt) throw new Error('PROMPT_REQUIRED');
  return { prompt, finalPrompt };
}

function requireValue(args, key) {
  const value = String(args?.[key] || '').trim();
  if (!value) throw new Error(`${key.toUpperCase()}_REQUIRED`);
  return value;
}

function cellImagePath(projectId, sheetId, cellIndex) {
  return path.join(projects.projectDir(projectId), 'sprites', sheetId, 'cells', `${Number(cellIndex)}.png`);
}

function sheetSkillPath(projectId, sheetId) {
  return path.join(projects.projectDir(projectId), 'sprites', sheetId, 'SKILL.md');
}

function serializeSheet(projectId, sheet) {
  return {
    ...sheet,
    cells: (sheet.cells || []).map((cell) => ({
      ...cell,
      imagePath: cell.imageRef ? cellImagePath(projectId, sheet.id, cell.index) : null,
    })),
  };
}

function cellDescription(cell) {
  const tag = String(cell.tag || '').trim();
  if (tag) return tag;
  if (cell.imageRef) return 'filled cell, role not documented yet';
  return 'empty';
}

function buildSheetSkill(project, sheet) {
  const filled = (sheet.cells || []).filter((cell) => cell.imageRef);
  const lines = [
    `# Sprite Sheet: ${sheet.name}`,
    '',
    'Use this sheet as a project-scoped RPG asset reference. The table below documents each filled cell so an AI agent can identify the role of every tile or sprite part without inspecting the image manually.',
    '',
    '## Sheet',
    '',
    `- Project: ${project.name} (${project.id})`,
    `- Sheet: ${sheet.name} (${sheet.id})`,
    `- Cell size: ${sheet.cellSize}x${sheet.cellSize}`,
    `- Grid: ${sheet.cols} columns x ${sheet.rows} rows`,
    `- Filled cells: ${filled.length}`,
    '',
    '## Filled Cells',
    '',
  ];

  if (!filled.length) {
    lines.push('- No filled cells yet.');
  } else {
    for (const cell of filled) {
      lines.push(`- Cell ${cell.index} (${cell.col},${cell.row})`);
      lines.push(`  - Role: ${cellDescription(cell)}`);
      lines.push(`  - Asset kind: ${cell.assetKind || 'unknown'}`);
      lines.push(`  - Image: ${cellImagePath(project.id, sheet.id, cell.index)}`);
    }
  }

  lines.push('', '## Empty Cells', '');
  const empty = (sheet.cells || []).filter((cell) => !cell.imageRef);
  if (!empty.length) {
    lines.push('- None.');
  } else {
    lines.push(`- ${empty.length} empty cells are available for future assets.`);
  }

  return `${lines.join('\n')}\n`;
}

async function writeMcpSheetSkill(project, sheet) {
  const content = buildSheetSkill(project, sheet);
  const file = sheetSkillPath(project.id, sheet.id);
  await fs.writeFile(file, content, 'utf8');
  return { file, content };
}

function readPngFromBase64(imageBase64) {
  const buf = Buffer.from(dataUrlToBase64(imageBase64), 'base64');
  try {
    return PNG.sync.read(buf);
  } catch (e) {
    throw new Error(`PNG_DECODE_FAILED: ${e.message}`);
  }
}

function pngToBase64(png) {
  return PNG.sync.write(png).toString('base64');
}

function positiveInt(value, fallback, name) {
  const n = value === undefined || value === null || value === '' ? fallback : Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name}_MUST_BE_POSITIVE_INTEGER`);
  return n;
}

function nonNegativeInt(value, fallback, name) {
  const n = value === undefined || value === null || value === '' ? fallback : Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name}_MUST_BE_NON_NEGATIVE_INTEGER`);
  return n;
}

function regionOrigin(sheet, args) {
  if (args.startCellIndex !== undefined && args.startCellIndex !== null && args.startCellIndex !== '') {
    const index = nonNegativeInt(args.startCellIndex, 0, 'START_CELL_INDEX');
    return { col: index % Number(sheet.cols), row: Math.floor(index / Number(sheet.cols)), index };
  }
  const col = nonNegativeInt(args.startCol, 0, 'START_COL');
  const row = nonNegativeInt(args.startRow, 0, 'START_ROW');
  return { col, row, index: row * Number(sheet.cols) + col };
}

function validateCellRegion(sheet, origin, regionCols, regionRows) {
  const cols = Number(sheet.cols);
  const rows = Number(sheet.rows);
  if (origin.col >= cols || origin.row >= rows) throw new Error('REGION_ORIGIN_OUT_OF_BOUNDS');
  if (origin.col + regionCols > cols || origin.row + regionRows > rows) throw new Error('REGION_OUT_OF_BOUNDS');
}

function slicePngToCellBase64s(source, { cellSize, regionCols, regionRows, sourceX, sourceY, sourceWidth, sourceHeight }) {
  const destWidth = cellSize * regionCols;
  const destHeight = cellSize * regionRows;
  const out = [];

  for (let regionRow = 0; regionRow < regionRows; regionRow += 1) {
    for (let regionCol = 0; regionCol < regionCols; regionCol += 1) {
      const cell = new PNG({ width: cellSize, height: cellSize });
      for (let y = 0; y < cellSize; y += 1) {
        const dy = regionRow * cellSize + y;
        const sy = sourceY + Math.min(sourceHeight - 1, Math.floor((dy * sourceHeight) / destHeight));
        for (let x = 0; x < cellSize; x += 1) {
          const dx = regionCol * cellSize + x;
          const sx = sourceX + Math.min(sourceWidth - 1, Math.floor((dx * sourceWidth) / destWidth));
          const si = (sy * source.width + sx) * 4;
          const di = (y * cellSize + x) * 4;
          cell.data[di] = source.data[si];
          cell.data[di + 1] = source.data[si + 1];
          cell.data[di + 2] = source.data[si + 2];
          cell.data[di + 3] = source.data[si + 3];
        }
      }
      out.push({ regionCol, regionRow, imageBase64: pngToBase64(cell) });
    }
  }

  return out;
}

async function locateProject(args = {}) {
  const projectId = String(args.projectId || '').trim();
  const projectName = String(args.projectName || args.name || '').trim();

  if (projectId) {
    const project = await projects.requireProject(projectId);
    return { project, created: false, matchedBy: 'projectId' };
  }

  const list = await projects.listProjects();
  if (projectName) {
    const lower = projectName.toLowerCase();
    const exact = list.find((p) => String(p.name || '').toLowerCase() === lower);
    if (exact) return { project: exact, created: false, matchedBy: 'exactName' };
    const partial = list.find((p) => String(p.name || '').toLowerCase().includes(lower));
    if (partial) return { project: partial, created: false, matchedBy: 'partialName' };
  }

  if (args.createIfMissing) {
    const project = await projects.createProject({ name: projectName || 'MCP Project' });
    return { project, created: true, matchedBy: 'created' };
  }

  throw new Error('PROJECT_NOT_FOUND');
}

const tools = [
  {
    name: 'minimax_status',
    description: 'Check whether the project has server-side Minimax configuration available. Does not reveal the API key.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'build_rpg_asset_prompt',
    description: 'Build the final English Minimax prompt for an RPG sprite or seamless tile without generating an image.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'User-facing asset request. Chinese and mixed input are allowed for tiles.' },
        assetKind: { type: 'string', enum: ['sprite', 'tile'], default: 'sprite' },
        hasReference: { type: 'boolean', default: false },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_projects',
    description: 'List RPG Unit Spawner projects stored under data/projects.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'locate_project',
    description: 'Find a project by projectId or projectName. Optionally create it if missing.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        projectName: { type: 'string' },
        createIfMissing: { type: 'boolean', default: false },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'create_project',
    description: 'Create a new RPG Unit Spawner project with a sprites directory.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'list_sprite_sheets',
    description: 'List sprite/tile sheets in a project.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        projectName: { type: 'string' },
        createProjectIfMissing: { type: 'boolean', default: false },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'create_sprite_sheet',
    description: 'Create a sprite/tile sheet in a project.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        projectName: { type: 'string' },
        createProjectIfMissing: { type: 'boolean', default: false },
        name: { type: 'string' },
        cellSize: { type: 'integer', minimum: 8, maximum: 256, default: 32 },
        cols: { type: 'integer', minimum: 1, maximum: 64, default: 8 },
        rows: { type: 'integer', minimum: 1, maximum: 64, default: 8 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_sprite_sheet',
    description: 'Read a project sprite/tile sheet, including cell metadata and absolute image paths for filled cells.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        projectName: { type: 'string' },
        sheetId: { type: 'string' },
      },
      required: ['sheetId'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_sprite_cell_image',
    description: 'Read a cell PNG from a project sheet and return it as MCP image content.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        projectName: { type: 'string' },
        sheetId: { type: 'string' },
        cellIndex: { type: 'integer', minimum: 0 },
      },
      required: ['sheetId', 'cellIndex'],
      additionalProperties: false,
    },
  },
  {
    name: 'export_sprite_sheet_skill',
    description: 'Export a readable SKILL.md for a sheet, documenting every filled cell role, coordinates, asset kind, and image path for AI agents.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        projectName: { type: 'string' },
        sheetId: { type: 'string' },
        writeFile: { type: 'boolean', default: true, description: 'When true, overwrite the sheet SKILL.md with the exported documentation.' },
      },
      required: ['sheetId'],
      additionalProperties: false,
    },
  },
  {
    name: 'generate_rpg_asset_image',
    description: 'Generate RPG sprite or tile images through Minimax, using this project prompt rules, and optionally save PNG files inside the repo.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Asset request, e.g. "small health potion" or "fresh anime grass tile".' },
        assetKind: { type: 'string', enum: ['sprite', 'tile'], default: 'sprite' },
        finalPrompt: { type: 'string', description: 'Optional edited final prompt. When provided, it is sent directly instead of rebuilding.' },
        referenceImageBase64: { type: 'string', description: 'Optional image base64 or data URL. For tiles, omit this unless explicitly needed.' },
        seed: { type: ['number', 'string'], description: 'Optional Minimax seed.' },
        n: { type: 'integer', minimum: 1, maximum: 9, default: 1 },
        width: { type: 'integer', minimum: 512, maximum: 2048, description: 'Minimax image width. Tile defaults to 1024 if omitted.' },
        height: { type: 'integer', minimum: 512, maximum: 2048, description: 'Minimax image height. Tile defaults to 1024 if omitted.' },
        saveToFile: { type: 'boolean', default: true },
        outputDir: { type: 'string', description: 'Repo-relative output directory. Defaults to data/mcp-images.' },
        fileNamePrefix: { type: 'string', description: 'Safe file prefix for saved PNGs.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'generate_sprite_cell_image',
    description: 'Generate an RPG sprite/tile image through Minimax and overwrite a specific project sheet cell PNG.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        projectName: { type: 'string' },
        createProjectIfMissing: { type: 'boolean', default: false },
        sheetId: { type: 'string' },
        cellIndex: { type: 'integer', minimum: 0 },
        prompt: { type: 'string' },
        assetKind: { type: 'string', enum: ['sprite', 'tile'], default: 'sprite' },
        finalPrompt: { type: 'string', description: 'Optional edited final prompt. When provided, it is sent directly instead of rebuilding.' },
        referenceImageBase64: { type: 'string' },
        seed: { type: ['number', 'string'] },
        width: { type: 'integer', minimum: 512, maximum: 2048 },
        height: { type: 'integer', minimum: 512, maximum: 2048 },
        tag: { type: 'string', description: 'Optional tag. Defaults to a generated asset tag.' },
      },
      required: ['sheetId', 'cellIndex'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_sprite_cell_image',
    description: 'Overwrite a specific project sheet cell with a supplied PNG/JPEG/WebP base64 image and update metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        projectName: { type: 'string' },
        sheetId: { type: 'string' },
        cellIndex: { type: 'integer', minimum: 0 },
        imageBase64: { type: 'string', description: 'Image data URL or raw base64. It is written over the existing cell PNG.' },
        tag: { type: 'string' },
        assetKind: { type: 'string', enum: ['sprite', 'tile'] },
      },
      required: ['sheetId', 'cellIndex', 'imageBase64'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_sprite_cell_region_image',
    description: 'Place one large PNG image into a rectangular sheet cell region by nearest-neighbor scaling and slicing, overwriting every target cell.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        projectName: { type: 'string' },
        sheetId: { type: 'string' },
        startCellIndex: { type: 'integer', minimum: 0, description: 'Top-left target cell index. Alternative to startCol/startRow.' },
        startCol: { type: 'integer', minimum: 0, default: 0 },
        startRow: { type: 'integer', minimum: 0, default: 0 },
        regionCols: { type: 'integer', minimum: 1, description: 'How many sheet columns the big image should occupy.' },
        regionRows: { type: 'integer', minimum: 1, description: 'How many sheet rows the big image should occupy.' },
        imageBase64: { type: 'string', description: 'PNG image data URL or raw base64. It will be scaled and sliced into cells.' },
        sourceX: { type: 'integer', minimum: 0, default: 0 },
        sourceY: { type: 'integer', minimum: 0, default: 0 },
        sourceWidth: { type: 'integer', minimum: 1, description: 'Optional crop width from the source image. Defaults to source image width - sourceX.' },
        sourceHeight: { type: 'integer', minimum: 1, description: 'Optional crop height from the source image. Defaults to source image height - sourceY.' },
        tagPrefix: { type: 'string', description: 'Optional tag prefix for overwritten cells. If omitted, existing tags are preserved.' },
        cellTags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional row-major per-cell role descriptions. Length should equal regionCols * regionRows. These become the cell tags and exported skill roles.',
        },
        assetKind: { type: 'string', enum: ['sprite', 'tile'] },
      },
      required: ['sheetId', 'regionCols', 'regionRows', 'imageBase64'],
      additionalProperties: false,
    },
  },
  {
    name: 'generate_minimax_image_raw',
    description: 'Generate image(s) with a raw prompt through Minimax. Use this only when project RPG prompt rules are not desired.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        model: { type: 'string', enum: minimax.listModels(), default: 'image-01' },
        referenceImageBase64: { type: 'string' },
        seed: { type: ['number', 'string'] },
        n: { type: 'integer', minimum: 1, maximum: 9, default: 1 },
        width: { type: 'integer', minimum: 512, maximum: 2048, default: 512 },
        height: { type: 'integer', minimum: 512, maximum: 2048, default: 512 },
        promptOptimizer: { type: 'boolean', default: false },
        saveToFile: { type: 'boolean', default: true },
        outputDir: { type: 'string', description: 'Repo-relative output directory. Defaults to data/mcp-images.' },
        fileNamePrefix: { type: 'string' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
];

async function callTool(name, args = {}) {
  try {
    if (name === 'minimax_status') {
      const cfg = await getConfig();
      const status = {
        provider: cfg.provider || 'minimax',
        model: cfg.model || 'image-01',
        baseUrl: cfg.base_url || 'https://api.minimax.io',
        textModel: cfg.text_model || 'MiniMax-Text-01',
        hasKey: !!cfg.api_key,
        apiKeyMask: maskKey(cfg.api_key),
        outputDefault: DEFAULT_OUTPUT_DIR,
      };
      return okResult([toolContentText(status)], status);
    }

    if (name === 'build_rpg_asset_prompt') {
      const { prompt } = requirePrompt(args);
      const kind = promptBuilder.normalizeAssetKind(args.assetKind);
      const finalPrompt = await promptBuilder.buildPixelPrompt(prompt, args.hasReference ? '__reference__' : null, kind);
      const structured = { assetKind: kind, prompt: finalPrompt, promptLength: finalPrompt.length };
      if (kind === 'tile') structured.slots = (await tilePrompt.build(prompt, !!args.hasReference)).slots;
      return okResult([toolContentText(structured)], structured);
    }

    if (name === 'list_projects') {
      const structured = { projects: await projects.listProjects() };
      return okResult([toolContentText(structured)], structured);
    }

    if (name === 'locate_project') {
      const structured = await locateProject({ ...args, createIfMissing: !!args.createIfMissing });
      return okResult([toolContentText(structured)], structured);
    }

    if (name === 'create_project') {
      const project = await projects.createProject({ name: args.name });
      const structured = { project };
      return okResult([toolContentText(structured)], structured);
    }

    if (name === 'list_sprite_sheets') {
      const located = await locateProject({ ...args, createIfMissing: !!args.createProjectIfMissing });
      const sheets = await sprites.listSheets(located.project.id);
      const structured = { project: located.project, createdProject: located.created, sheets };
      return okResult([toolContentText(structured)], structured);
    }

    if (name === 'create_sprite_sheet') {
      const located = await locateProject({ ...args, createIfMissing: !!args.createProjectIfMissing });
      const sheet = await sprites.createSheet(located.project.id, {
        name: args.name,
        cellSize: args.cellSize,
        cols: args.cols,
        rows: args.rows,
      });
      const structured = { project: located.project, createdProject: located.created, sheet: serializeSheet(located.project.id, sheet) };
      return okResult([toolContentText(structured)], structured);
    }

    if (name === 'get_sprite_sheet') {
      const located = await locateProject(args);
      const sheetId = requireValue(args, 'sheetId');
      const sheet = await sprites.getSheet(located.project.id, sheetId);
      const structured = { project: located.project, sheet: serializeSheet(located.project.id, sheet) };
      return okResult([toolContentText(structured)], structured);
    }

    if (name === 'read_sprite_cell_image') {
      const located = await locateProject(args);
      const sheetId = requireValue(args, 'sheetId');
      const cellIndex = Number(args.cellIndex);
      const buf = await sprites.readCellImage(located.project.id, sheetId, cellIndex);
      const imageBase64 = buf.toString('base64');
      const structured = {
        project: located.project,
        sheetId,
        cellIndex,
        imagePath: cellImagePath(located.project.id, sheetId, cellIndex),
        mimeType: 'image/png',
        base64Length: imageBase64.length,
      };
      return okResult([toolContentText(structured), { type: 'image', data: imageBase64, mimeType: 'image/png' }], structured);
    }

    if (name === 'export_sprite_sheet_skill') {
      const located = await locateProject(args);
      const sheetId = requireValue(args, 'sheetId');
      const sheet = await sprites.getSheet(located.project.id, sheetId);
      const content = buildSheetSkill(located.project, sheet);
      const file = sheetSkillPath(located.project.id, sheetId);
      if (args.writeFile !== false) await fs.writeFile(file, content, 'utf8');
      const structured = {
        project: located.project,
        sheetId,
        skillFile: file,
        wroteFile: args.writeFile !== false,
        content,
      };
      return okResult([toolContentText(structured)], structured);
    }

    if (name === 'generate_rpg_asset_image') {
      const { prompt, finalPrompt } = requirePrompt(args);
      const kind = promptBuilder.normalizeAssetKind(args.assetKind);
      const cfg = await getConfig();
      const customPrompt = promptBuilder.promptFromClient(finalPrompt);
      const reference = args.referenceImageBase64 ? dataUrlToBase64(args.referenceImageBase64) : null;
      const promptToSend = customPrompt || await promptBuilder.buildPixelPrompt(prompt, reference, kind);
      const requestArgs = promptBuilder.imageArgs({
        cfg,
        prompt: promptToSend,
        referenceImageBase64: reference,
        seed: args.seed,
        n: args.n,
        kind,
        width: args.width,
        height: args.height,
      });
      const images = await minimax.generateImage(requestArgs);
      if (!images.length) throw new Error('NO_IMAGE');
      const savedFiles = args.saveToFile === false ? [] : await saveImages(images, {
        outputDir: args.outputDir,
        fileNamePrefix: args.fileNamePrefix || `${kind}-${prompt || 'asset'}`,
      });
      const structured = {
        images: images.map((imageBase64, index) => ({ index, mimeType: 'image/png', savedFile: savedFiles[index] || null, base64Length: imageBase64.length })),
        prompt: promptToSend,
        promptLength: promptToSend.length,
        assetKind: kind,
        minimaxRequest: imageRequestPreview(requestArgs),
      };
      const content = [toolContentText(structured)];
      for (const imageBase64 of images) content.push({ type: 'image', data: dataUrlToBase64(imageBase64), mimeType: 'image/png' });
      return okResult(content, structured);
    }

    if (name === 'generate_sprite_cell_image') {
      const located = await locateProject({ ...args, createIfMissing: !!args.createProjectIfMissing });
      const sheetId = requireValue(args, 'sheetId');
      const cellIndex = Number(args.cellIndex);
      const { prompt, finalPrompt } = requirePrompt(args);
      const kind = promptBuilder.normalizeAssetKind(args.assetKind);
      const cfg = await getConfig();
      const customPrompt = promptBuilder.promptFromClient(finalPrompt);
      const reference = args.referenceImageBase64 ? dataUrlToBase64(args.referenceImageBase64) : null;
      const promptToSend = customPrompt || await promptBuilder.buildPixelPrompt(prompt, reference, kind);
      const requestArgs = promptBuilder.imageArgs({
        cfg,
        prompt: promptToSend,
        referenceImageBase64: reference,
        seed: args.seed,
        n: 1,
        kind,
        width: args.width,
        height: args.height,
      });
      const images = await minimax.generateImage(requestArgs);
      if (!images.length) throw new Error('NO_IMAGE');
      const tag = String(args.tag || '').trim() || `${kind}: ${prompt || customPrompt}`;
      const meta = await sprites.applyCell(located.project.id, sheetId, cellIndex, images[0], tag, kind);
      const skill = await writeMcpSheetSkill(located.project, meta);
      const imageBase64 = dataUrlToBase64(images[0]);
      const structured = {
        project: located.project,
        createdProject: located.created,
        sheet: serializeSheet(located.project.id, meta),
        cellIndex,
        imagePath: cellImagePath(located.project.id, sheetId, cellIndex),
        prompt: promptToSend,
        promptLength: promptToSend.length,
        assetKind: kind,
        skillFile: skill.file,
        minimaxRequest: imageRequestPreview(requestArgs),
      };
      return okResult([toolContentText(structured), { type: 'image', data: imageBase64, mimeType: 'image/png' }], structured);
    }

    if (name === 'update_sprite_cell_image') {
      const located = await locateProject(args);
      const sheetId = requireValue(args, 'sheetId');
      const cellIndex = Number(args.cellIndex);
      const imageBase64 = requireValue(args, 'imageBase64');
      const kind = args.assetKind ? promptBuilder.normalizeAssetKind(args.assetKind) : undefined;
      const meta = await sprites.applyCell(located.project.id, sheetId, cellIndex, imageBase64, args.tag, kind);
      const skill = await writeMcpSheetSkill(located.project, meta);
      const structured = {
        project: located.project,
        sheet: serializeSheet(located.project.id, meta),
        cellIndex,
        imagePath: cellImagePath(located.project.id, sheetId, cellIndex),
        assetKind: kind || null,
        skillFile: skill.file,
      };
      return okResult([toolContentText(structured)], structured);
    }

    if (name === 'update_sprite_cell_region_image') {
      const located = await locateProject(args);
      const sheetId = requireValue(args, 'sheetId');
      const sheet = await sprites.getSheet(located.project.id, sheetId);
      const cellSize = Number(sheet.cellSize);
      const regionCols = positiveInt(args.regionCols, null, 'REGION_COLS');
      const regionRows = positiveInt(args.regionRows, null, 'REGION_ROWS');
      const origin = regionOrigin(sheet, args);
      validateCellRegion(sheet, origin, regionCols, regionRows);

      const source = readPngFromBase64(requireValue(args, 'imageBase64'));
      const sourceX = nonNegativeInt(args.sourceX, 0, 'SOURCE_X');
      const sourceY = nonNegativeInt(args.sourceY, 0, 'SOURCE_Y');
      if (sourceX >= source.width || sourceY >= source.height) throw new Error('SOURCE_CROP_ORIGIN_OUT_OF_BOUNDS');
      const sourceWidth = positiveInt(args.sourceWidth, source.width - sourceX, 'SOURCE_WIDTH');
      const sourceHeight = positiveInt(args.sourceHeight, source.height - sourceY, 'SOURCE_HEIGHT');
      if (sourceX + sourceWidth > source.width || sourceY + sourceHeight > source.height) throw new Error('SOURCE_CROP_OUT_OF_BOUNDS');

      const kind = args.assetKind ? promptBuilder.normalizeAssetKind(args.assetKind) : undefined;
      const tagPrefix = String(args.tagPrefix || '').trim();
      const cellTags = Array.isArray(args.cellTags) ? args.cellTags.map((tag) => String(tag || '').trim()) : [];
      if (cellTags.length && cellTags.length !== regionCols * regionRows) throw new Error('CELL_TAGS_LENGTH_MUST_EQUAL_REGION_AREA');
      const slices = slicePngToCellBase64s(source, { cellSize, regionCols, regionRows, sourceX, sourceY, sourceWidth, sourceHeight });
      let meta = sheet;
      const updatedCells = [];
      for (const slice of slices) {
        const col = origin.col + slice.regionCol;
        const row = origin.row + slice.regionRow;
        const cellIndex = row * Number(sheet.cols) + col;
        const tagIndex = slice.regionRow * regionCols + slice.regionCol;
        const tag = cellTags[tagIndex] || (tagPrefix ? `${tagPrefix} part (${slice.regionCol},${slice.regionRow})` : undefined);
        meta = await sprites.applyCell(located.project.id, sheetId, cellIndex, slice.imageBase64, tag, kind);
        updatedCells.push({
          cellIndex,
          col,
          row,
          imagePath: cellImagePath(located.project.id, sheetId, cellIndex),
          tag: tag || null,
        });
      }
      const skill = await writeMcpSheetSkill(located.project, meta);

      const structured = {
        project: located.project,
        sheet: serializeSheet(located.project.id, meta),
        origin,
        regionCols,
        regionRows,
        source: { width: source.width, height: source.height, sourceX, sourceY, sourceWidth, sourceHeight },
        scaledSize: { width: cellSize * regionCols, height: cellSize * regionRows },
        cellSize,
        updatedCells,
        assetKind: kind || null,
        skillFile: skill.file,
      };
      return okResult([toolContentText(structured)], structured);
    }

    if (name === 'generate_minimax_image_raw') {
      const { prompt } = requirePrompt(args);
      const cfg = await getConfig();
      const requestArgs = {
        model: args.model || cfg.model || 'image-01',
        prompt,
        referenceImageBase64: args.referenceImageBase64 ? dataUrlToBase64(args.referenceImageBase64) : null,
        seed: args.seed,
        n: args.n,
        promptOptimizer: !!args.promptOptimizer,
        width: args.width,
        height: args.height,
      };
      const images = await minimax.generateImage(requestArgs);
      if (!images.length) throw new Error('NO_IMAGE');
      const savedFiles = args.saveToFile === false ? [] : await saveImages(images, {
        outputDir: args.outputDir,
        fileNamePrefix: args.fileNamePrefix || 'raw-minimax-image',
      });
      const structured = {
        images: images.map((imageBase64, index) => ({ index, mimeType: 'image/png', savedFile: savedFiles[index] || null, base64Length: imageBase64.length })),
        prompt,
        promptLength: prompt.length,
        minimaxRequest: imageRequestPreview(requestArgs),
      };
      const content = [toolContentText(structured)];
      for (const imageBase64 of images) content.push({ type: 'image', data: dataUrlToBase64(imageBase64), mimeType: 'image/png' });
      return okResult(content, structured);
    }

    throw new Error(`UNKNOWN_TOOL: ${name}`);
  } catch (e) {
    return errorResult(e);
  }
}

function response(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function errorResponse(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

async function handle(message) {
  if (!message || typeof message !== 'object') return null;
  if (message.id === undefined) return null;

  switch (message.method) {
    case 'initialize':
      return response(message.id, {
        protocolVersion: message.params?.protocolVersion || PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case 'ping':
      return response(message.id, {});
    case 'tools/list':
      return response(message.id, { tools });
    case 'tools/call': {
      const { name, arguments: toolArgs } = message.params || {};
      return response(message.id, await callTool(name, toolArgs || {}));
    }
    default:
      return errorResponse(message.id, -32601, `Method not found: ${message.method}`);
  }
}

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

let buffer = '';
function onJsonLine(line) {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch (e) {
    writeMessage(errorResponse(null, -32700, `Parse error: ${e.message}`));
    return;
  }
  handle(message)
    .then((out) => { if (out) writeMessage(out); })
    .catch((e) => writeMessage(errorResponse(message.id, -32603, e.message)));
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    onJsonLine(line);
  }
});

process.stdin.on('end', () => {
  if (buffer.trim()) onJsonLine(buffer);
});
