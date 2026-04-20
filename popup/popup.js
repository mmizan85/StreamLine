// =============================================================================
// popup/popup.js — StreamLine v2 Popup Controller
//
// KEY CHANGES FROM v1:
//   • selectPrimary() — picks PLAYING tab (most recent) regardless of
//     which Chrome tab is active in the browser. Falls back to most-
//     recently-updated tab if everything is paused.
//   • getThumbnail() — NO canvas capture. Priority order:
//       1. YouTube video ID → img.youtube.com CDN thumbnail (never CORS)
//       2. media.poster    (video element's poster= attribute)
//       3. tabState.favicon (tab favicon URL)
//       4. null            → default music-note SVG in HTML
//   • Other-tabs section is display:none when empty (hidden attribute).
//   • EQ visualizer toggles via CSS class — zero JS animation overhead.
//   • Seek bar uses Pointer Events API (mouse + touch + stylus unified).
//   • All tab-card DOM updates use keyed reconciliation (no innerHTML wipe).
// =============================================================================

import { MSG, SPEED_STEPS } from '../utils/constants.js';
import { throttle } from '../utils/debounce.js';

// =============================================================================
// SECTION 1: Working state
// =============================================================================

const S = {
  tabs: [], // All tracked MediaTabState objects from background
  primary: null, // The tab currently shown in the primary card
  settings: {}, // Current user settings
  isDragging: false, // Seek bar drag active
  isVolDrag: false, // Volume drag active
};

// =============================================================================
// SECTION 2: DOM cache
// =============================================================================

const $ = id => document.getElementById(id);

const D = {
  // Views
  vLoad: $('view-loading'),
  vEmpty: $('view-empty'),
  vActive: $('view-active'),

  // Primary card
  pc: $('primary-card'),
  pcThumbImg: $('pc-thumb-img'),
  pcThumbIco: $('pc-thumb-icon'),
  pcTitle: $('pc-title'),
  pcSource: $('pc-source'),
  eqViz: $('eq-viz'),

  // Seek bar
  seekTrack: $('seek-track'),
  seekFill: $('seek-fill'),
  seekThumb: $('seek-thumb'),
  seekCur: $('seek-cur'),
  seekDur: $('seek-dur'),

  // Controls
  btnPlay: $('btn-play-pause'),
  iconPlay: document.querySelector('.icon-play'),
  iconPause: document.querySelector('.icon-pause'),
  btnSkipB: $('btn-skip-back'),
  btnSkipF: $('btn-skip-fwd'),
  btnMute: $('btn-mute'),
  iconVolOn: $('icon-vol-on'),
  iconVolOff: $('icon-vol-off'),
  volSlider: $('vol-slider'),
  btnSpeed: $('btn-speed'),
  speedVal: $('speed-val'),
  btnPip: $('btn-pip'),

  // Other tabs
  otSection: $('other-tabs-section'),
  otCount: $('ot-count'),
  otList: $('ot-list'),
  btnPauseAll: $('btn-pause-all'),

  // Topbar
  btnSync: $('btn-sync'),
  btnSettings: $('btn-settings'),
};

// =============================================================================
// SECTION 3: View management
// =============================================================================

/**
 * Show exactly one view; hide the others.
 * Uses [hidden] attribute so CSS :not([hidden]) selectors apply correctly.
 * @param {'loading'|'empty'|'active'} name
 */
function showView(name) {
  [D.vLoad, D.vEmpty, D.vActive].forEach(el => {
    el.hidden = el.id !== `view-${name}`;
  });
}

// =============================================================================
// SECTION 4: Thumbnail strategy — no canvas, no video frame capture
// =============================================================================

/**
 * Return the best static thumbnail URL for a tab, or null.
 *
 * Priority:
 *   1. YouTube video CDN thumbnail — derived from URL, always cross-origin safe
 *   2. media.poster — the HTML <video poster="…"> attribute
 *   3. tabState.favicon — Chrome tab favicon
 *   4. null → fallback music-note icon (rendered in HTML, not here)
 *
 * @param {object} tabState — MediaTabState from background registry
 * @returns {string|null}
 */
