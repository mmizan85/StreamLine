import { DEFAULT_SETTINGS, EQ_PRESETS, SPEED_STEPS } from '../utils/constants.js';
import { debounce } from '../utils/debounce.js';

const EQ_FREQUENCIES = [60, 170, 310, 600, 1000, 3000, 6000, 12000, 14000, 16000];
const EQ_LABELS = ['60Hz', '170Hz', '310Hz', '600Hz', '1kHz', '3kHz', '6kHz', '12kHz', '14kHz', '16kHz'];

const dom = {
  volumeBoost: document.getElementById('volume-boost'),
  boostValue: document.getElementById('boost-value'),
  eqPreset: document.getElementById('eq-preset'),
  customEqContainer: document.getElementById('custom-eq-container'),
  customEqSliders: document.getElementById('custom-eq-sliders'),
  btnSaveEq: document.getElementById('btn-save-eq'),
  toggleSpeech: document.getElementById('toggle-speech'),
  defaultSpeed: document.getElementById('default-speed'),
  toggleNight: document.getElementById('toggle-night'),
  nightOpacity: document.getElementById('night-opacity'),
  nightValue: document.getElementById('night-value'),
  toggleSilence: document.getElementById('toggle-silence'),
  silenceThreshold: document.getElementById('silence-threshold'),
  silenceThresholdValue: document.getElementById('silence-threshold-value'),
  silencePadding: document.getElementById('silence-padding'),
  silencePaddingValue: document.getElementById('silence-padding-value'),
  toggleSync: document.getElementById('toggle-sync'),
  btnReset: document.getElementById('btn-reset'),
  btnShortcuts: document.getElementById('btn-shortcuts'),
  toast: document.getElementById('toast'),
  aboutPage: document.getElementById('about-page'),
};

let settings = { ...DEFAULT_SETTINGS };
let toastTimer = null;
let pendingPartial = {};
let suppressStorageEcho = false;
const flushDebouncedSave = debounce(() => {
  const partial = { ...pendingPartial };
  pendingPartial = {};
  saveSettings(partial);
}, 120);

document.addEventListener('DOMContentLoaded', async () => {
  buildOptions();
  await loadSettings();
  bindEvents();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'sync' || !changes.settings) {
    return;
  }

  settings = { ...DEFAULT_SETTINGS, ...(changes.settings.newValue || {}) };
  applySettingsToUi();

  if (suppressStorageEcho) {
    suppressStorageEcho = false;
    return;
  }

  showToast('Settings updated');
});

function buildOptions() {
  dom.eqPreset.innerHTML = Object.keys(EQ_PRESETS)
    .map(
      preset =>
        `<option value="${preset}">${preset.charAt(0).toUpperCase()}${preset.slice(1)}</option>`,
    )
    .join('');

  dom.defaultSpeed.innerHTML = SPEED_STEPS.map(
    speed =>
      `<option value="${speed}">${formatSpeed(speed)}</option>`,
  ).join('');

  buildCustomEqSliders();
}

