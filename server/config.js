const fs = require('fs/promises');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

async function ensureDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function getConfig() {
  try {
    const raw = await fs.readFile(CONFIG_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { provider: 'minimax', api_key: '', model: 'image-01' };
  }
}

async function saveConfig(cfg) {
  await ensureDir();
  await fs.writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}

// 仅用于下发前端：不暴露完整 key，只给脱敏片段
function maskKey(k) {
  if (!k) return '';
  if (k.length <= 8) return '****';
  return k.slice(0, 6) + '…' + k.slice(-4);
}

module.exports = { DATA_DIR, CONFIG_FILE, getConfig, saveConfig, ensureDir, maskKey };