function getThumbnail(tabState) {
  // 1 — YouTube (most reliable, serves fast CDN images, no CORS)
  const yt = extractYouTubeThumbnail(tabState.url);
  if (yt) return yt;

  // 2 — Video poster attribute (set by the site, e.g. Netflix, Vimeo)
  if (tabState.media?.poster) return tabState.media.poster;

  // 3 — Tab favicon (small but better than nothing for audio tabs)
  if (tabState.favicon) return tabState.favicon;

  return null;
}

/**
 * Derive a YouTube thumbnail URL from a watch or short URL.
 * Uses img.youtube.com — no API key, no CORS.
 * mqdefault = 320×180, good quality, always exists.
 *
 * @param {string} url
 * @returns {string|null}
 */
function extractYouTubeThumbnail(url) {
  try {
    const u = new URL(url || '');

    // Standard watch URL: youtube.com/watch?v=VIDEO_ID
    if (u.hostname.includes('youtube.com')) {
      const vid = u.searchParams.get('v');
      if (vid) return `https://img.youtube.com/vi/${vid}/mqdefault.jpg`;
    }

    // Short URL: youtu.be/VIDEO_ID
    if (u.hostname === 'youtu.be') {
      const vid = u.pathname.slice(1).split('?')[0];
      if (vid) return `https://img.youtube.com/vi/${vid}/mqdefault.jpg`;
    }
  } catch {
    /* Invalid URL — ignore */
  }
  return null;
}

// =============================================================================
// SECTION 5: Primary tab selection
// =============================================================================

/**
 * From the full list of tracked tabs, select the one to feature in the
 * primary card.
 *
 * Rules (in priority order):
 *   1. Currently playing tabs — sorted by most recently updated (lastUpdated)
 *   2. All paused — most recently updated tab wins
 *   3. No tabs — null
 *
 * This is INDEPENDENT of which Chrome tab is currently focused. The
 * requirement is: "the media that is currently playing", not "the active tab".
 *
 * @param {object[]} tabs — All tracked MediaTabState objects
 * @returns {object|null}
 */
function selectPrimary(tabs) {
  if (!tabs.length) return null;

  const playing = tabs
    .filter(t => t.media && t.media.paused === false)
    .sort((a, b) => (b.lastUpdated || 0) - (a.lastUpdated || 0));

  if (playing.length) return playing[0];

  // Nothing playing — show most recently touched tab so user can resume
  return [...tabs].sort(
    (a, b) => (b.lastUpdated || 0) - (a.lastUpdated || 0),
  )[0];
}

// =============================================================================
// SECTION 6: State processor — called on GET_ALL_STATE reply and STATE_PUSH
// =============================================================================

async function processState(mediaTabs, settings) {
  S.tabs = Array.isArray(mediaTabs) ? mediaTabs : [];
  S.settings = settings || {};

  if (!S.tabs.length) {
    showView('empty');
    return;
  }

  // Select primary
  S.primary = selectPrimary(S.tabs);

  // Other tabs = everything that isn't the primary
  const others = S.tabs.filter(t => t !== S.primary);

  showView('active');
  renderPrimary(S.primary);
  renderOtherTabs(others);
  renderSyncPill(S.settings.multiTabSync);
}

// =============================================================================
// SECTION 7: Primary card renderer
// =============================================================================

