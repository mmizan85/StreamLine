export const MSG = Object.freeze({
  MEDIA_DETECTED: 'MEDIA_DETECTED',
  MEDIA_STATE_UPDATE: 'MEDIA_STATE_UPDATE',
  MEDIA_STARTED: 'MEDIA_STARTED',
  MEDIA_PAUSED: 'MEDIA_PAUSED',
  MEDIA_ENDED: 'MEDIA_ENDED',
  MEDIA_REMOVED: 'MEDIA_REMOVED',
  GET_ALL_STATE: 'GET_ALL_STATE',
  TAB_COMMAND: 'TAB_COMMAND',
  SETTINGS_UPDATE: 'SETTINGS_UPDATE',
  STATE_PUSH: 'STATE_PUSH',
  CMD_PLAY_PAUSE: 'CMD_PLAY_PAUSE',
  CMD_SEEK: 'CMD_SEEK',
  CMD_SET_VOLUME: 'CMD_SET_VOLUME',
  CMD_SET_SPEED: 'CMD_SET_SPEED',
  CMD_TOGGLE_PIP: 'CMD_TOGGLE_PIP',
});

export const PAGE_EVENTS = Object.freeze({
  TO_PAGE: 'STREAMLINE_TO_PAGE',
  FROM_PAGE: 'STREAMLINE_FROM_PAGE',
});

export const EQ_PRESETS = Object.freeze({
  flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  bass: [8, 7, 6, 3, 0, 0, 0, 0, 0, 0],
  treble: [0, 0, 0, 0, 0, 0, 3, 5, 7, 8],
  vocal: [-2, -2, 0, 3, 5, 5, 3, 1, -1, -2],
  speech: [4, 3, 2, 1, 0, 1, 4, 6, 4, 2],
  rock: [5, 4, 3, 1, 0, -1, 0, 3, 4, 5],
  classical: [0, 0, 0, 0, 0, 0, -2, -3, -3, 0],
  jazz: [3, 2, 1, 2, 0, 0, 0, 1, 2, 3],
  custom: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
});

export const SPEED_STEPS = Object.freeze([
  0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0, 4.0, 8.0, 16.0,
]);

export const DEFAULT_SETTINGS = Object.freeze({
  volumeBoost: 1.0,
  eqPreset: 'flat',
  customEQ: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  eqApplyToAudio: true,
  speechEnhancer: false,
  compressorThreshold: -24,
  compressorKnee: 30,
  compressorRatio: 4,
  compressorAttack: 0.003,
  compressorRelease: 0.25,
  nightMode: false,
  nightModeOpacity: 0.3,
  autoSkipSilence: false,
  silenceThreshold: 0.02,
  silencePadding: 0.5,
  multiTabSync: true,
  defaultSpeed: 1.0,
  rememberSpeed: false,
});
