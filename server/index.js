const express = require('express');
const path = require('path');
const fs = require('fs/promises');
const { getConfig, saveConfig, maskKey } = require('./config');
const minimax = require('./minimax');
const sprites = require('./sprites');

const app = express();
app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// 抠图用的纯色背景（magenta 在多数像素素材里不出现，便于 chroma key）
const BG_COLOR = '#FF00FF';

function normalizeAssetKind(assetKind) {
  return assetKind === 'tile' ? 'tile' : 'sprite';
}

function expandSpriteSubject(subject) {
  const s = subject.trim();
  if (/^(花|花朵|小花|flower|flowers)$/i.test(s)) {
    return `${s} — one clearly visible blooming flower with distinct petals, a center, a short stem, and two small leaves`;
  }
  return s;
}

// 像素风强制约束（全英文）。地块和非地块明确分流，避免独立素材被参考图/地块规则铺满。
function buildPixelPrompt(promptText, ref, assetKind = 'sprite') {
  const kind = normalizeAssetKind(assetKind);
  const rawSubject = promptText.trim();
  const subject = kind === 'sprite' ? expandSpriteSubject(rawSubject) : rawSubject;
  const common =
    `Pixel art asset for a 2D top-down RPG game. Subject: [${subject}]. ` +
    `STRICT rules — flat colors only, visible square pixels, no smoothing/AA/blur/gradients/photorealism. ` +
    `Draw the requested subject clearly and do not replace it with background. ` +
    `Do NOT spontaneously add any unrequested objects, scenery, borders, frames, edges, vignettes, text, logos, UI elements, checkerboards, or mockup backgrounds. `;

  let final = common;
  if (kind === 'tile') {
    final +=
      `Asset type: TILE / GROUND TEXTURE. ` +
      `The output MUST be a single seamless/repeating terrain tile texture. ` +
      `Fill the ENTIRE image uniformly with the requested terrain/material texture. ` +
      `Do NOT create a centered standalone object and do NOT leave empty background. ` +
      `No solid magenta background; the terrain texture itself must cover the full canvas. `;
  } else {
    final +=
      `Asset type: NON-TILE STANDALONE SPRITE. ` +
      `Composition is mandatory: the subject must occupy about 60% to 80% of the canvas, centered, large, readable, and clearly visible after being downscaled to 32x32. ` +
      `Create EXACTLY ONE standalone subject. The subject must contain colored visible details; never output only a blank or almost blank background. ` +
      `If the subject is a flower or plant, petals, flower center, stem, and leaves must be visible. ` +
      `Do NOT draw ground, dirt, grass patches, tile floors, beige paper, shadows, bases, platforms, frames, outlines around the canvas, or any full-canvas texture. ` +
      `Do NOT make a repeating tile and do NOT fill the canvas with decorative texture. ` +
      `Leave clear empty space around the subject, but the subject itself must be large and prominent. ` +
      `Use a simple flat solid high-contrast background color ${BG_COLOR} behind the subject. ` +
      `The background should be plain and easy to remove later, but drawing the visible subject is more important than making the background perfectly exact. `;
  }

  if (ref) {
    if (kind === 'tile') {
      final +=
        `Use the provided reference image ONLY for pixel-art style, palette, lighting simplicity, and material feel. ` +
        `Do NOT copy the reference subject unless it matches the requested subject. The requested subject and TILE rules always win. `;
    } else {
      final +=
        `Use the provided reference image ONLY for pixel-art style and color palette. ` +
        `Do NOT copy the reference subject, proportions, layout, tiling pattern, full-canvas texture, border, frame, shadow, ground, or background. ` +
        `The requested subject must remain one large standalone non-tile sprite on a plain solid background. `;
    }
  }

  final += `Final check before output: there must be one large visible ${rawSubject} sprite in the center. Output exactly one image.`;
  return final;
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
    } else if (!ref && kind === 'tile') {
      // 只有地块默认沿用首图参考；非地块默认不套用首图，避免花朵/道具被地块参考图铺满。
      ref = await sprites.firstImageDataUrl(id);
      if (!ref) ref = await sprites.firstImageOfAnyOther(id);
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
    } else if (!ref && kind === 'tile') {
      ref = await sprites.firstImageDataUrl(req.params.id);
      if (!ref) ref = await sprites.firstImageOfAnyOther(req.params.id);
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