function renderPrimary(tab) {
  if (!tab) return;
  const media = tab.media || {};
  const isPlaying = media.paused === false;

  // ── Thumbnail ─────────────────────────────────────────────
  const thumbSrc = getThumbnail(tab);

  if (thumbSrc) {
    D.pcThumbImg.src = thumbSrc;
    D.pcThumbImg.hidden = false;
    D.pcThumbIco.style.display = 'none';

    // If the image fails to load (cross-origin block, 404 etc.) show fallback
    D.pcThumbImg.onerror = () => {
      D.pcThumbImg.hidden = true;
      D.pcThumbIco.style.display = '';
    };
  } else {
    D.pcThumbImg.hidden = true;
    D.pcThumbIco.style.display = '';
  }

  // ── Title ─────────────────────────────────────────────────
  const title = media.title || tab.title || 'Unknown media';
  D.pcTitle.textContent = title;
  D.pcTitle.title = title; // Native tooltip on hover for truncated titles

  // ── Source line ───────────────────────────────────────────
  const host = extractHost(tab.url);
  const speed =
    (media.playbackRate || 1) !== 1 ? ` · ${fmtSpeed(media.playbackRate)}` : '';
  D.pcSource.textContent =
    [host, isPlaying ? 'now playing' : 'paused'].filter(Boolean).join(' · ') +
    speed;

  // ── EQ Visualizer — pure CSS, just toggle a class ────────
  D.eqViz.classList.toggle('is-playing', isPlaying);

  // ── Play / Pause button ───────────────────────────────────
  D.btnPlay.setAttribute('aria-pressed', isPlaying ? 'true' : 'false');
  D.btnPlay.setAttribute('aria-label', isPlaying ? 'Pause' : 'Play');
  D.iconPlay.style.display = isPlaying ? 'none' : '';
  D.iconPause.style.display = isPlaying ? '' : 'none';

  // ── Seek bar (only update when not dragging) ──────────────
  if (!S.isDragging) {
    updateSeekBar(media.currentTime || 0, media.duration || 0);
  }

  // ── Volume ────────────────────────────────────────────────
  if (!S.isVolDrag) {
    D.volSlider.value = Math.round((media.volume ?? 1) * 100);
  }
  applyMuteIcon(!!media.muted);

  // ── Speed badge ───────────────────────────────────────────
  const rate = media.playbackRate || 1;
  D.speedVal.textContent = fmtSpeed(rate);
  D.btnSpeed.setAttribute('aria-label', `Playback speed: ${fmtSpeed(rate)}`);
  D.btnSpeed.classList.toggle('is-modified', rate !== 1.0);

  // ── PiP button — only show for video media ────────────────
  D.btnPip.hidden = !media.hasVideo;
  D.btnPip.setAttribute('aria-pressed', media.isPiP ? 'true' : 'false');
}

function updateSeekBar(current, duration) {
  const pct = duration > 0 ? (current / duration) * 100 : 0;
  const pStr = `${pct.toFixed(2)}%`;

  D.seekFill.style.width = pStr;
  D.seekThumb.style.left = pStr;
  D.seekCur.textContent = fmtTime(current);
  D.seekDur.textContent = fmtTime(duration);

  D.seekTrack.setAttribute('aria-valuenow', Math.round(pct));
  D.seekTrack.setAttribute('aria-valuemax', Math.round(duration));
  D.seekTrack.setAttribute(
    'aria-valuetext',
    `${fmtTime(current)} of ${fmtTime(duration)}`,
  );
}

// =============================================================================
// SECTION 8: Other-tabs list renderer
// =============================================================================

/**
 * Render the other-tabs section.
 *
 * CRITICAL REQUIREMENT: if there are no other-tabs, hide the entire section
 * (not just the list — the whole container including its header).
 *
 * Uses keyed DOM reconciliation so existing cards are updated in-place
 * rather than wiped and recreated (preserves event listeners, avoids flash).
 *
 * @param {object[]} tabs — All tabs except the primary
 */
