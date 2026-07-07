const express = require('express');
const path = require('path');
const fs = require('fs/promises');
const { getConfig, saveConfig, maskKey } = require('./config');
const minimax = require('./minimax');
const tilePrompt = require('./tilePrompt');
const sprites = require('./projectSprites');
const projects = require('./projects');

const app = express();
app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const BG_COLOR = '#FFFFFF';
const TILE_IMAGE_SIZE = 1024;
const MAX_MINIMAX_PROMPT_CHARS = 1400;
const MAX_SUBJECT_CHARS = 260;

function normalizeAssetKind(assetKind) {
  return assetKind === 'tile' ? 'tile' : 'sprite';
}

function clipText(text, maxLen = MAX_SUBJECT_CHARS) {
  const s = String(text || '').trim().replace(/\s+/g, ' ');
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

function expandSpriteSubject(subject) {
  const s = clipText(subject);
  if (/^(花|花朵|小花|flower|flowers)$/i.test(s)) {
    return `${s}, one large blooming flower, clear petals, center, short stem, two leaves`;
  }
  return s;
}

function capPrompt(prompt) {
  return prompt.length > MAX_MINIMAX_PROMPT_CHARS ? prompt.slice(0, MAX_MINIMAX_PROMPT_CHARS) : prompt;
}

function promptFromClient(finalPrompt) {
  const p = String(finalPrompt || '').trim();
  return p ? capPrompt(p) : null;
}

function imageArgs({ cfg, prompt, referenceImageBase64, seed, n, kind, width, height }) {
  const isTile = normalizeAssetKind(kind) === 'tile';
  const w = Number(width);
  const h = Number(height);
  return {
    model: cfg.model,
    prompt,
    referenceImageBase64,
    seed,
    n,
    promptOptimizer: false,
    width: isTile ? (w >= 512 ? w : TILE_IMAGE_SIZE) : width,
    height: isTile ? (h >= 512 ? h : TILE_IMAGE_SIZE) : height,
  };
}

function requestPreview(args) {
  return {
    endpoint: '/v1/image_generation',
    body: minimax.redactImageRequest(minimax.buildImageRequestBody(args)),
  };
}

async function buildPixelPrompt(promptText, ref, assetKind = 'sprite') {
  const kind = normalizeAssetKind(assetKind);
  const rawSubject = clipText(promptText);
  const subject = kind === 'sprite' ? expandSpriteSubject(rawSubject) : rawSubject;

  if (kind === 'tile') {
    return (await tilePrompt.build(promptText, !!ref)).prompt;
  }

  let final =
    `Pixel art for 2D top-down RPG. Subject: ${subject}. ` +
    `Flat colors, visible square pixels, no blur, no gradients, no photorealism. ` +
    `Type: STANDALONE SPRITE, not a tile. Draw exactly one large centered subject occupying 60-80% of canvas, readable at 32x32. ` +
    `Subject must have visible colored details; never output blank background only. ` +
    `For flowers/plants: visible petals, center, stem, leaves. ` +
    `No ground, dirt, grass patch, floor tile, shadow, base, platform, border, frame, full-canvas texture, text. ` +
    `Plain solid white background ${BG_COLOR}. Drawing the subject is more important than perfect background. `;

  if (ref) final += `Reference is style/palette only; do not copy its subject, layout, background, border, ground, or texture. `;
  final += `Final: one large visible ${rawSubject} sprite centered on white background.`;
  return capPrompt(final);
}

async function requireProjectId(req) {
  const projectId = projects.projectIdFromReq(req);
  await projects.requireProject(projectId);
  return projectId;
}

async function resolveAutoReference(projectId, sheetId, kind) {
  if (kind === 'tile') return null;

  let ref = await sprites.firstImageDataUrlByKind(projectId, sheetId, kind);
  if (!ref) ref = await sprites.firstImageOfAnyOtherByKind(projectId, sheetId, kind);
  return ref;
}

function explicitReferenceMarker(reference) {
  return reference ? '__explicit_reference_selected__' : null;
}

app.get('/api/projects', async (req, res) => {
  res.json(await projects.listProjects());
});

app.post('/api/projects', async (req, res) => {
  try {
    res.json(await projects.createProject(req.body || {}));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/config', async (req, res) => {
  const c = await getConfig();
  res.json({
    provider: c.provider,
    model: c.model,
    models: minimax.listModels(),
    textModels: minimax.listTextModels ? minimax.listTextModels() : [],
    baseUrl: c.base_url || 'https://api.minimax.io',
    hasKey: !!c.api_key,
    apiKeyMask: maskKey(c.api_key),
  });
});

app.post('/api/config/test', async (req, res) => {
  const r = await minimax.validateKey();
  res.json(r);
});

app.post('/api/config', async (req, res) => {
  const cur = await getConfig();
  const { api_key, model, base_url } = req.body || {};
  if (model && !minimax.listModels().includes(model)) return res.status(400).json({ error: 'INVALID_MODEL' });
  const key = (api_key && api_key.trim()) || cur.api_key || '';
  const m = model || cur.model || 'image-01';
  const url = base_url && base_url.trim() ? base_url.trim() : (cur.base_url || 'https://api.minimax.io');
  await saveConfig({ provider: 'minimax', api_key: key, model: m, base_url: url, text_model: cur.text_model || 'MiniMax-Text-01' });
  res.json({ ok: true });
});

app.get('/api/sprites', async (req, res) => {
  try {
    const projectId = await requireProjectId(req);
    res.json(await sprites.listSheets(projectId));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/sprites', async (req, res) => {
  try {
    const projectId = await requireProjectId(req);
    const { name, cellSize, cols, rows } = req.body || {};
    res.json(await sprites.createSheet(projectId, { name, cellSize, cols, rows }));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/sprites/:id', async (req, res) => {
  try {
    const projectId = await requireProjectId(req);
    res.json(await sprites.getSheet(projectId, req.params.id));
  } catch {
    res.status(404).json({ error: 'NOT_FOUND' });
  }
});

app.get('/api/sprites/:id/cells/:index', async (req, res) => {
  try {
    const projectId = await requireProjectId(req);
    const buf = await sprites.readCellImage(projectId, req.params.id, req.params.index);
    res.set('Cache-Control', 'no-store');
    res.type('png').send(buf);
  } catch {
    res.status(404).end();
  }
});

app.get('/api/sprites/:id/skill', async (req, res) => {
  try {
    const projectId = await requireProjectId(req);
    const t = await fs.readFile(sprites.skillFile(projectId, req.params.id), 'utf8');
    res.type('markdown').send(t);
  } catch {
    res.status(404).end();
  }
});

app.post('/api/sprites/:id/prompt-preview', async (req, res) => {
  try {
    const projectId = await requireProjectId(req);
    const { prompt, reference, assetKind } = req.body || {};
    if (!prompt) return res.json({ ok: true, prompt: '', promptLength: 0, hasReference: false, referenceSource: 'none' });
    const kind = normalizeAssetKind(assetKind);
    let ref = explicitReferenceMarker(reference);
    let referenceSource = ref ? 'explicit' : 'none';
    if (reference === false) {
      ref = null;
      referenceSource = 'none';
    } else if (!ref) {
      ref = await resolveAutoReference(projectId, req.params.id, kind);
      referenceSource = ref ? 'auto' : 'none';
    }
    let slots = null;
    let finalPrompt;
    if (kind === 'tile') {
      const built = await tilePrompt.build(prompt, !!ref);
      finalPrompt = built.prompt;
      slots = built.slots;
    } else {
      finalPrompt = await buildPixelPrompt(prompt, ref, kind);
    }
    const cfg = await getConfig();
    const args = imageArgs({ cfg, prompt: finalPrompt, referenceImageBase64: ref, kind });
    res.json({ ok: true, prompt: finalPrompt, promptLength: finalPrompt.length, assetKind: kind, hasReference: !!ref, referenceSource, slots, minimaxRequest: requestPreview(args) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/sprites/:id/cells/:index/generate', (req, res) => generateCell(req, res));
app.post('/api/sprites/:id/cells/:index/replace', (req, res) => generateCell(req, res));

async function generateCell(req, res) {
  try {
    const projectId = await requireProjectId(req);
    const { id, index } = req.params;
    const { prompt, reference, seed, assetKind, finalPrompt } = req.body || {};
    const customPrompt = promptFromClient(finalPrompt);
    if (!prompt && !customPrompt) return res.status(400).json({ error: 'PROMPT_REQUIRED' });
    const kind = normalizeAssetKind(assetKind);
    let ref = reference;
    if (reference === false) ref = null;
    else if (!ref) ref = await resolveAutoReference(projectId, id, kind);

    const cfg = await getConfig();
    const promptToSend = customPrompt || await buildPixelPrompt(prompt, ref, kind);
    const args = imageArgs({ cfg, prompt: promptToSend, referenceImageBase64: ref, seed, kind });
    const imgs = await minimax.generateImage(args);
    if (!imgs.length) return res.status(502).json({ error: 'NO_IMAGE' });
    const tag = `${kind === 'tile' ? '地块' : '非地块'}：${(prompt || customPrompt).trim()}`;
    const meta = await sprites.applyCell(projectId, id, index, imgs[0], tag);
    res.json({ ok: true, meta, prompt: promptToSend, promptLength: promptToSend.length, minimaxRequest: requestPreview(args) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

app.delete('/api/sprites/:id/cells/:index', async (req, res) => {
  try {
    const projectId = await requireProjectId(req);
    const meta = await sprites.deleteCell(projectId, req.params.id, req.params.index);
    res.json({ ok: true, meta });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/sprites/:id/cells/:index/tag', async (req, res) => {
  try {
    const projectId = await requireProjectId(req);
    const { tag } = req.body || {};
    const meta = await sprites.updateTag(projectId, req.params.id, req.params.index, tag);
    res.json({ ok: true, meta });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/sprites/:id/cells/:index/image', async (req, res) => {
  try {
    const projectId = await requireProjectId(req);
    const { image, tag } = req.body || {};
    if (!image) return res.status(400).json({ error: 'NO_IMAGE' });
    const meta = await sprites.applyCell(projectId, req.params.id, req.params.index, image, tag);
    res.json({ ok: true, meta });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/sprites/:id/generate-raw', async (req, res) => {
  try {
    const projectId = await requireProjectId(req);
    const { prompt, reference, seed, width, height, assetKind, finalPrompt } = req.body || {};
    const customPrompt = promptFromClient(finalPrompt);
    if (!prompt && !customPrompt) return res.status(400).json({ error: 'PROMPT_REQUIRED' });
    const kind = normalizeAssetKind(assetKind);
    let ref = reference;
    if (reference === false) ref = null;
    else if (!ref) ref = await resolveAutoReference(projectId, req.params.id, kind);
    const cfg = await getConfig();
    const promptToSend = customPrompt || await buildPixelPrompt(prompt, ref, kind);
    const args = imageArgs({ cfg, prompt: promptToSend, referenceImageBase64: ref, seed, width, height, kind });
    const imgs = await minimax.generateImage(args);
    if (!imgs.length) return res.status(502).json({ error: 'NO_IMAGE' });
    res.json({ image: imgs[0], prompt: promptToSend, promptLength: promptToSend.length, minimaxRequest: requestPreview(args) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/generate', async (req, res) => {
  try {
    const { prompt, reference, seed, n, assetKind, finalPrompt } = req.body || {};
    const customPrompt = promptFromClient(finalPrompt);
    if (!prompt && !customPrompt) return res.status(400).json({ error: 'PROMPT_REQUIRED' });
    const kind = normalizeAssetKind(assetKind);
    const cfg = await getConfig();
    const promptToSend = customPrompt || await buildPixelPrompt(prompt, reference, kind);
    const args = imageArgs({ cfg, prompt: promptToSend, referenceImageBase64: reference, seed, n, kind });
    const imgs = await minimax.generateImage(args);
    res.json({ images: imgs, prompt: promptToSend, promptLength: promptToSend.length, minimaxRequest: requestPreview(args) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`rpg-unit-spawner running at http://localhost:${PORT}`));