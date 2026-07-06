const express = require('express');
const path = require('path');
const fs = require('fs/promises');
const { getConfig, saveConfig, maskKey } = require('./config');
const minimax = require('./minimax');
const sprites = require('./sprites');

const app = express();
app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// 非地块素材使用纯白背景，方便和主体区分，也便于后续去背。
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

// 像素风强制约束（短模板）。MINIMAX prompt 必须 <1500 chars，所以这里强制压缩并截断。
function buildPixelPrompt(promptText, ref, assetKind = 'sprite') {
  const kind = normalizeAssetKind(assetKind);
  const rawSubject = clipText(promptText);
  const subject = kind === 'sprite' ? expandSpriteSubject(rawSubject) : rawSubject;

  let final =
    `Pixel art for 2D top-down RPG. Subject: ${subject}. ` +
    `Flat colors, visible square pixels, no blur, no gradients, no photorealism. `;

  if (kind === 'tile') {
    final +=
      `Type: TILE. Seamless/repeating ground or material texture. Fill the full canvas with the texture. ` +
      `No standalone centered object, no empty background, no white background, no border/frame/text. `;
  } else {
    final +=
      `Type: STANDALONE SPRITE, not a tile. Draw exactly one large centered subject occupying 60-80% of canvas, readable at 32x32. ` +
      `Subject must have visible colored details; never output blank background only. ` +
      `For flowers/plants: visible petals, center, stem, leaves. ` +
      `No ground, dirt, grass patch, floor tile, shadow, base, platform, border, frame, full-canvas texture, text. ` +
      `Plain solid white background ${BG_COLOR}. Drawing the subject is more important than perfect background. `;
  }

  if (ref) {
    final += kind === 'tile'
      ? `Reference is style/palette only; requested tile rules win. `
      : `Reference is style/palette only; do not copy its subject, layout, background, border, ground, or texture. `;
  }

  final += kind === 'sprite'
    ? `Final: one large visible ${rawSubject} sprite centered on white background.`
    : `Final: one full-canvas ${rawSubject} tile texture.`;

  return capPrompt(final);
}

async function resolveAutoReference(sheetId, kind) {
  // 自动参考时按素材类型分流：非地块参考首个非地块，地块参考首个地块，避免两类互相带偏。
  let ref = await sprites.firstImageDataUrlByKind(sheetId, kind);
  if (!ref) ref = await sprites.firstImageOfAnyOtherByKind(sheetId, kind);
  // 兼容旧数据：老格子可能没有“地块/非地块”前缀，地块仍可回退到任意首图；非地块不回退，避免被地块图带偏。
  if (!ref && kind === 'tile') {
    ref = await sprites.firstImageDataUrl(sheetId);
    if (!ref) ref = await sprites.firstImageOfAnyOther(sheetId);
  }
  return ref;
}

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

// 测试连接：用一次最小生成验证 key 是否有效（含区域/base_url）
app.post('/api/config/test', async (req, res) => {
  const r = await minimax.validateKey();
  res.json(r);
});

app.post('/api/config', async (req, res) => {
  const cur = await getConfig();
  const { api_key, model, base_url } = req.body || {};
  if (model && !minimax.listModels().includes(model)) {
    return res.status(400).json({ error: 'INVALID_MODEL' });
  }
  // api_key 留空则保留已有 key，避免误清空
  const key = (api_key && api_key.trim()) || cur.api_key || '';
  const m = model || cur.model || 'image-01';
  const url = base_url && base_url.trim() ? base_url.trim() : (cur.base_url || 'https://api.minimax.io');
  await saveConfig({ provider: 'minimax', api_key: key, model: m, base_url: url });
  res.json({ ok: true });
});

// ---------- 精灵图管理 ----------
app.get('/api/sprites', async (req, res) => {
  res.json(await sprites.listSheets());
});

app.post('/api/sprites', async (req, res) => {
  const { name, cellSize, cols, rows } = req.body || {};
  res.json(await sprites.createSheet({ name, cellSize, cols, rows }));
});

app.get('/api/sprites/:id', async (req, res) => {
  try {
    res.json(await sprites.getSheet(req.params.id));
  } catch {
    res.status(404).json({ error: 'NOT_FOUND' });
  }
});