function renderOtherTabs(tabs) {
  // ── SECTION VISIBILITY ─────────────────────────────────────
  // The [hidden] attribute drives both display:none AND ARIA visibility.
  if (!tabs.length) {
    D.otSection.hidden = true;
    return;
  }
  D.otSection.hidden = false;

  // Update count badge
  D.otCount.textContent = String(tabs.length);

  // Show "Pause all" only when at least one tab is playing
  const anyPlaying = tabs.some(t => t.media && !t.media.paused);
  D.btnPauseAll.style.display = anyPlaying ? '' : 'none';

  // ── KEYED RECONCILIATION ────────────────────────────────────
  // Build a map of currently-rendered cards keyed by tabId
  const existing = new Map();
  D.otList.querySelectorAll('[data-tab-id]').forEach(el => {
    existing.set(Number(el.dataset.tabId), el);
  });

  // Remove stale cards (tabs no longer in the list)
  const incomingIds = new Set(tabs.map(t => t.tabId));
  existing.forEach((el, id) => {
    if (!incomingIds.has(id)) el.remove();
  });

  // Create or update, maintaining order
  tabs.forEach((tab, i) => {
    let item = existing.get(tab.tabId);

    if (item) {
      updateOtItem(item, tab); // Update in-place
    } else {
      item = createOtItem(tab); // Build new DOM node
      D.otList.appendChild(item);
    }

    // Enforce order (insertBefore is a no-op if already in position)
    const sibling = D.otList.children[i];
    if (sibling !== item) D.otList.insertBefore(item, sibling || null);
  });
}

/**
 * Build the DOM for a single other-tab list item.
 * Structure (always in this flex order so play button NEVER shifts):
 *   [play-btn] [thumb] [info: title + subtitle]
 *
 * @param {object} tab — MediaTabState
 * @returns {HTMLLIElement}
 */
function createOtItem(tab) {
  const media = tab.media || {};
  const paused = media.paused !== false;
  const title = truncate(media.title || tab.title || 'Unknown', 54);
  const host = extractHost(tab.url);
  const thumb = getThumbnail(tab);
  const time = media.currentTime ? fmtTime(media.currentTime) : null;

  const li = document.createElement('li');
  li.className = 'ot-item';
  li.dataset.tabId = tab.tabId;
  li.dataset.paused = String(paused);
  li.setAttribute('role', 'listitem');

  li.innerHTML = `
    <button class="ot-play-btn"
            data-action="play-pause"
            aria-label="${paused ? 'Play' : 'Pause'} — ${esc(title)}">
      ${
        paused
          ? `<svg viewBox="0 0 12 12"><path d="M2 1l8 5-8 5z" fill="currentColor"/></svg>`
          : `<svg viewBox="0 0 12 12">
             <rect x="1.5" y="1" width="3.5" height="10" rx="1" fill="currentColor"/>
             <rect x="7"   y="1" width="3.5" height="10" rx="1" fill="currentColor"/>
           </svg>`
      }
    </button>

    <div class="ot-thumb-shell" aria-hidden="true">
      ${
        thumb
          ? `<img class="ot-thumb-img" src="${escAttr(thumb)}" alt="" loading="lazy"
                onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"/>
           <div class="ot-thumb-fallback" style="display:none">
             <svg viewBox="0 0 16 16"><path d="M12 2v8.5A3 3 0 1013 13V5.2l2 .5V3.3L12 2zM8 14a1 1 0 110-2 1 1 0 010 2z" fill="currentColor"/></svg>
           </div>`
          : `<div class="ot-thumb-fallback">
             <svg viewBox="0 0 16 16"><path d="M12 2v8.5A3 3 0 1013 13V5.2l2 .5V3.3L12 2zM8 14a1 1 0 110-2 1 1 0 010 2z" fill="currentColor"/></svg>
           </div>`
      }
    </div>

    <div class="ot-info">
      <div class="ot-title" title="${escAttr(title)}">${esc(title)}</div>
      <div class="ot-sub">
        <span class="live-dot" aria-hidden="true"></span>
        ${esc(host)}${time ? ` · ${time}` : ''}${paused ? ' · paused' : ''}
      </div>
    </div>
  `;

  // Clicking the row body (not the button) → focus the tab in Chrome
  li.addEventListener('click', e => {
    if (e.target.closest('[data-action="play-pause"]')) return;
    chrome.tabs.update(tab.tabId, { active: true });
  });

  // Play/pause button
  li.querySelector('[data-action="play-pause"]').addEventListener(
    'click',
    e => {
      e.stopPropagation();
      sendCmd(tab.tabId, { action: MSG.CMD_PLAY_PAUSE, payload: {} });
    },
  );

  return li;
}

