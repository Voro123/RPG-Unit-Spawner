(() => {
  const KEY = 'rpg-unit-spawner.spriteSettings.v1';
  let installed = false;

  const fieldConfigs = [
    { id: 'bgTolerance', prop: 'bgTolerance', type: 'value' },
    { id: 'bgColor', prop: 'bgColor', type: 'value' },
    { id: 'removeBg', prop: 'removeBg', type: 'checked' },
    { id: 'seed', prop: 'seed', type: 'value' },
    { id: 'newCell', prop: 'newCell', type: 'value' },
    { id: 'newCols', prop: 'newCols', type: 'value' },
    { id: 'newRows', prop: 'newRows', type: 'value' },
    { id: 'pixelColor', prop: 'pixelColor', type: 'value' },
    { id: 'pixelAlpha', prop: 'pixelAlpha', type: 'value' },
    { id: 'pixelTransparent', prop: 'pixelTransparent', type: 'checked' },
  ];

  const radioConfigs = [
    { name: 'assetKind', prop: 'assetKind' },
    { name: 'ref', prop: 'refMode' },
  ];

  function $(id) { return document.getElementById(id); }

  function readSettings() {
    try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; }
    catch { return {}; }
  }

  function writeSettings(next) {
    localStorage.setItem(KEY, JSON.stringify({ ...readSettings(), ...next }));
  }

  function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  function restoreField(cfg, settings) {
    const el = $(cfg.id);
    if (!el || !hasOwn(settings, cfg.prop)) return false;
    if (el.dataset.persistRestored === '1') return false;
    if (cfg.type === 'checked') el.checked = !!settings[cfg.prop];
    else el.value = String(settings[cfg.prop]);
    el.dataset.persistRestored = '1';
    return true;
  }

  function saveField(cfg) {
    const el = $(cfg.id);
    if (!el) return;
    el.dataset.persistRestored = '1';
    writeSettings({ [cfg.prop]: cfg.type === 'checked' ? !!el.checked : el.value });
  }

  function restoreRadio(cfg, settings) {
    if (!hasOwn(settings, cfg.prop)) return false;
    const el = document.querySelector(`input[name="${cfg.name}"][value="${settings[cfg.prop]}"]`);
    if (!el || el.dataset.persistRestored === '1') return false;
    el.checked = true;
    document.querySelectorAll(`input[name="${cfg.name}"]`).forEach((r) => (r.dataset.persistRestored = '1'));
    return true;
  }

  function saveRadio(cfg) {
    const el = document.querySelector(`input[name="${cfg.name}"]:checked`);
    if (el) {
      document.querySelectorAll(`input[name="${cfg.name}"]`).forEach((r) => (r.dataset.persistRestored = '1'));
      writeSettings({ [cfg.prop]: el.value });
    }
  }

  function dispatchChangesForRestored(restoredFields, restoredRadios) {
    restoredFields.forEach((id) => {
      const el = $(id);
      if (!el) return;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    restoredRadios.forEach((name) => {
      const el = document.querySelector(`input[name="${name}"]:checked`);
      if (el) el.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  function restoreNewControlsOnly() {
    const settings = readSettings();
    const restoredFields = [];
    const restoredRadios = [];
    fieldConfigs.forEach((cfg) => {
      if (restoreField(cfg, settings)) restoredFields.push(cfg.id);
    });
    radioConfigs.forEach((cfg) => {
      if (restoreRadio(cfg, settings)) restoredRadios.push(cfg.name);
    });
    if (restoredFields.length || restoredRadios.length) {
      setTimeout(() => dispatchChangesForRestored(restoredFields, restoredRadios), 0);
    }
  }

  function bindAll() {
    fieldConfigs.forEach((cfg) => {
      const el = $(cfg.id);
      if (!el || el.dataset.persistBound === '1') return;
      el.dataset.persistBound = '1';
      const handler = () => saveField(cfg);
      el.addEventListener('input', handler);
      el.addEventListener('change', handler);
    });
    radioConfigs.forEach((cfg) => {
      document.querySelectorAll(`input[name="${cfg.name}"]`).forEach((el) => {
        if (el.dataset.persistBound === '1') return;
        el.dataset.persistBound = '1';
        el.addEventListener('change', () => saveRadio(cfg));
      });
    });
  }

  function install() {
    if (installed) return;
    installed = true;
    restoreNewControlsOnly();
    bindAll();

    const observer = new MutationObserver(() => {
      bindAll();
      restoreNewControlsOnly();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install);
  else install();
})();
