(function () {
  if (window.__STREAMLINE_PAGE_ACTIVE__) {
    return;
  }

  window.__STREAMLINE_PAGE_ACTIVE__ = true;

  const TO_PAGE = 'STREAMLINE_TO_PAGE';
  const FROM_PAGE = 'STREAMLINE_FROM_PAGE';
  const APPLY_SETTINGS = 'APPLY_SETTINGS';
  const SCAN_MEDIA = 'SCAN_MEDIA';

  const DEFAULT_SETTINGS = {
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
  };

  const EQ_PRESETS = {
    flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    bass: [8, 7, 6, 3, 0, 0, 0, 0, 0, 0],
    treble: [0, 0, 0, 0, 0, 0, 3, 5, 7, 8],
    vocal: [-2, -2, 0, 3, 5, 5, 3, 1, -1, -2],
    speech: [4, 3, 2, 1, 0, 1, 4, 6, 4, 2],
    rock: [5, 4, 3, 1, 0, -1, 0, 3, 4, 5],
    classical: [0, 0, 0, 0, 0, 0, -2, -3, -3, 0],
    jazz: [3, 2, 1, 2, 0, 0, 0, 1, 2, 3],
    custom: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  };
  const EQ_FREQUENCIES = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

  const controllers = new Map();
  const observedRoots = new WeakSet();
  const pendingRoots = new Set();
  let settings = { ...DEFAULT_SETTINGS };
  let sharedAudioContext = null;
  let scanTimer = null;
  let mediaCounter = 0;

  patchAttachShadow();
  observeRoot(document);
  queueScan(document);
  wireCommandListener();
  wireUnloadCleanup();

  function wireCommandListener() {
    window.addEventListener(TO_PAGE, event => {
      const action = event.detail?.action;
      const payload = event.detail?.payload || {};

      switch (action) {
        case APPLY_SETTINGS:
          applySettings(payload.settings || {}, payload.changedKeys || ['*']);
          return;

        case SCAN_MEDIA:
          queueScan(document);
          return;

        case 'CMD_PLAY_PAUSE':
          resolveController(payload)?.playPause(Boolean(payload.forcePause));
          return;

        case 'CMD_SEEK':
          resolveController(payload)?.seek(payload.time);
          return;

        case 'CMD_SET_VOLUME':
          resolveController(payload)?.setVolume(payload.volume);
          return;

        case 'CMD_SET_SPEED':
          resolveController(payload)?.setSpeed(payload.speed);
          return;

        case 'CMD_TOGGLE_PIP':
          resolveController(payload)?.togglePiP();
          return;
      }
    });
  }

  function wireUnloadCleanup() {
    window.addEventListener('pagehide', () => {
      for (const controller of Array.from(controllers.values())) {
        unregisterMedia(controller.el);
      }
    });
  }

  function patchAttachShadow() {
    const original = Element.prototype.attachShadow;
    if (original.__streamlinePatched__) {
      return;
    }

    function patchedAttachShadow(init) {
      const root = original.call(this, init);
      if (init?.mode === 'open') {
        observeRoot(root);
        queueScan(root);
      }
      return root;
    }

    patchedAttachShadow.__streamlinePatched__ = true;
    Element.prototype.attachShadow = patchedAttachShadow;
  }

  function observeRoot(root) {
    if (!root || observedRoots.has(root)) {
      return;
    }

    observedRoots.add(root);

    const observer = new MutationObserver(mutations => {
      for (const mutation of mutations) {
        if (mutation.type !== 'childList') {
          continue;
        }

        for (const node of mutation.removedNodes) {
          unregisterTree(node);
        }

        if (mutation.addedNodes.length) {
          queueScan(root);
        }
      }
    });

    observer.observe(root, {
      childList: true,
      subtree: true,
    });
  }

  function queueScan(root) {
    pendingRoots.add(root || document);

    if (scanTimer !== null) {
      return;
    }

    scanTimer = window.setTimeout(flushScans, 30);
  }

  function flushScans() {
    scanTimer = null;
    const roots = Array.from(pendingRoots);
    pendingRoots.clear();

    for (const root of roots) {
      scanRoot(root);
    }
  }

  function scanRoot(root) {
    walkElements(root, element => {
      if (element.shadowRoot) {
        observeRoot(element.shadowRoot);
        queueScan(element.shadowRoot);
      }

      if (element instanceof HTMLMediaElement) {
        registerMedia(element);
      }
    });
  }

  function walkElements(root, callback) {
    if (!root) {
      return;
    }

    if (root instanceof Element) {
      callback(root);
    }

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    while (walker.nextNode()) {
      callback(walker.currentNode);
    }
  }

  function unregisterTree(root) {
    walkElements(root, element => {
      if (element instanceof HTMLMediaElement) {
        unregisterMedia(element);
      }

      if (element.shadowRoot) {
        unregisterTree(element.shadowRoot);
      }
    });
  }

  function registerMedia(element) {
    const streamlineId = ensureStreamlineId(element);
    const existing = controllers.get(streamlineId);

    if (existing) {
      if (existing.el === element) {
        existing.applySettings(settings, ['*']);
        return existing;
      }

      element.dataset.streamlineId = '';
      return registerMedia(element);
    }

    const controller = new MediaController(element);
    controllers.set(streamlineId, controller);
    return controller;
  }

  function unregisterMedia(element) {
    const streamlineId = element?.dataset?.streamlineId;
    const controller = streamlineId ? controllers.get(streamlineId) : null;
    if (!controller) {
      return;
    }

    controllers.delete(streamlineId);
    controller.destroy();

    emit('MEDIA_REMOVED', {
      streamlineId,
    });
  }

  function ensureStreamlineId(element) {
    if (!element.dataset.streamlineId) {
      mediaCounter += 1;
      element.dataset.streamlineId = `sl-${Date.now().toString(36)}-${mediaCounter.toString(36)}`;
    }

    return element.dataset.streamlineId;
  }

  function resolveController(payload) {
    if (payload.streamlineId && controllers.has(payload.streamlineId)) {
      return controllers.get(payload.streamlineId);
    }

    const ranked = Array.from(controllers.values()).sort((left, right) => {
      return (
        controllerPriority(right) - controllerPriority(left) ||
        right.updatedAt - left.updatedAt
      );
    });

    return ranked[0] || null;
  }

  function controllerPriority(controller) {
    let score = 0;
    const snapshot = controller.snapshot({});

    if (!snapshot.paused) {
      score += 100;
    }
    if (snapshot.isPiP) {
      score += 10;
    }
    if (snapshot.hasVideo) {
      score += 5;
    }

    return score;
  }

  function applySettings(nextSettings, changedKeys) {
    settings = { ...settings, ...nextSettings };

    for (const controller of controllers.values()) {
      controller.applySettings(settings, changedKeys);
    }
  }

  class MediaController {
    constructor(element) {
      this.el = element;
      this.id = element.dataset.streamlineId;
      this.audioCtx = null;
      this.sourceNode = null;
      this.gainNode = null;
      this.eqFilters = [];
      this.compressor = null;
      this.analyser = null;
      this.analyserBuffer = null;
      this.audioReady = false;
      this.updatedAt = Date.now();
      this.originalFilter = element.style.filter || '';
      this.defaultSpeedApplied = false;
      this.lastDefaultSpeedValue = null;
      this.lastThumbnail = null;
      this.lastThumbnailAt = 0;
      this.silenceEnabled = false;
      this.silenceFrame = null;
      this.silenceStartAt = null;
      this.timeUpdateHandler = throttle(() => {
        this.emitState('MEDIA_STATE_UPDATE');
      }, 400);

      this.handlePlay = this.handlePlay.bind(this);
      this.handlePause = this.handlePause.bind(this);
      this.handleEnded = this.handleEnded.bind(this);
      this.handleLoadedMetadata = this.handleLoadedMetadata.bind(this);
      this.handleStateUpdate = this.handleStateUpdate.bind(this);

      this.attachListeners();
      this.applySettings(settings, ['*']);

      if (this.el.readyState >= 1 || !this.el.paused) {
        this.emitState('MEDIA_DETECTED', { includeArtwork: true });
      }
    }

    attachListeners() {
      this.el.addEventListener('play', this.handlePlay);
      this.el.addEventListener('pause', this.handlePause);
      this.el.addEventListener('ended', this.handleEnded);
      this.el.addEventListener('loadedmetadata', this.handleLoadedMetadata);
      this.el.addEventListener('canplay', this.handleStateUpdate);
      this.el.addEventListener('timeupdate', this.timeUpdateHandler);
      this.el.addEventListener('volumechange', this.handleStateUpdate);
      this.el.addEventListener('ratechange', this.handleStateUpdate);
      this.el.addEventListener('durationchange', this.handleStateUpdate);
      this.el.addEventListener('enterpictureinpicture', this.handleStateUpdate);
      this.el.addEventListener('leavepictureinpicture', this.handleStateUpdate);
      this.el.addEventListener('emptied', this.handleStateUpdate);
    }

    detachListeners() {
      this.el.removeEventListener('play', this.handlePlay);
      this.el.removeEventListener('pause', this.handlePause);
      this.el.removeEventListener('ended', this.handleEnded);
      this.el.removeEventListener('loadedmetadata', this.handleLoadedMetadata);
      this.el.removeEventListener('canplay', this.handleStateUpdate);
      this.el.removeEventListener('timeupdate', this.timeUpdateHandler);
      this.el.removeEventListener('volumechange', this.handleStateUpdate);
      this.el.removeEventListener('ratechange', this.handleStateUpdate);
      this.el.removeEventListener('durationchange', this.handleStateUpdate);
      this.el.removeEventListener('enterpictureinpicture', this.handleStateUpdate);
      this.el.removeEventListener('leavepictureinpicture', this.handleStateUpdate);
      this.el.removeEventListener('emptied', this.handleStateUpdate);
    }

    handlePlay() {
      this.updatedAt = Date.now();
      this.ensureAudioGraph();
      this.resumeAudioContext();
      this.applySettings(settings, ['*']);
      this.emitState('MEDIA_STARTED', { includeArtwork: true });
    }

    handlePause() {
      this.updatedAt = Date.now();
      this.emitState('MEDIA_PAUSED');
    }

    handleEnded() {
      this.updatedAt = Date.now();
      this.emitState('MEDIA_ENDED');
    }

    handleLoadedMetadata() {
      this.updatedAt = Date.now();
      this.applyDefaultSpeed(true);
      this.emitState('MEDIA_DETECTED', { includeArtwork: true });
    }

    handleStateUpdate() {
      this.updatedAt = Date.now();
      this.emitState('MEDIA_STATE_UPDATE');
    }

    ensureAudioGraph() {
      if (this.audioReady) {
        return true;
      }

      try {
        if (!sharedAudioContext) {
          sharedAudioContext = new (
            window.AudioContext || window.webkitAudioContext
          )();
        }

        this.audioCtx = sharedAudioContext;
        if (!this.el.__streamlineSourceNode) {
          this.el.__streamlineSourceNode = this.audioCtx.createMediaElementSource(this.el);
        }

        this.sourceNode = this.el.__streamlineSourceNode;
        this.gainNode = this.audioCtx.createGain();
        this.eqFilters = EQ_FREQUENCIES.map(frequency => {
          const filter = this.audioCtx.createBiquadFilter();
          filter.type = 'peaking';
          filter.frequency.value = frequency;
          filter.Q.value = 1.4;
          return filter;
        });
        this.compressor = this.audioCtx.createDynamicsCompressor();
        this.analyser = this.audioCtx.createAnalyser();
        this.analyser.fftSize = 256;
        this.analyserBuffer = new Uint8Array(this.analyser.frequencyBinCount);

        this.sourceNode.connect(this.gainNode);
        let cursor = this.gainNode;

        for (const filter of this.eqFilters) {
          cursor.connect(filter);
          cursor = filter;
        }

        cursor.connect(this.compressor);
        this.compressor.connect(this.analyser);
        this.analyser.connect(this.audioCtx.destination);
        this.audioReady = true;
        return true;
      } catch (error) {
        console.warn('[StreamLine injected] Audio graph unavailable:', error);
        return false;
      }
    }

    resumeAudioContext() {
      if (!this.audioCtx || this.audioCtx.state !== 'suspended') {
        return;
      }

      this.audioCtx.resume().catch(() => {});
    }

    applySettings(nextSettings, changedKeys) {
      const keys = changedKeys.includes('*')
        ? [
            'defaultSpeed',
            'volumeBoost',
            'eqPreset',
            'customEQ',
            'eqApplyToAudio',
            'speechEnhancer',
            'compressorThreshold',
            'compressorKnee',
            'compressorRatio',
            'compressorAttack',
            'compressorRelease',
            'nightMode',
            'nightModeOpacity',
            'autoSkipSilence',
            'silenceThreshold',
            'silencePadding',
          ]
        : changedKeys;

      if (keys.includes('defaultSpeed')) {
        this.applyDefaultSpeed(false);
      }

      if (
        keys.includes('volumeBoost') ||
        keys.includes('eqPreset') ||
        keys.includes('customEQ') ||
        keys.includes('eqApplyToAudio') ||
        keys.includes('speechEnhancer') ||
        keys.includes('compressorThreshold') ||
        keys.includes('compressorKnee') ||
        keys.includes('compressorRatio') ||
        keys.includes('compressorAttack') ||
        keys.includes('compressorRelease') ||
        keys.includes('autoSkipSilence') ||
        keys.includes('silenceThreshold') ||
        keys.includes('silencePadding')
      ) {
        const shouldTouchAudioGraph = this.audioReady || !this.el.paused;
        if (shouldTouchAudioGraph && this.ensureAudioGraph()) {
          this.resumeAudioContext();
          this.applyBoost();
          this.applyEqualizer();
          this.applySpeechEnhancer();
          this.applySkipSilence();
        }
      }

      if (keys.includes('nightMode') || keys.includes('nightModeOpacity')) {
        this.applyNightMode();
      }
    }

    applyDefaultSpeed(force) {
      const speed = clamp(Number(settings.defaultSpeed) || 1, 0.1, 16);
      if (
        !force &&
        this.defaultSpeedApplied &&
        this.lastDefaultSpeedValue === settings.defaultSpeed
      ) {
        return;
      }

      this.el.playbackRate = speed;
      this.defaultSpeedApplied = true;
      this.lastDefaultSpeedValue = settings.defaultSpeed;
    }

    applyBoost() {
      if (!this.gainNode || !this.audioCtx) {
        return;
      }

      this.gainNode.gain.setTargetAtTime(
        clamp(Number(settings.volumeBoost) || 1, 0, 3),
        this.audioCtx.currentTime,
        0.05,
      );
    }

    applyEqualizer() {
      if (!this.eqFilters.length || !this.audioCtx) {
        return;
      }

      const gains = resolveEqGains();
      const shouldApply =
        this.el.tagName === 'VIDEO' || settings.eqApplyToAudio !== false;

      this.eqFilters.forEach((filter, index) => {
        filter.gain.setTargetAtTime(
          shouldApply ? gains[index] || 0 : 0,
          this.audioCtx.currentTime,
          0.05,
        );
      });
    }

    applySpeechEnhancer() {
      if (!this.compressor) {
        return;
      }

      if (settings.speechEnhancer) {
        this.compressor.threshold.value = Number(settings.compressorThreshold) || -24;
        this.compressor.knee.value = Number(settings.compressorKnee) || 30;
        this.compressor.ratio.value = Number(settings.compressorRatio) || 4;
      } else {
        this.compressor.threshold.value = 0;
        this.compressor.knee.value = 0;
        this.compressor.ratio.value = 1;
      }

      this.compressor.attack.value = Number(settings.compressorAttack) || 0.003;
      this.compressor.release.value = Number(settings.compressorRelease) || 0.25;
    }

    applyNightMode() {
      if (this.el.tagName !== 'VIDEO') {
        return;
      }

      if (!settings.nightMode) {
        this.el.style.filter = this.originalFilter;
        return;
      }

      const sepia = clamp(settings.nightModeOpacity * 2, 0, 1).toFixed(2);
      const brightness = clamp(1 - settings.nightModeOpacity * 0.35, 0.65, 1).toFixed(2);
      const baseFilter = this.originalFilter ? `${this.originalFilter} ` : '';
      this.el.style.filter = `${baseFilter}sepia(${sepia}) brightness(${brightness})`;
    }

    applySkipSilence() {
      this.silenceEnabled = Boolean(settings.autoSkipSilence);
      if (!this.silenceEnabled || !this.analyser || !this.analyserBuffer) {
        this.stopSilenceLoop();
        return;
      }

      if (this.silenceFrame !== null) {
        return;
      }

      const tick = () => {
        if (!this.silenceEnabled) {
          this.stopSilenceLoop();
          return;
        }

        if (!document.hidden && !this.el.paused && Number.isFinite(this.el.duration)) {
          this.analyser.getByteTimeDomainData(this.analyserBuffer);

          let sum = 0;
          for (let index = 0; index < this.analyserBuffer.length; index += 1) {
            const normalized = (this.analyserBuffer[index] - 128) / 128;
            sum += normalized * normalized;
          }

          const rms = Math.sqrt(sum / this.analyserBuffer.length);
          const now = performance.now();
          if (rms < (Number(settings.silenceThreshold) || 0.02)) {
            this.silenceStartAt = this.silenceStartAt || now;
            if (now - this.silenceStartAt > 300) {
              const skipBy = Number(settings.silencePadding) || 0.5;
              this.el.currentTime = Math.min(
                this.el.currentTime + skipBy,
                Math.max(this.el.duration - 0.05, this.el.currentTime),
              );
              this.silenceStartAt = null;
            }
          } else {
            this.silenceStartAt = null;
          }
        } else {
          this.silenceStartAt = null;
        }

        this.silenceFrame = requestAnimationFrame(tick);
      };

      this.silenceFrame = requestAnimationFrame(tick);
    }

    stopSilenceLoop() {
      if (this.silenceFrame !== null) {
        cancelAnimationFrame(this.silenceFrame);
        this.silenceFrame = null;
      }
      this.silenceStartAt = null;
    }

    emitState(action, options) {
      emit(action, {
        media: this.snapshot(options || {}),
      });
    }

    snapshot(options) {
      const now = Date.now();
      const includeArtwork =
        options.includeArtwork ||
        (this.el.tagName === 'VIDEO' && now - this.lastThumbnailAt > 12000);

      if (includeArtwork) {
        this.refreshThumbnail();
      }

      const snapshot = {
        streamlineId: this.id,
        src: this.el.currentSrc || this.el.src || '',
        currentTime: Number.isFinite(this.el.currentTime) ? this.el.currentTime : 0,
        duration: Number.isFinite(this.el.duration) ? this.el.duration : 0,
        paused: this.el.paused,
        muted: this.el.muted || this.el.volume === 0,
        volume: clamp(Number(this.el.volume) || 0, 0, 1),
        playbackRate: clamp(Number(this.el.playbackRate) || 1, 0.1, 16),
        hasVideo: this.el.tagName === 'VIDEO',
        hasAudio: true,
        isPiP: document.pictureInPictureElement === this.el,
        poster: this.el.tagName === 'VIDEO' ? this.el.poster || null : null,
        title: inferTitle(this.el),
      };

      if (includeArtwork) {
        snapshot.thumbnail = this.lastThumbnail;
      }

      return snapshot;
    }

    refreshThumbnail() {
      this.lastThumbnailAt = Date.now();

      if (
        this.el.tagName !== 'VIDEO' ||
        this.el.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
        !this.el.videoWidth ||
        !this.el.videoHeight
      ) {
        return;
      }

      try {
        const canvas = document.createElement('canvas');
        canvas.width = 160;
        canvas.height = 90;
        const context = canvas.getContext('2d');
        context.drawImage(this.el, 0, 0, canvas.width, canvas.height);
        this.lastThumbnail = canvas.toDataURL('image/jpeg', 0.6);
      } catch {
        this.lastThumbnail = this.lastThumbnail || null;
      }
    }

    playPause(forcePause) {
      if (forcePause || !this.el.paused) {
        this.el.pause();
        return;
      }

      this.el.play().catch(() => {});
    }

    seek(time) {
      if (!Number.isFinite(time)) {
        return;
      }

      this.el.currentTime = clamp(time, 0, this.el.duration || Number.MAX_SAFE_INTEGER);
    }

    setVolume(volume) {
      this.el.volume = clamp(Number(volume) || 0, 0, 1);
      this.el.muted = this.el.volume === 0;
      this.emitState('MEDIA_STATE_UPDATE');
    }

    setSpeed(speed) {
      this.el.playbackRate = clamp(Number(speed) || 1, 0.1, 16);
      this.defaultSpeedApplied = true;
      this.emitState('MEDIA_STATE_UPDATE');
    }

    async togglePiP() {
      if (this.el.tagName !== 'VIDEO' || !document.pictureInPictureEnabled) {
        return;
      }

      try {
        if (document.pictureInPictureElement === this.el) {
          await document.exitPictureInPicture();
        } else {
          await this.el.requestPictureInPicture();
        }
      } catch {
        return;
      }

      this.emitState('MEDIA_STATE_UPDATE');
    }

    destroy() {
      this.stopSilenceLoop();
      this.detachListeners();
      this.el.style.filter = this.originalFilter;

      if (this.audioReady) {
        try {
          this.gainNode?.disconnect();
          this.eqFilters.forEach(filter => filter.disconnect());
          this.compressor?.disconnect();
          this.analyser?.disconnect();
        } catch {
          return;
        }
      }
    }
  }

  function resolveEqGains() {
    if (
      settings.eqPreset === 'custom' &&
      Array.isArray(settings.customEQ) &&
      settings.customEQ.length === EQ_FREQUENCIES.length
    ) {
      return settings.customEQ.map(value => clamp(Number(value) || 0, -12, 12));
    }

    return EQ_PRESETS[settings.eqPreset] || EQ_PRESETS.flat;
  }

  function emit(action, payload) {
    window.dispatchEvent(
      new CustomEvent(FROM_PAGE, {
        detail: { action, payload },
      }),
    );
  }

  function inferTitle(element) {
    const candidates = [
      element.getAttribute('aria-label'),
      element.getAttribute('title'),
      document.querySelector('meta[property="og:title"]')?.getAttribute('content'),
      document.querySelector('h1')?.textContent,
      document.title,
      'Media',
    ];

    for (const candidate of candidates) {
      const value = candidate?.trim?.();
      if (value) {
        return value.slice(0, 120);
      }
    }

    return 'Media';
  }

  function throttle(callback, wait) {
    let lastRun = 0;
    let timeoutId = null;

    return function throttled() {
      const now = Date.now();
      const remaining = wait - (now - lastRun);

      if (remaining <= 0) {
        lastRun = now;
        callback();
        return;
      }

      if (timeoutId !== null) {
        return;
      }

      timeoutId = window.setTimeout(() => {
        timeoutId = null;
        lastRun = Date.now();
        callback();
      }, remaining);
    };
  }

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }
})();
