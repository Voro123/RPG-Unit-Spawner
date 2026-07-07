const { getConfig } = require('./config');

const DEFAULT_BASE = 'https://api.minimax.io';
const DEFAULT_TEXT_MODEL = 'MiniMax-Text-01';
const translateCache = new Map();

function listModels() {
  return ['image-01', 'image-01-live'];
}

function listTextModels() {
  return [DEFAULT_TEXT_MODEL, 'abab6.5s-chat', 'abab6.5-chat'];
}

async function getBase() {
  const c = await getConfig();
  return (c.base_url && c.base_url.trim()) || DEFAULT_BASE;
}

// 生成图像，返回 base64 数组
async function generateImage({ model = 'image-01', prompt, referenceImageBase64, seed, n = 1, promptOptimizer, width, height } = {}) {
  const { api_key } = await getConfig();
  if (!api_key) throw new Error('MINIMAX_API_KEY_NOT_SET');

  const base = await getBase();
  const body = {
    model,
    prompt,
    response_format: 'base64',
    n: Math.min(Math.max(1, n | 0), 9),
    prompt_optimizer: !!promptOptimizer,
  };
  if (model === 'image-01') {
    const clamp = (v) => (v && v >= 512 && v <= 2048 ? Math.round(v / 8) * 8 : 512);
    body.width = clamp(width);
    body.height = clamp(height);
  }
  if (seed) body.seed = seed;
  if (referenceImageBase64) {
    body.subject_reference = [{ type: 'character', image_file: referenceImageBase64 }];
    console.log(`[minimax] subject_reference sent (bytes=${referenceImageBase64.length})`);
  }

  const res = await fetch(`${base}/v1/image_generation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${api_key}` },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  const code = json?.base_resp?.status_code;
  if (code !== 0) {
    throw new Error(`MINIMAX_ERR_${code}: ${json?.base_resp?.status_msg || 'unknown'}`);
  }
  return json.data?.image_base64 || [];
}

function parseJsonObject(text) {
  const raw = String(text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  try {
    return JSON.parse(raw);
  } catch {
    const m = /\{[\s\S]*\}/.exec(raw);
    if (!m) throw new Error('TEXT_TRANSLATE_PARSE_FAILED');
    return JSON.parse(m[0]);
  }
}

async function chatCompletion(messages, { model, temperature = 0.1 } = {}) {
  const { api_key, text_model } = await getConfig();
  if (!api_key) throw new Error('MINIMAX_API_KEY_NOT_SET');
  const base = await getBase();
  const body = {
    model: model || text_model || DEFAULT_TEXT_MODEL,
    messages,
    temperature,
  };
  const res = await fetch(`${base}/v1/text/chatcompletion_v2`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${api_key}` },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  const code = json?.base_resp?.status_code;
  if (code !== undefined && code !== 0) {
    throw new Error(`MINIMAX_TEXT_ERR_${code}: ${json?.base_resp?.status_msg || 'unknown'}`);
  }
  const content = json?.choices?.[0]?.message?.content || json?.reply || json?.choices?.[0]?.text || '';
  if (!content) throw new Error('MINIMAX_TEXT_EMPTY_REPLY');
  return content;
}

async function translateTileSlots(userPrompt) {
  const key = String(userPrompt || '').trim();
  if (!key) throw new Error('PROMPT_REQUIRED');
  if (translateCache.has(key)) return translateCache.get(key);

  const system = [
    'You translate RPG tile-generation requests into strict English prompt slots.',
    'Return JSON only. No markdown. No explanations.',
    'Never add decorative objects. For terrain tiles, the subject must be a surface material, not a scene.',
    'If the user writes Chinese or mixed Chinese-English, translate all slot values into natural English image-prompt phrases.',
  ].join(' ');

  const user = `Fill these JSON fields for a seamless RPG tile texture prompt.\n\nFields:\n- SUBJECT: English material noun, e.g. grass, dirt, sand, stone floor, water surface, snow, wood planks.\n- SUBJECT_DETAIL: concrete visual form of the material only, e.g. dense natural grass blades with subtle color variation.\n- STYLE: English style keywords. If user says 清新动漫风/动漫风, use: Clean anime illustration, JRPG game asset, soft cel-shaded, hand-painted.\n- COLOR_PALETTE: English palette phrase. If user says 清新 or bright grass, use: Fresh bright green color palette.\n- STYLE_EXCLUDE: English negative style keywords, e.g. photorealistic, 3d render, pixel art when inappropriate.\n\nDo not output flowers, rocks, trees, props, paths, characters, borders, frames, shadows, or edge elements in any positive slot unless the user explicitly says the SUBJECT itself is that material.\n\nUser input: ${key}\n\nReturn exactly this JSON shape:\n{"SUBJECT":"","SUBJECT_DETAIL":"","STYLE":"","COLOR_PALETTE":"","STYLE_EXCLUDE":""}`;

  const content = await chatCompletion([
    { role: 'system', content: system },
    { role: 'user', content: user },
  ], { temperature: 0.1 });
  const obj = parseJsonObject(content);
  const slots = {
    SUBJECT: String(obj.SUBJECT || '').trim(),
    SUBJECT_DETAIL: String(obj.SUBJECT_DETAIL || '').trim(),
    STYLE: String(obj.STYLE || '').trim(),
    COLOR_PALETTE: String(obj.COLOR_PALETTE || '').trim(),
    STYLE_EXCLUDE: String(obj.STYLE_EXCLUDE || '').trim(),
  };
  if (!slots.SUBJECT) throw new Error('TEXT_TRANSLATE_SUBJECT_EMPTY');
  translateCache.set(key, slots);
  return slots;
}

// 校验 key 是否有效（用一次最小生成，确认能打通实际接口）
async function validateKey() {
  const { api_key } = await getConfig();
  if (!api_key) return { ok: false, error: 'NO_KEY' };
  const base = await getBase();
  const body = {
    model: 'image-01',
    prompt: 'a single small red dot on plain background',
    response_format: 'base64',
    n: 1,
    width: 512,
    height: 512,
  };
  try {
    const res = await fetch(`${base}/v1/image_generation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${api_key}` },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    const code = json?.base_resp?.status_code;
    if (code === 0) return { ok: true };
    return { ok: false, error: `MINIMAX_ERR_${code}: ${json?.base_resp?.status_msg || 'unknown'}` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { listModels, listTextModels, generateImage, validateKey, translateTileSlots };