function buildCustomEqSliders() {
  const customEQ = settings.customEQ || DEFAULT_SETTINGS.customEQ || [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  
  dom.customEqSliders.innerHTML = EQ_FREQUENCIES.map((freq, index) => {
    const label = EQ_LABELS[index];
    const value = customEQ[index] || 0;
    return `
      <div class="custom-eq__band">
        <input type="range" 
               class="eq-band-slider" 
               data-index="${index}" 
               min="-12" 
               max="12" 
               step="1" 
               value="${value}" />
        <label>${label}</label>
        <span class="band-value" data-index="${index}">${value > 0 ? '+' : ''}${value}</span>
      </div>
    `;
  }).join('');

  // Bind slider events
  dom.customEqSliders.querySelectorAll('.eq-band-slider').forEach(slider => {
    slider.addEventListener('input', handleEqBandChange);
  });
}

function handleEqBandChange(event) {
  const index = parseInt(event.target.dataset.index, 10);
  const value = parseInt(event.target.value, 10);
  
  const valueDisplay = dom.customEqSliders.querySelector(`.band-value[data-index="${index}"]`);
  if (valueDisplay) {
    valueDisplay.textContent = value > 0 ? `+${value}` : value;
  }

  // Update in-memory settings temporarily
  const currentCustomEQ = [...(settings.customEQ || [0, 0, 0, 0, 0, 0, 0, 0, 0, 0])];
  currentCustomEQ[index] = value;
  settings.customEQ = currentCustomEQ;
}

async function loadSettings() {
  const stored = await chrome.storage.sync.get('settings');
  settings = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
  applySettingsToUi();
}

function bindEvents() {
  dom.volumeBoost.addEventListener('input', () => {
    const value = Number(dom.volumeBoost.value) / 100;
    dom.boostValue.textContent = `${Math.round(value * 100)}%`;
    queueSave({ volumeBoost: value });
  });

  dom.eqPreset.addEventListener('change', () => {
    const preset = dom.eqPreset.value;
    const customEqVisible = preset === 'custom';
    dom.aboutPage.style.display = customEqVisible ? 'none' : 'block'; // Hide about page if open
    dom.customEqContainer.style.display = customEqVisible ? 'block' : 'none';
    saveSettings({ eqPreset: preset });
  });

  dom.btnSaveEq.addEventListener('click', () => {
    const customEQ = [];
    dom.customEqSliders.querySelectorAll('.eq-band-slider').forEach(slider => {
      customEQ.push(parseInt(slider.value, 10));
    });
    saveSettings({ eqPreset: 'custom', customEQ });
    showToast('Custom EQ saved');
  });

  dom.defaultSpeed.addEventListener('change', () => {
    saveSettings({ defaultSpeed: Number(dom.defaultSpeed.value) });
  });

  dom.nightOpacity.addEventListener('input', () => {
    const value = Number(dom.nightOpacity.value) / 100;
    dom.nightValue.textContent = `${Math.round(value * 100)}%`;
    queueSave({ nightModeOpacity: value });
  });

  dom.silenceThreshold.addEventListener('input', () => {
    const value = Number(dom.silenceThreshold.value) / 100;
    dom.silenceThresholdValue.textContent = value.toFixed(2);
    queueSave({ silenceThreshold: value });
  });

  dom.silencePadding.addEventListener('input', () => {
    const value = Number(dom.silencePadding.value) / 10;
    dom.silencePaddingValue.textContent = `${value.toFixed(1)}s`;
    queueSave({ silencePadding: value });
  });

  bindToggle(dom.toggleSpeech, 'speechEnhancer');
  bindToggle(dom.toggleNight, 'nightMode');
  bindToggle(dom.toggleSilence, 'autoSkipSilence');
  bindToggle(dom.toggleSync, 'multiTabSync');

  dom.btnReset.addEventListener('click', async () => {
    settings = { ...DEFAULT_SETTINGS };
    suppressStorageEcho = true;
    await chrome.storage.sync.set({ settings });
    applySettingsToUi();
    showToast('Defaults restored');
  });

  dom.btnShortcuts.addEventListener('click', () => {
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  });
}

function bindToggle(button, key) {
  button.addEventListener('click', () => {
    const nextValue = button.getAttribute('aria-checked') !== 'true';
    saveSettings({ [key]: nextValue });
  });
}

async function saveSettings(partial) {
  settings = { ...settings, ...partial };
  suppressStorageEcho = true;
  await chrome.storage.sync.set({ settings });
  applySettingsToUi();
  showToast('Saved');
}

function queueSave(partial) {
  pendingPartial = { ...pendingPartial, ...partial };
  flushDebouncedSave();
}

function applySettingsToUi() {
  dom.volumeBoost.value = String(Math.round((settings.volumeBoost || 1) * 100));
  dom.boostValue.textContent = `${Math.round((settings.volumeBoost || 1) * 100)}%`;
  dom.eqPreset.value = settings.eqPreset || 'flat';
  dom.defaultSpeed.value = String(settings.defaultSpeed || 1);
  dom.nightOpacity.value = String(Math.round((settings.nightModeOpacity || 0.3) * 100));
  dom.nightValue.textContent = `${Math.round((settings.nightModeOpacity || 0.3) * 100)}%`;
  dom.silenceThreshold.value = String(Math.round((settings.silenceThreshold || 0.02) * 100));
  dom.silenceThresholdValue.textContent = (settings.silenceThreshold || 0.02).toFixed(2);
  dom.silencePadding.value = String(Math.round((settings.silencePadding || 0.5) * 10));
  dom.silencePaddingValue.textContent = `${(settings.silencePadding || 0.5).toFixed(1)}s`;

  setToggle(dom.toggleSpeech, settings.speechEnhancer);
  setToggle(dom.toggleNight, settings.nightMode);
  setToggle(dom.toggleSilence, settings.autoSkipSilence);
  setToggle(dom.toggleSync, settings.multiTabSync);

  // Show/hide custom EQ container
  const isCustom = settings.eqPreset === 'custom';
  dom.customEqContainer.style.display = isCustom ? 'block' : 'none';

  // Update custom EQ sliders if custom preset is selected
  if (isCustom && settings.customEQ) {
    updateCustomEqSliders(settings.customEQ);
  }
}

function updateCustomEqSliders(customEQ) {
  if (!customEQ || customEQ.length !== EQ_FREQUENCIES.length) return;
  
  dom.customEqSliders.querySelectorAll('.eq-band-slider').forEach(slider => {
    const index = parseInt(slider.dataset.index, 10);
    slider.value = customEQ[index];
    
    const valueDisplay = dom.customEqSliders.querySelector(`.band-value[data-index="${index}"]`);
    if (valueDisplay) {
      const val = customEQ[index];
      valueDisplay.textContent = val > 0 ? `+${val}` : val;
    }
  });
}

function setToggle(button, value) {
  button.setAttribute('aria-checked', value ? 'true' : 'false');
}

function formatSpeed(speed) {
  const value = Number(speed) || 1;
  return `${value % 1 === 0 ? value.toFixed(0) : value.toFixed(2).replace(/\.?0+$/, '')}x`;
}

function showToast(message) {
  clearTimeout(toastTimer);
  dom.toast.textContent = message;
  dom.toast.classList.add('is-visible');
  toastTimer = setTimeout(() => {
    dom.toast.classList.remove('is-visible');
  }, 1400);
}
