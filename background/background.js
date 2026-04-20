import { DEFAULT_SETTINGS, MSG } from '../utils/constants.js';

let mediaTabs = {};
let settings = { ...DEFAULT_SETTINGS };
let restorePromise = restoreState();
let persistTimer = null;
let broadcastTimer = null;

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  const stored = await chrome.storage.sync.get('settings');
  settings = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
  await chrome.storage.sync.set({ settings });

  if (reason === 'install') {
    mediaTabs = {};
    await chrome.storage.session.set({ mediaTabs: {} });
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'sync' || !changes.settings) {
    return;
  }

  settings = { ...DEFAULT_SETTINGS, ...(changes.settings.newValue || {}) };
  scheduleBroadcast();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      const response = await routeMessage(message, sender);
      sendResponse(response);
    } catch (error) {
      console.error('[StreamLine background] Message handling failed:', error);
      sendResponse({ success: false, error: error.message });
    }
  })();

  return true;
});

chrome.tabs.onRemoved.addListener(tabId => {
  removeTab(tabId);
});

chrome.tabs.onActivated.addListener(() => {
  scheduleBroadcast();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    removeTab(tabId);
    return;
  }

  const tabState = mediaTabs[tabId];
  if (!tabState) {
    return;
  }

  let changed = false;
  if (changeInfo.title !== undefined) {
    tabState.title = changeInfo.title || tabState.title;
    changed = true;
  }
  if (changeInfo.favIconUrl !== undefined) {
    tabState.favicon = changeInfo.favIconUrl || '';
    changed = true;
  }
  if (changeInfo.url !== undefined) {
    tabState.url = changeInfo.url || '';
    changed = true;
  }

  if (changed) {
    tabState.updatedAt = Date.now();
    schedulePersist();
    scheduleBroadcast();
  }
});

chrome.commands.onCommand.addListener(async command => {
  await ensureRestored();

  const [activeTab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });

  if (!activeTab?.id) {
    return;
  }

  const target = mediaTabs[activeTab.id];
  if (!target?.media) {
    return;
  }

  switch (command) {
    case 'global-play-pause':
      await dispatchTabCommand(target, MSG.CMD_PLAY_PAUSE, {});
      break;

    case 'global-volume-up':
      await dispatchTabCommand(target, MSG.CMD_SET_VOLUME, {
        volume: clamp((target.media.volume || 0) + 0.1, 0, 1),
      });
      break;

    case 'global-volume-down':
      await dispatchTabCommand(target, MSG.CMD_SET_VOLUME, {
        volume: clamp((target.media.volume || 0) - 0.1, 0, 1),
      });
      break;

    case 'toggle-pip':
      await dispatchTabCommand(target, MSG.CMD_TOGGLE_PIP, {});
      break;
  }
});

async function routeMessage(message, sender) {
  await ensureRestored();

  const action = message?.action;
  const payload = message?.payload || {};
  const senderTab = sender?.tab;
  const tabId = senderTab?.id;
  const frameId = sender?.frameId ?? 0;

  switch (action) {
    case MSG.MEDIA_DETECTED:
    case MSG.MEDIA_STATE_UPDATE:
    case MSG.MEDIA_STARTED:
    case MSG.MEDIA_PAUSED:
    case MSG.MEDIA_ENDED: {
      if (!tabId || !payload.media?.streamlineId) {
        return { success: false, error: 'Missing media payload.' };
      }

      const updatedTab = upsertMediaState(senderTab, frameId, payload.media);

      if (action === MSG.MEDIA_STARTED) {
        await handleMultiTabSync(tabId);
      }

      return { success: true, media: updatedTab?.media || null };
    }

    case MSG.MEDIA_REMOVED: {
      if (!tabId) {
        return { success: true };
      }

      if (payload.frameDestroyed) {
        removeFrame(tabId, frameId);
      } else if (payload.streamlineId) {
        removeMedia(tabId, frameId, payload.streamlineId);
      }

      return { success: true };
    }

    case MSG.GET_ALL_STATE:
      return {
        success: true,
        mediaTabs: buildPopupState(),
        settings,
      };

    case MSG.TAB_COMMAND: {
      const tabState = mediaTabs[payload.tabId];
      if (!tabState) {
        return { success: false, error: 'Target tab is no longer tracked.' };
      }

      if (
        payload.command?.action === MSG.CMD_PLAY_PAUSE &&
        !payload.command.payload?.forcePause &&
        settings.multiTabSync
      ) {
        const targetMedia = resolveTargetMedia(
          tabState,
          payload.frameId,
          payload.streamlineId,
        );

        if (targetMedia?.paused) {
          await handleMultiTabSync(payload.tabId);
        }
      }

      try {
        const result = await sendCommandToTarget(
          payload.tabId,
          payload.frameId,
          payload.streamlineId,
          payload.command,
        );
        return { success: true, result };
      } catch (error) {
        cleanupDeadTarget(payload.tabId, payload.frameId, payload.streamlineId);
        return { success: false, error: error.message };
      }
    }

    case MSG.SETTINGS_UPDATE: {
      settings = { ...settings, ...payload };
      await chrome.storage.sync.set({ settings });
      scheduleBroadcast();
      return { success: true, settings };
    }

    default:
      return { success: false, error: `Unknown action: ${action}` };
  }
}

