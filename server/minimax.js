const { getConfig } = require('./config');

const DEFAULT_BASE = 'https://api.minimax.io';

function listModels() {
  return ['image-01', 'image-01-live'];
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

module.exports = { listModels, generateImage, validateKey };