/**
 * Update an existing other-tab card in-place — only writes DOM where the
 * data has actually changed. Avoids a full innerHTML wipe which would:
 *   - Destroy event listeners
 *   - Cause layout recalc and repaint flash
 *   - Lose any browser-native focus state
 *
 * @param {HTMLLIElement} item
 * @param {object}        tab
 */
function updateOtItem(item, tab) {
  const media = tab.media || {};
  const paused = media.paused !== false;
  const title = truncate(media.title || tab.title || 'Unknown', 54);
  const host = extractHost(tab.url);
  const time = media.currentTime ? fmtTime(media.currentTime) : null;

  // Paused data-attribute (drives CSS for live-dot colour)
  if (item.dataset.paused !== String(paused)) {
    item.dataset.paused = String(paused);
  }

  // Play button icon + label
  const btn = item.querySelector('[data-action="play-pause"]');
  if (btn) {
    btn.setAttribute('aria-label', `${paused ? 'Play' : 'Pause'} — ${title}`);
    btn.innerHTML = paused
      ? `<svg viewBox="0 0 12 12"><path d="M2 1l8 5-8 5z" fill="currentColor"/></svg>`
      : `<svg viewBox="0 0 12 12">
           <rect x="1.5" y="1" width="3.5" height="10" rx="1" fill="currentColor"/>
           <rect x="7"   y="1" width="3.5" height="10" rx="1" fill="currentColor"/>
         </svg>`;
  }

  // Title (only write if changed — DOM writes are expensive)
  const titleEl = item.querySelector('.ot-title');
  if (titleEl && titleEl.textContent !== title) {
    titleEl.textContent = title;
    titleEl.title = title;
  }

  // Subtitle (time changes every ~500ms from MEDIA_STATE_UPDATE, so always rewrite)
  const sub = item.querySelector('.ot-sub');
  if (sub) {
    sub.innerHTML = `
      <span class="live-dot" aria-hidden="true"></span>
      ${esc(host)}${time ? ` · ${time}` : ''}${paused ? ' · paused' : ''}
    `;
  }
}

// =============================================================================
// SECTION 9: Sync pill
// =============================================================================

function renderSyncPill(enabled) {
  if (!D.btnSync) return;
  D.btnSync.setAttribute('aria-checked', enabled ? 'true' : 'false');
  D.btnSync.querySelector('.sync-label').textContent = enabled ? 'Sync' : 'Off';
}

// =============================================================================
// SECTION 10: Background communication helpers
// =============================================================================

/**
 * Send a command to a specific tab via the background service worker.
 * @param {number} tabId
 * @param {object} command — { action: MSG.CMD_*, payload: {...} }
 */
async function sendCmd(tabId, command) {
  try {
    return await chrome.runtime.sendMessage({
      action: MSG.TAB_COMMAND,
      payload: { tabId, command },
    });
  } catch (err) {
    // Extension context invalidated (popup closing) or SW restarting — benign
    if (!err?.message?.includes('Extension context invalidated')) {
      console.warn('[StreamLine Popup] sendCmd error:', err?.message);
    }
  }
}

// Throttled seek: fires at most every 100ms while dragging for smooth response
const sendSeekThrottled = throttle(time => {
  if (S.primary)
    sendCmd(S.primary.tabId, { action: MSG.CMD_SEEK, payload: { time } });
}, 100);