app.get('/api/sprites/:id/cells/:index', async (req, res) => {
  try {
    const buf = await sprites.readCellImage(req.params.id, req.params.index);
    res.set('Cache-Control', 'no-store');
    res.type('png').send(buf);
  } catch {
    res.status(404).end();
  }
});

app.get('/api/sprites/:id/skill', async (req, res) => {
  try {
    const t = await fs.readFile(sprites.skillFile(req.params.id), 'utf8');
    res.type('markdown').send(t);
  } catch {
    res.status(404).end();
  }
});

// 生成 / 替换格子
app.post('/api/sprites/:id/cells/:index/generate', (req, res) => generateCell(req, res));
app.post('/api/sprites/:id/cells/:index/replace', (req, res) => generateCell(req, res));

async function generateCell(req, res) {
  try {
    const { id, index } = req.params;
    const { prompt, reference, seed, assetKind } = req.body || {};
    if (!prompt) return res.status(400).json({ error: 'PROMPT_REQUIRED' });
    const kind = normalizeAssetKind(assetKind);

    let ref = reference;
    if (reference === false) {
      ref = null;
    } else if (!ref) {
      ref = await resolveAutoReference(id, kind);
    }

    const finalPrompt = buildPixelPrompt(prompt, ref, kind);

    const cfg = await getConfig();
    const imgs = await minimax.generateImage({
      model: cfg.model,
      prompt: finalPrompt,
      referenceImageBase64: ref,
      seed,
      promptOptimizer: false,
    });
    if (!imgs.length) return res.status(502).json({ error: 'NO_IMAGE' });

    const tag = `${kind === 'tile' ? '地块' : '非地块'}：${prompt.trim()}`;
    const meta = await sprites.applyCell(id, index, imgs[0], tag);
    res.json({ ok: true, meta });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

app.delete('/api/sprites/:id/cells/:index', async (req, res) => {
  try {
    const meta = await sprites.deleteCell(req.params.id, req.params.index);
    res.json({ ok: true, meta });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/sprites/:id/cells/:index/tag', async (req, res) => {
  try {
    const { tag } = req.body || {};
    const meta = await sprites.updateTag(req.params.id, req.params.index, tag);
    res.json({ ok: true, meta });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 直接写回一张 base64 图到指定格（用于跨格大图切片后逐格落盘）
app.put('/api/sprites/:id/cells/:index/image', async (req, res) => {
  try {
    const { image, tag } = req.body || {};
    if (!image) return res.status(400).json({ error: 'NO_IMAGE' });
    const meta = await sprites.applyCell(req.params.id, req.params.index, image, tag);
    res.json({ ok: true, meta });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 生成一张原始大图（不落盘），返回 base64，供前端按区域切片
app.post('/api/sprites/:id/generate-raw', async (req, res) => {
  try {
    const { prompt, reference, seed, width, height, assetKind } = req.body || {};
    if (!prompt) return res.status(400).json({ error: 'PROMPT_REQUIRED' });
    const kind = normalizeAssetKind(assetKind);
    let ref = reference;
    if (reference === false) {
      ref = null;
    } else if (!ref) {
      ref = await resolveAutoReference(req.params.id, kind);
    }
    const finalPrompt = buildPixelPrompt(prompt, ref, kind);
    const cfg = await getConfig();
    const imgs = await minimax.generateImage({
      model: cfg.model,
      prompt: finalPrompt,
      referenceImageBase64: ref,
      seed,
      width,
      height,
      promptOptimizer: false,
    });
    if (!imgs.length) return res.status(502).json({ error: 'NO_IMAGE' });
    res.json({ image: imgs[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- 通用生成（行走图模块等） ----------
app.post('/api/generate', async (req, res) => {
  try {
    const { prompt, reference, seed, n, assetKind } = req.body || {};
    if (!prompt) return res.status(400).json({ error: 'PROMPT_REQUIRED' });
    const kind = normalizeAssetKind(assetKind);
    const finalPrompt = buildPixelPrompt(prompt, reference, kind);
    const cfg = await getConfig();
    const imgs = await minimax.generateImage({
      model: cfg.model,
      prompt: finalPrompt,
      referenceImageBase64: reference,
      seed,
      n,
      promptOptimizer: false,
    });
    res.json({ images: imgs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`rpg-unit-spawner running at http://localhost:${PORT}`);
});