function upsertMediaState(senderTab, frameId, mediaPatch) {
  const tabId = senderTab.id;
  const tabState = mediaTabs[tabId] || createTabState(senderTab);
  const mediaKey = createMediaKey(frameId, mediaPatch.streamlineId);
  const previous = tabState.medias[mediaKey] || {};

  tabState.title = senderTab.title || tabState.title;
  tabState.url = senderTab.url || tabState.url;
  tabState.favicon = senderTab.favIconUrl || tabState.favicon;
  tabState.medias[mediaKey] = {
    ...previous,
    ...mediaPatch,
    frameId,
    streamlineId: mediaPatch.streamlineId,
    mediaKey,
    updatedAt: Date.now(),
  };

  rebuildTabState(tabState);
  mediaTabs[tabId] = tabState;
  schedulePersist();
  scheduleBroadcast();
  return tabState;
}

function removeMedia(tabId, frameId, streamlineId) {
  const tabState = mediaTabs[tabId];
  if (!tabState) {
    return;
  }

  delete tabState.medias[createMediaKey(frameId, streamlineId)];
  finalizeTabRemoval(tabState);
}

function removeFrame(tabId, frameId) {
  const tabState = mediaTabs[tabId];
  if (!tabState) {
    return;
  }

  for (const [mediaKey, mediaState] of Object.entries(tabState.medias)) {
    if (mediaState.frameId === frameId) {
      delete tabState.medias[mediaKey];
    }
  }

  finalizeTabRemoval(tabState);
}

function removeTab(tabId) {
  if (!mediaTabs[tabId]) {
    return;
  }

  delete mediaTabs[tabId];
  schedulePersist();
  scheduleBroadcast();
}

function finalizeTabRemoval(tabState) {
  rebuildTabState(tabState);

  if (!tabState.mediaCount) {
    delete mediaTabs[tabState.tabId];
  } else {
    mediaTabs[tabState.tabId] = tabState;
  }

  schedulePersist();
  scheduleBroadcast();
}

function rebuildTabState(tabState) {
  const medias = Object.values(tabState.medias).filter(Boolean);
  medias.sort(compareMediaPriority);

  tabState.mediaCount = medias.length;
  tabState.playingCount = medias.filter(media => media.paused === false).length;
  tabState.media = medias[0] || null;
  tabState.updatedAt = Date.now();
}

function compareMediaPriority(left, right) {
  return (
    getMediaPriority(right) - getMediaPriority(left) ||
    (right.updatedAt || 0) - (left.updatedAt || 0)
  );
}

function getMediaPriority(media) {
  let score = 0;

  if (media.paused === false) {
    score += 100;
  }
  if (media.isPiP) {
    score += 10;
  }
  if (media.hasVideo) {
    score += 5;
  }

  return score;
}

async function handleMultiTabSync(playingTabId) {
  if (!settings.multiTabSync) {
    return;
  }

  const tasks = [];

  for (const tabState of Object.values(mediaTabs)) {
    if (tabState.tabId === playingTabId) {
      continue;
    }

    for (const mediaState of Object.values(tabState.medias)) {
      if (mediaState.paused !== false) {
        continue;
      }

      tasks.push(
        sendCommandToTarget(tabState.tabId, mediaState.frameId, mediaState.streamlineId, {
          action: MSG.CMD_PLAY_PAUSE,
          payload: { forcePause: true },
        }).catch(() => {
          cleanupDeadTarget(
            tabState.tabId,
            mediaState.frameId,
            mediaState.streamlineId,
          );
        }),
      );

      mediaState.paused = true;
    }

    rebuildTabState(tabState);
  }

  if (tasks.length) {
    await Promise.allSettled(tasks);
    schedulePersist();
    scheduleBroadcast();
  }
}

async function dispatchTabCommand(tabState, action, payload) {
  try {
    await sendCommandToTarget(
      tabState.tabId,
      tabState.media.frameId,
      tabState.media.streamlineId,
      { action, payload },
    );
  } catch (error) {
    cleanupDeadTarget(
      tabState.tabId,
      tabState.media.frameId,
      tabState.media.streamlineId,
    );
  }
}

