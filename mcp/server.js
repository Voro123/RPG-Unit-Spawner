#!/usr/bin/env node
const fs = require('fs/promises');
const path = require('path');
const minimax = require('../server/minimax');
const { getConfig, maskKey } = require('../server/config');
const promptBuilder = require('../server/promptBuilder');
const tilePrompt = require('../server/tilePrompt');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_OUTPUT_DIR = path.join(ROOT, 'data', 'mcp-images');
const SERVER_INFO = { name: 'rpg-unit-spawner-minimax', version: '0.1.0' };
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
