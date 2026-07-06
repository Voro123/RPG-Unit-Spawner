const express = require('express');
const path = require('path');
const fs = require('fs/promises');
const { getConfig, saveConfig, maskKey } = require('./config');
const minimax = require('./minimax');
const sprites = require('./projectSprites');
const projects = require('./projects');
const walks = require('./walks');

const app = express();
app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const BG_COLOR = '#FFFFFF';
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

function buildPixelPrompt(promptText, ref, assetKind = 'sprite') {
  const kind = normalizeAssetKind(assetKind);
  const rawSubject = clipText(promptText);
  const subject = kind === 'sprite' ? expandSpriteSubject(rawSubject) : rawSubject;

  if (kind === 'tile') {
    let final =
      `Seamless pixel-art terrain/material texture tile for a 2D RPG. Material: ${subject}. ` +
      `This is a texture swatch only, not a map scene. Flat colors, visible square pixels, no blur, no gradients, no photorealism. ` +
      `Fill the entire canvas uniformly edge-to-edge with one continuous repeating material. ` +
      `All four edges and corners must look like the middle of the texture; no edge frame, no corner decoration, no vignette. ` +
      `No objects or clutter: no bushes, vines, cliffs, walls, stones, rocks, flowers, items, props, paths, shadows, characters, text, UI, border, frame, outline, or blank margin. ` +
      `Only tiny color/noise variation that belongs to the requested material is allowed. `;
    if (ref) final += `Reference is style/palette only; ignore its objects, scene layout, edges, corners, border, frame, and clutter. `;
    final += `Final: one clean full-canvas seamless ${rawSubject} texture tile with no extra objects.`;
    return capPrompt(final);
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

function buildWalkPrompt({ prompt, dirs = 4, frames = 3, cellSize = 32, ref }) {
  let out =
    `Pixel art walking animation sprite sheet for a 2D top-down RPG. Character: ${clipText(prompt)}. ` +
    `${Number(dirs) || 4} directions, ${Number(frames) || 3} frames per direction, each frame about ${Number(cellSize) || 32}px. ` +
    `Arrange frames in a clean grid, directions by rows, frames by columns. ` +
    `Consistent character design, same scale, centered in each frame, no text, no UI, no frame borders, no blur, no gradients. ` +
    `Transparent background if possible; otherwise plain solid white background. `;
  if (ref) out += `Reference is for the same character design/style only; preserve identity and outfit while making the walk sheet. `;
  return capPrompt(out);
}

async function requireProjectId(req) {
  const projectId = projects.projectIdFromReq(req);
  await projects.requireProject(projectId);
  return projectId;
}

async function resolveAutoReference(projectId, sheetId, kind) {
  let ref = await sprites.firstImageDataUrlByKind(projectId, sheetId, kind);
  if (!ref) ref = await sprites.firstImageOfAnyOtherByKind(projectId, sheetId, kind);
  if (!ref && kind === 'tile') {
    ref = await sprites.firstImageDataUrl(projectId, sheetId);
    if (!ref) ref = await sprites.firstImageOfAnyOther(projectId, sheetId);
  }
  return ref;
}

// ---------- 项目 ----------
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

// ---------- 配置 ----------
app.get('/api/config', async (req, res) => {
  const c = await getConfig();
  res.json({
    provider: c.provider,
    model: c.model,
    models: minimax.listModels(),
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
  await saveConfig({ provider: 'minimax', api_key: key, model: m, base_url: url });
  res.json({ ok: true });
});

// ---------- 精灵图管理 ----------
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

app.post('/api/sprites/:id/cells/:index/generate', (req, res) => generateCell(req, res));
app.post('/api/sprites/:id/cells/:index/replace', (req, res) => generateCell(req, res));

async function generateCell(req, res) {
  try {
    const projectId = await requireProjectId(req);
    const { id, index } = req.params;
    const { prompt, reference, seed, assetKind } = req.body || {};
    if (!prompt) return res.status(400).json({ error: 'PROMPT_REQUIRED' });
    const kind = normalizeAssetKind(assetKind);
    let ref = reference;
    if (reference === false) ref = null;
    else if (!ref) ref = await resolveAutoReference(projectId, id, kind);

    const cfg = await getConfig();
    const imgs = await minimax.generateImage({ model: cfg.model, prompt: buildPixelPrompt(prompt, ref, kind), referenceImageBase64: ref, seed, promptOptimizer: false });
    if (!imgs.length) return res.status(502).json({ error: 'NO_IMAGE' });
    const tag = `${kind === 'tile' ? '地块' : '非地块'}：${prompt.trim()}`;
    const meta = await sprites.applyCell(projectId, id, index, imgs[0], tag);
    res.json({ ok: true, meta });
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
    const { prompt, reference, seed, width, height, assetKind } = req.body || {};
    if (!prompt) return res.status(400).json({ error: 'PROMPT_REQUIRED' });
    const kind = normalizeAssetKind(assetKind);
    let ref = reference;
    if (reference === false) ref = null;
    else if (!ref) ref = await resolveAutoReference(projectId, req.params.id, kind);
    const cfg = await getConfig();
    const imgs = await minimax.generateImage({ model: cfg.model, prompt: buildPixelPrompt(prompt, ref, kind), referenceImageBase64: ref, seed, width, height, promptOptimizer: false });
    if (!imgs.length) return res.status(502).json({ error: 'NO_IMAGE' });
    res.json({ image: imgs[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- 行走图 ----------
app.get('/api/walks', async (req, res) => {
  try {
    const projectId = await requireProjectId(req);
    res.json(await walks.listWalks(projectId));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/walks/:id/image', async (req, res) => {
  try {
    const projectId = await requireProjectId(req);
    const buf = await walks.readWalkImage(projectId, req.params.id);
    res.set('Cache-Control', 'no-store');
    res.type('png').send(buf);
  } catch {
    res.status(404).end();
  }
});

app.post('/api/walks/generate', async (req, res) => {
  try {
    const projectId = await requireProjectId(req);
    const { prompt, reference, seed, dirs, frames, cellSize } = req.body || {};
    if (!prompt) return res.status(400).json({ error: 'PROMPT_REQUIRED' });
    let ref = reference;
    if (reference === false) ref = null;
    else if (!ref) ref = await walks.firstWalkDataUrl(projectId);
    const cfg = await getConfig();
    const finalPrompt = buildWalkPrompt({ prompt, dirs, frames, cellSize, ref });
    const imgs = await minimax.generateImage({ model: cfg.model, prompt: finalPrompt, referenceImageBase64: ref, seed, promptOptimizer: false });
    if (!imgs.length) return res.status(502).json({ error: 'NO_IMAGE' });
    const meta = await walks.saveWalk(projectId, { name: clipText(prompt, 40), prompt, dirs, frames, cellSize, imageBase64: imgs[0] });
    res.json({ ok: true, meta, image: imgs[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- 通用生成（保留兼容） ----------
app.post('/api/generate', async (req, res) => {
  try {
    const { prompt, reference, seed, n, assetKind } = req.body || {};
    if (!prompt) return res.status(400).json({ error: 'PROMPT_REQUIRED' });
    const kind = normalizeAssetKind(assetKind);
    const cfg = await getConfig();
    const imgs = await minimax.generateImage({ model: cfg.model, prompt: buildPixelPrompt(prompt, reference, kind), referenceImageBase64: reference, seed, n, promptOptimizer: false });
    res.json({ images: imgs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`rpg-unit-spawner running at http://localhost:${PORT}`));