// Throttled volume: fires at most every 80ms while slider moves
const sendVolThrottled = throttle(vol => {
  if (S.primary)
    sendCmd(S.primary.tabId, {
      action: MSG.CMD_SET_VOLUME,
      payload: { volume: vol / 100 }, // Slider 0–100; Web Audio expects 0.0–1.0
    });
}, 80);

// Listen for state push from background (fires on any media event in any tab)
chrome.runtime.onMessage.addListener(msg => {
  if (msg.action === MSG.STATE_PUSH) {
    processState(msg.mediaTabs, msg.settings);
  }
});

// =============================================================================
// SECTION 11: Event listeners
// =============================================================================

function initEvents() {
  // ── Play / Pause ──────────────────────────────────────────────────────────
  D.btnPlay.addEventListener('click', () => {
    if (!S.primary) return;
    const playing = D.btnPlay.getAttribute('aria-pressed') === 'true';
    // Optimistic UI — don't wait for STATE_PUSH to toggle icons
    const willPlay = !playing;
    D.btnPlay.setAttribute('aria-pressed', willPlay ? 'true' : 'false');
    D.btnPlay.setAttribute('aria-label', willPlay ? 'Pause' : 'Play');
    D.iconPlay.style.display = willPlay ? 'none' : '';
    D.iconPause.style.display = willPlay ? '' : 'none';
    D.eqViz.classList.toggle('is-playing', willPlay);
    sendCmd(S.primary.tabId, { action: MSG.CMD_PLAY_PAUSE, payload: {} });
  });

  // ── Skip back 10 s ────────────────────────────────────────────────────────
  D.btnSkipB.addEventListener('click', () => {
    if (!S.primary?.media) return;
    const t = Math.max(0, (S.primary.media.currentTime || 0) - 10);
    updateSeekBar(t, S.primary.media.duration || 0);
    sendCmd(S.primary.tabId, { action: MSG.CMD_SEEK, payload: { time: t } });
  });

  // ── Skip forward 10 s ─────────────────────────────────────────────────────
  D.btnSkipF.addEventListener('click', () => {
    if (!S.primary?.media) return;
    const dur = S.primary.media.duration || 0;
    const t = Math.min(dur, (S.primary.media.currentTime || 0) + 10);
    updateSeekBar(t, dur);
    sendCmd(S.primary.tabId, { action: MSG.CMD_SEEK, payload: { time: t } });
  });

  // ── Mute toggle ───────────────────────────────────────────────────────────
  D.btnMute.addEventListener('click', () => {
    if (!S.primary) return;
    const nowMuted = D.btnMute.getAttribute('aria-pressed') === 'true';
    const nextMuted = !nowMuted;
    applyMuteIcon(nextMuted);
    // Mute = set volume to 0; unmute = restore slider value
    const restoreVol = nextMuted ? 0 : Number(D.volSlider.value) / 100;
    sendCmd(S.primary.tabId, {
      action: MSG.CMD_SET_VOLUME,
      payload: { volume: restoreVol },
    });
  });

  // ── Volume slider ─────────────────────────────────────────────────────────
  D.volSlider.addEventListener('pointerdown', () => {
    S.isVolDrag = true;
  });
  D.volSlider.addEventListener('pointerup', () => {
    S.isVolDrag = false;
  });
  D.volSlider.addEventListener('input', () => {
    const v = Number(D.volSlider.value);
    applyMuteIcon(v === 0);
    sendVolThrottled(v);
  });

  // ── Speed — left-click cycles forward; right-click resets to 1× ──────────
  D.btnSpeed.addEventListener('click', () => {
    if (!S.primary?.media) return;
    const next = stepSpeed(S.primary.media.playbackRate || 1, +1);
    D.speedVal.textContent = fmtSpeed(next);
    D.btnSpeed.classList.toggle('is-modified', next !== 1.0);
    sendCmd(S.primary.tabId, {
      action: MSG.CMD_SET_SPEED,
      payload: { speed: next },
    });
  });

  D.btnSpeed.addEventListener('contextmenu', e => {
    e.preventDefault();
    if (!S.primary) return;
    D.speedVal.textContent = '1.0×';
    D.btnSpeed.classList.remove('is-modified');
    sendCmd(S.primary.tabId, {
      action: MSG.CMD_SET_SPEED,
      payload: { speed: 1.0 },
    });
  });

  // ── PiP ───────────────────────────────────────────────────────────────────
  D.btnPip.addEventListener('click', () => {
    if (!S.primary) return;
    sendCmd(S.primary.tabId, { action: MSG.CMD_TOGGLE_PIP, payload: {} });
  });

  // ── Pause all background tabs ─────────────────────────────────────────────
  D.btnPauseAll.addEventListener('click', () => {
    S.tabs
      .filter(t => t !== S.primary && t.media && !t.media.paused)
      .forEach(t =>
        sendCmd(t.tabId, {
          action: MSG.CMD_PLAY_PAUSE,
          payload: { forcePause: true },
        }),
      );
  });

  // ── Sync toggle ───────────────────────────────────────────────────────────
  D.btnSync.addEventListener('click', () => {
    const cur = D.btnSync.getAttribute('aria-checked') === 'true';
    const next = !cur;
    renderSyncPill(next);
    chrome.runtime.sendMessage({
      action: MSG.SETTINGS_UPDATE,
      payload: { multiTabSync: next },
    });
  });

  // ── Settings page ─────────────────────────────────────────────────────────
  D.btnSettings.addEventListener('click', () =>
    chrome.runtime.openOptionsPage(),
  );

  // ── Seek bar ──────────────────────────────────────────────────────────────
  initSeekBar();
}

