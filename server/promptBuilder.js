const tilePrompt = require('./tilePrompt');

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
  if (/^(鑺眧鑺辨湹|灏忚姳|flower|flowers)$/i.test(s)) {
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

module.exports = {
  BG_COLOR,
  TILE_IMAGE_SIZE,
  MAX_MINIMAX_PROMPT_CHARS,
  MAX_SUBJECT_CHARS,
  normalizeAssetKind,
  clipText,
  expandSpriteSubject,
  capPrompt,
  promptFromClient,
  buildPixelPrompt,
  imageArgs,
};