async function sendCommandToTarget(tabId, frameId, streamlineId, command) {
  const payload = {
    ...(command.payload || {}),
    streamlineId,
  };
  const message = {
    action: command.action,
    payload,
  };

  if (Number.isInteger(frameId)) {
    return chrome.tabs.sendMessage(tabId, message, { frameId });
  }

  return chrome.tabs.sendMessage(tabId, message);
}

function cleanupDeadTarget(tabId, frameId, streamlineId) {
  if (streamlineId) {
    removeMedia(tabId, frameId, streamlineId);
    return;
  }

  if (Number.isInteger(frameId)) {
    removeFrame(tabId, frameId);
  } else {
    removeTab(tabId);
  }
}

function resolveTargetMedia(tabState, frameId, streamlineId) {
  if (streamlineId && Number.isInteger(frameId)) {
    return tabState.medias[createMediaKey(frameId, streamlineId)] || null;
  }

  return tabState.media || null;
}

function createTabState(tab) {
  return {
    tabId: tab.id,
    title: tab.title || 'Untitled tab',
    url: tab.url || '',
    favicon: tab.favIconUrl || '',
    medias: {},
    mediaCount: 0,
    playingCount: 0,
    media: null,
    updatedAt: Date.now(),
  };
}

function createMediaKey(frameId, streamlineId) {
  return `${frameId}:${streamlineId}`;
}

function buildPopupState() {
  return Object.values(mediaTabs).map(tabState => ({
    tabId: tabState.tabId,
    title: tabState.title,
    url: tabState.url,
    favicon: tabState.favicon,
    mediaCount: tabState.mediaCount,
    playingCount: tabState.playingCount,
    updatedAt: tabState.updatedAt,
    media: tabState.media,
  }));
}

async function restoreState() {
  try {
    const [sessionState, syncState] = await Promise.all([
      chrome.storage.session.get('mediaTabs'),
      chrome.storage.sync.get('settings'),
    ]);

    settings = { ...DEFAULT_SETTINGS, ...(syncState.settings || {}) };
    mediaTabs = sanitizeStoredState(sessionState.mediaTabs || {});
    await pruneClosedTabs();
  } catch (error) {
    console.error('[StreamLine background] Failed to restore state:', error);
    mediaTabs = {};
    settings = { ...DEFAULT_SETTINGS };
  }
}

async function ensureRestored() {
  await restorePromise;
}

async function pruneClosedTabs() {
  const liveTabs = await chrome.tabs.query({});
  const liveIds = new Set(liveTabs.map(tab => tab.id));

  for (const tabId of Object.keys(mediaTabs)) {
    if (!liveIds.has(Number(tabId))) {
      delete mediaTabs[tabId];
    }
  }
}

function sanitizeStoredState(storedTabs) {
  const nextState = {};

  for (const [tabId, tabState] of Object.entries(storedTabs)) {
    if (!tabState?.tabId) {
      continue;
    }

    const medias = {};
    for (const [mediaKey, mediaState] of Object.entries(tabState.medias || {})) {
      if (mediaState?.streamlineId) {
        medias[mediaKey] = mediaState;
      }
    }

    const nextTab = {
      tabId: tabState.tabId,
      title: tabState.title || 'Untitled tab',
      url: tabState.url || '',
      favicon: tabState.favicon || '',
      medias,
      mediaCount: 0,
      playingCount: 0,
      media: null,
      updatedAt: tabState.updatedAt || Date.now(),
    };

    rebuildTabState(nextTab);
    if (nextTab.mediaCount) {
      nextState[tabId] = nextTab;
    }
  }

  return nextState;
}

function schedulePersist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const serializable = {};

    for (const [tabId, tabState] of Object.entries(mediaTabs)) {
      serializable[tabId] = {
        tabId: tabState.tabId,
        title: tabState.title,
        url: tabState.url,
        favicon: tabState.favicon,
        updatedAt: tabState.updatedAt,
        medias: stripLargePayloads(tabState.medias),
      };
    }

    chrome.storage.session.set({ mediaTabs: serializable }).catch(error => {
      console.error('[StreamLine background] Failed to persist media state:', error);
    });
  }, 80);
}

function stripLargePayloads(medias) {
  const next = {};

  for (const [mediaKey, mediaState] of Object.entries(medias)) {
    next[mediaKey] = {
      ...mediaState,
      thumbnail: null,
    };
  }

  return next;
}

function scheduleBroadcast() {
  clearTimeout(broadcastTimer);
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    chrome.runtime
      .sendMessage({
        action: MSG.STATE_PUSH,
        mediaTabs: buildPopupState(),
        settings,
      })
      .catch(() => {});
  }, 60);
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}