// =============================================================================
// SECTION 12: Seek bar — Pointer Events API
// Pointer Events unify mouse, touch, and stylus in one handler set.
// setPointerCapture ensures pointermove fires even outside the element.
// =============================================================================

function initSeekBar() {
  /** Convert a clientX position to a 0–100 percentage along the track. */
  function xToPct(clientX) {
    const r = D.seekTrack.getBoundingClientRect();
    return Math.max(0, Math.min(100, ((clientX - r.left) / r.width) * 100));
  }

  /** Apply a seek percentage: update UI + throttled command */
  function applyPct(pct) {
    D.seekFill.style.width = `${pct}%`;
    D.seekThumb.style.left = `${pct}%`;
    const dur = S.primary?.media?.duration || 0;
    const time = (pct / 100) * dur;
    D.seekCur.textContent = fmtTime(time);
    sendSeekThrottled(time);
  }

  D.seekTrack.addEventListener('pointerdown', e => {
    if (!S.primary?.media?.duration) return;
    e.preventDefault();
    S.isDragging = true;
    D.seekTrack.classList.add('is-dragging');
    D.seekTrack.setPointerCapture(e.pointerId); // Track even if pointer leaves element
    applyPct(xToPct(e.clientX));
  });

  D.seekTrack.addEventListener('pointermove', e => {
    if (!S.isDragging) return;
    applyPct(xToPct(e.clientX));
  });

  D.seekTrack.addEventListener('pointerup', e => {
    if (!S.isDragging) return;
    S.isDragging = false;
    D.seekTrack.classList.remove('is-dragging');
    // Final committed seek — bypass throttle for precise landing
    const pct = xToPct(e.clientX);
    const dur = S.primary?.media?.duration || 0;
    const time = (pct / 100) * dur;
    if (S.primary)
      sendCmd(S.primary.tabId, { action: MSG.CMD_SEEK, payload: { time } });
  });

  D.seekTrack.addEventListener('pointercancel', () => {
    S.isDragging = false;
    D.seekTrack.classList.remove('is-dragging');
  });

  // Keyboard navigation on the seek track (ARIA slider role)
  D.seekTrack.addEventListener('keydown', e => {
    if (!S.primary?.media) return;
    const { currentTime: cur = 0, duration: dur = 0 } = S.primary.media;
    let target = null;

    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') target = cur - 5;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') target = cur + 5;
    if (e.key === 'Home') target = 0;
    if (e.key === 'End') target = dur;

    if (target !== null) {
      e.preventDefault();
      const t = Math.max(0, Math.min(dur, target));
      updateSeekBar(t, dur);
      sendCmd(S.primary.tabId, { action: MSG.CMD_SEEK, payload: { time: t } });
    }
  });
}

