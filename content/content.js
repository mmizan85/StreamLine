(function () {
  if (window.__STREAMLINE_CONTENT_ACTIVE__) {
    return;
  }

  window.__STREAMLINE_CONTENT_ACTIVE__ = true;

  const TO_PAGE = 'STREAMLINE_TO_PAGE';
  const FROM_PAGE = 'STREAMLINE_FROM_PAGE';
  const APPLY_SETTINGS = 'APPLY_SETTINGS';
  const SCAN_MEDIA = 'SCAN_MEDIA';
  const REPORT_ACTIONS = new Set([
    'MEDIA_DETECTED',
    'MEDIA_STATE_UPDATE',
    'MEDIA_STARTED',
    'MEDIA_PAUSED',
    'MEDIA_ENDED',
    'MEDIA_REMOVED',
  ]);
  const COMMAND_ACTIONS = new Set([
    'CMD_PLAY_PAUSE',
    'CMD_SEEK',
    'CMD_SET_VOLUME',
    'CMD_SET_SPEED',
    'CMD_TOGGLE_PIP',
  ]);

  let pageReady = false;
  let queuedSettings = null;
  let scanScheduled = false;

  waitForDocumentElement(injectMainWorldScript);
  wirePageRelay();
  wireRuntimeRelay();
  wireStorageBridge();
  wireDetectionTriggers();
  wireFrameCleanup();

  function waitForDocumentElement(callback) {
    if (document.documentElement) {
      callback();
      return;
    }

    const observer = new MutationObserver(() => {
      if (!document.documentElement) {
        return;
      }

      observer.disconnect();
      callback();
    });

    observer.observe(document, {
      childList: true,
      subtree: true,
    });
  }

  function injectMainWorldScript() {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('content/injected.js');
    script.dataset.streamline = 'true';

    script.addEventListener(
      'load',
      async () => {
        script.remove();
        pageReady = true;

        if (queuedSettings) {
          dispatchToPage(APPLY_SETTINGS, queuedSettings);
        } else {
          const stored = await chrome.storage.sync.get('settings');
          dispatchToPage(APPLY_SETTINGS, {
            settings: stored.settings || {},
            changedKeys: ['*'],
          });
        }

        requestScan('boot');
      },
      { once: true },
    );

    script.addEventListener(
      'error',
      error => {
        console.error('[StreamLine content] Failed to load injected.js:', error);
      },
      { once: true },
    );

    (document.head || document.documentElement).prepend(script);
  }

  function wirePageRelay() {
    window.addEventListener(FROM_PAGE, event => {
      const action = event.detail?.action;
      const payload = event.detail?.payload || {};

      if (!REPORT_ACTIONS.has(action)) {
        return;
      }

      chrome.runtime.sendMessage({ action, payload }).catch(error => {
        if (error?.message?.includes('Extension context invalidated')) {
          return;
        }

        console.warn('[StreamLine content] Failed to forward page event:', error);
      });
    });
  }

  function wireRuntimeRelay() {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!COMMAND_ACTIONS.has(message?.action)) {
        return false;
      }

      dispatchToPage(message.action, message.payload || {});
      sendResponse({ success: true });
      return false;
    });
  }

  function wireStorageBridge() {
    chrome.storage.sync.get('settings').then(stored => {
      const payload = {
        settings: stored.settings || {},
        changedKeys: ['*'],
      };

      if (pageReady) {
        dispatchToPage(APPLY_SETTINGS, payload);
      } else {
        queuedSettings = payload;
      }
    });

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'sync' || !changes.settings) {
        return;
      }

      const oldSettings = changes.settings.oldValue || {};
      const newSettings = changes.settings.newValue || {};
      const changedKeys = Object.keys({
        ...oldSettings,
        ...newSettings,
      }).filter(key => oldSettings[key] !== newSettings[key]);

      const payload = {
        settings: newSettings,
        changedKeys: changedKeys.length ? changedKeys : ['*'],
      };

      if (pageReady) {
        dispatchToPage(APPLY_SETTINGS, payload);
      } else {
        queuedSettings = payload;
      }
    });
  }

  function wireDetectionTriggers() {
    const observer = new MutationObserver(mutations => {
      for (const mutation of mutations) {
        if (mutation.type !== 'childList') {
          continue;
        }

        if (mutation.addedNodes.length || mutation.removedNodes.length) {
          requestScan('mutation');
          break;
        }
      }
    });

    const startObserver = () => {
      if (!document.documentElement) {
        return;
      }

      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
      });
    };

    waitForDocumentElement(startObserver);

    let aggressivePasses = 8;
    const intervalId = setInterval(() => {
      if (aggressivePasses <= 0) {
        clearInterval(intervalId);
        return;
      }

      aggressivePasses -= 1;
      requestScan('aggressive-rescan');
    }, 1500);

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        requestScan('visible');
      }
    });

    window.addEventListener('load', () => requestScan('load'));
    window.addEventListener('pageshow', () => requestScan('pageshow'));
  }

  function wireFrameCleanup() {
    window.addEventListener('pagehide', () => {
      chrome.runtime
        .sendMessage({
          action: 'MEDIA_REMOVED',
          payload: { frameDestroyed: true },
        })
        .catch(() => {});
    });
  }

  function requestScan(reason) {
    if (scanScheduled || !pageReady) {
      return;
    }

    scanScheduled = true;
    setTimeout(() => {
      scanScheduled = false;
      dispatchToPage(SCAN_MEDIA, { reason });
    }, 40);
  }

  function dispatchToPage(action, payload) {
    window.dispatchEvent(
      new CustomEvent(TO_PAGE, {
        detail: { action, payload },
      }),
    );
  }
})();
