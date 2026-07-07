const minimax = require('./minimax');

const MAX_PROMPT_CHARS = 1400;

function cap(text) {
  const s = String(text || '').trim();
  return s.length > MAX_PROMPT_CHARS ? s.slice(0, MAX_PROMPT_CHARS) : s;
}

function fallbackSlots(input) {
  const raw = String(input || '').trim();
  const grass = /(草地|草坪|grass|lawn|meadow)/i.test(raw);
  const anime = /(清新动漫风|动漫风|anime|jrpg)/i.test(raw);
  return {
    SUBJECT: grass ? 'grass' : (/[\u3400-\u9fff]/.test(raw) ? 'terrain surface' : (raw || 'terrain surface')),
    SUBJECT_DETAIL: grass ? 'dense natural grass blades with subtle color variation' : 'clean natural surface texture with subtle color variation',
    STYLE: anime ? 'Clean anime illustration, JRPG game asset, soft cel-shaded, hand-painted' : 'RPG game asset, hand-painted',
    COLOR_PALETTE: grass ? 'Fresh bright green color palette' : 'Clean game-friendly color palette',
    STYLE_EXCLUDE: anime ? 'photorealistic, 3d render, pixel art' : 'photorealistic, 3d render',
    translatedByModel: false,
  };
}

function clean(value, fallback) {
  const s = String(value || '').trim().replace(/\s+/g, ' ');
  return s || fallback;
}

async function getSlots(input) {
  const fallback = fallbackSlots(input);
  try {
    const out = await minimax.translateTileSlots(input);
    return {
      SUBJECT: clean(out.SUBJECT, fallback.SUBJECT),
      SUBJECT_DETAIL: clean(out.SUBJECT_DETAIL, fallback.SUBJECT_DETAIL),
      STYLE: clean(out.STYLE, fallback.STYLE),
      COLOR_PALETTE: clean(out.COLOR_PALETTE, fallback.COLOR_PALETTE),
      STYLE_EXCLUDE: clean(out.STYLE_EXCLUDE, fallback.STYLE_EXCLUDE),
      translatedByModel: true,
    };
  } catch (e) {
    return { ...fallback, translationError: e.message };
  }
}

function buildFromSlots(slots, hasReference) {
  let prompt = [
    'Positive Prompt',
    `Seamless tileable ${slots.SUBJECT} tile texture, repeating pattern, edge-to-edge ${slots.SUBJECT} coverage with content extending to all four borders.`,
    `2D, bird's-eye perspective.`,
    `${slots.STYLE} style.`,
    `${slots.SUBJECT_DETAIL}.`,
    `${slots.COLOR_PALETTE}.`,
    `Only ${slots.SUBJECT}, no other elements, no props, no characters, no text, no UI, no watermark, no signature, no borders, no frames, no vignette.`,
    `Uniform flat ambient lighting, even light from all directions, no shadows, no highlights, no directional light source.`,
    `Perfectly continuous pattern, edges blend seamlessly when tiled.`,
  ].join(' ');
  if (hasReference) prompt += ' Reference image is style and palette only; keep the tile fully seamless.';
  prompt += `\nNegative Prompt\n${slots.STYLE_EXCLUDE}, borders, frames, edge artifacts, visible seams, hard edges, shadows, highlights, vignette, perspective distortion, 3d render, photorealistic, blurry, low quality, watermark, signature, text, UI, props, items`;
  return cap(prompt);
}

async function build(input, hasReference) {
  const slots = await getSlots(input);
  return { prompt: buildFromSlots(slots, hasReference), slots };
}

module.exports = { build, fallbackSlots, buildFromSlots };