// =============================================================================
// SECTION 13: Utility functions
// =============================================================================

/**
 * Apply mute state to the button and its icon pair.
 * Two SVGs are pre-rendered in HTML; we swap display:none between them.
 * @param {boolean} muted
 */
function applyMuteIcon(muted) {
  D.iconVolOn.style.display = muted ? 'none' : '';
  D.iconVolOff.style.display = muted ? '' : 'none';
  D.btnMute.setAttribute('aria-pressed', muted ? 'true' : 'false');
  D.btnMute.setAttribute('aria-label', muted ? 'Unmute' : 'Mute');
}

/**
 * Format seconds → mm:ss or h:mm:ss.
 * Uses tabular-nums so digits don't cause layout shift.
 * @param {number} s
 * @returns {string}
 */
function fmtTime(s) {
  if (!isFinite(s) || s < 0) return '0:00';
  const total = Math.floor(s);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const p = n => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(sec)}` : `${m}:${p(sec)}`;
}

/**
 * Format a playback speed for display.
 * Strips unnecessary trailing zeros: 1.50 → "1.5×", 2.00 → "2×"
 * @param {number} n
 * @returns {string}
 */
function fmtSpeed(n) {
  const v = Number(n) || 1;
  return `${v % 1 === 0 ? v.toFixed(0) : String(parseFloat(v.toFixed(2)))}×`;
}

/**
 * Step through SPEED_STEPS in the given direction (+1 / -1).
 * If current speed isn't in the array, snaps to the nearest step first.
 * @param {number} current
 * @param {number} dir — +1 faster, -1 slower
 * @returns {number}
 */
function stepSpeed(current, dir) {
  let idx = SPEED_STEPS.indexOf(current);
  if (idx < 0) {
    // Find nearest
    idx = SPEED_STEPS.reduce(
      (best, s, i) =>
        Math.abs(s - current) < Math.abs(SPEED_STEPS[best] - current)
          ? i
          : best,
      0,
    );
  }
  return SPEED_STEPS[Math.max(0, Math.min(SPEED_STEPS.length - 1, idx + dir))];
}

/**
 * Extract hostname from a URL string, stripping leading "www."
 * @param {string} url
 * @returns {string}
 */
function extractHost(url) {
  try {
    return new URL(url || '').hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * Truncate to n characters with an ellipsis.
 * @param {string} s
 * @param {number} n
 * @returns {string}
 */
function truncate(s, n) {
  const str = s || '';
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}

/** Escape for safe innerHTML text injection. */
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Escape for safe HTML attribute value injection. */
function escAttr(s) {
  return String(s)
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// =============================================================================
// SECTION 14: Bootstrap
// =============================================================================

document.addEventListener('DOMContentLoaded', async () => {
  showView('loading');
  initEvents();

  // Fetch full state snapshot from background
  try {
    const res = await chrome.runtime.sendMessage({ action: MSG.GET_ALL_STATE });
    if (res?.success) {
      await processState(res.mediaTabs, res.settings);
    } else {
      showView('empty');
    }
  } catch {
    // Background not ready (e.g. freshly installed, SW starting up)
    showView('empty');
  }

  console.log('[StreamLine Popup v2] Initialized.');
});
