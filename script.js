/*
 * JAYSTORE SHARED SCRIPT
 * ----------------------
 * Handles:
 *  - Persistent cross-page audio player
 *  - Spotify-like playlist on music.html
 *  - Draggable floating player with snap-to-edge
 *  - Client-side navigation so audio keeps playing
 *  - Shop cart / search and Journey modals
 */
(function () {
  'use strict';

  const SCRIPT_VERSION = 'jaystore-player-v4';
  console.log('[Jaystore] script loaded:', SCRIPT_VERSION);

  // ── PAGE DETECTION ───────────────────────────────────────────────────────
  // Checked dynamically (not cached) because client-side navigation changes
  // the path without reloading the script. Caching this caused the playlist
  // to be wiped when leaving music.html.
  function isMusicPage() {
    return /\/music\.html?$/i.test(location.pathname) || location.pathname.endsWith('/music.html');
  }

  // ── LOCAL STORAGE KEYS ───────────────────────────────────────────────────
  // Used to remember playback state and player position across reloads.
  const LS_PREFIX = 'jaystore_';
  const LS_KEYS = {
    player:   LS_PREFIX + 'player',    // last track, time, volume, play/pause
    pos:      LS_PREFIX + 'player_pos', // last floating-player position
    playlist: LS_PREFIX + 'playlist'    // serialized playlist (src/title/artist)
  };

  // One-time migration: older builds could persist double-encoded paths
  // (e.g. %2520) or raw-space paths. If the script version changed, drop the
  // stale player/playlist data so it is rebuilt cleanly.
  try {
    const storedVersion = localStorage.getItem(LS_PREFIX + 'script_version');
    if (storedVersion !== SCRIPT_VERSION) {
      localStorage.removeItem(LS_KEYS.player);
      localStorage.removeItem(LS_KEYS.playlist);
      localStorage.setItem(LS_PREFIX + 'script_version', SCRIPT_VERSION);
    }
  } catch (e) {}

  // ── NAVIGATION CONFIG ────────────────────────────────────────────────────
  // These are the only pages that should be swapped without a full reload.
  const INTERNAL_PATHS = ['index.html', 'about.html', 'shop.html', 'music.html', 'journey.html'];
  const BASE_PATH = location.pathname.replace(/[^/]+$/, '') || '/';

  // ── HELPERS ──────────────────────────────────────────────────────────────

  /**
   * Turn a relative path into a full URL.
   * Any existing %XX escapes are decoded first and then re-encoded by the URL
   * constructor, which makes this idempotent: raw spaces, already-encoded
   * paths (%20), and even accidentally double-encoded paths (%2520) all end
   * up as a single clean %20.
   */
  function resolveUrl(src) {
    try {
      return new URL(decodeURI(src), location.href).href;
    } catch (e) {
      try {
        return new URL(src, location.href).href;
      } catch (e2) {
        return src;
      }
    }
  }

  /**
   * Format seconds as m:ss for the player time display.
   */
  function formatTime(seconds) {
    if (!isFinite(seconds) || isNaN(seconds)) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60).toString().padStart(2, '0');
    return m + ':' + s;
  }

  // ── DOM REFERENCES ───────────────────────────────────────────────────────
  // persistent-audio = one single <audio> element that survives page swaps.
  // floating-player  = the Spotify-like card in the corner.
  const audio = document.getElementById('persistent-audio');
  const player = document.getElementById('floating-player');

  // If either element is missing, stop everything (page is incomplete).
  if (!audio || !player) return;

  // Cache references to the player UI pieces.
  const els = {
    art:      player.querySelector('.fp-art'),
    title:    player.querySelector('.fp-title'),
    artist:   player.querySelector('.fp-artist'),
    play:     player.querySelector('.fp-play'),
    prev:     player.querySelector('.fp-prev'),
    next:     player.querySelector('.fp-next'),
    close:    player.querySelector('.fp-close'),
    progress: player.querySelector('.fp-progress'),
    bar:      player.querySelector('.fp-progress-bar'),
    current:  player.querySelector('.fp-current'),
    duration: player.querySelector('.fp-duration'),
    volume:   player.querySelector('.fp-volume'),
    volIcon:  player.querySelector('.fp-vol-icon')
  };

  // ── PLAYLIST STATE ───────────────────────────────────────────────────────
  // tracks[] holds every playable item found on music.html.
  // Empty slots are allowed (rows without an audio file yet).
  let tracks = [];
  let currentIndex = -1;   // index of the currently loaded track
  let restoringState = false; // true while restoring from localStorage

  // ── STATE PERSISTENCE ────────────────────────────────────────────────────

  /**
   * Save current track, position, volume, and visibility to localStorage.
   * Called whenever playback changes so reloads can resume.
   */
  function saveState() {
    const state = {
      src:    audio.currentSrc || '',
      title:  currentIndex >= 0 && tracks[currentIndex] ? tracks[currentIndex].title  : (els.title ? els.title.textContent : ''),
      artist: currentIndex >= 0 && tracks[currentIndex] ? tracks[currentIndex].artist : (els.artist ? els.artist.textContent : ''),
      index:  currentIndex,
      time:   audio.currentTime || 0,
      paused: audio.paused,
      volume: audio.volume,
      hidden: player.classList.contains('is-hidden')
    };
    try {
      localStorage.setItem(LS_KEYS.player, JSON.stringify(state));
    } catch (e) {
      // localStorage might be full or disabled; fail silently.
    }
  }

  /**
   * Load previously saved player state from localStorage.
   */
  function loadState() {
    try {
      const raw = localStorage.getItem(LS_KEYS.player);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Persist the playlist to localStorage (without DOM references) so that
   * prev/next keep working after a full page load on any page.
   */
  function savePlaylist() {
    const serializable = tracks.map(t => t ? { src: t.src, title: t.title, artist: t.artist } : null);
    try {
      localStorage.setItem(LS_KEYS.playlist, JSON.stringify(serializable));
    } catch (e) {}
  }

  /**
   * Restore the playlist from localStorage if it isn't already in memory.
   */
  function restorePlaylist() {
    if (tracks.length) return;
    try {
      const raw = localStorage.getItem(LS_KEYS.playlist);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        // Keep null slots so indices stay aligned with the music page rows.
        tracks = parsed.map(t => t ? { src: t.src, title: t.title, artist: t.artist, el: null } : null);
      }
    } catch (e) {}
  }

  // ── PLAYER UI UPDATES ────────────────────────────────────────────────────

  /**
   * Refresh the floating player text and play/pause icon.
   */
  function updatePlayerUI() {
    const track = tracks[currentIndex];
    if (track) {
      els.title.textContent  = track.title || 'Untitled';
      els.artist.textContent = track.artist || 'Unknown artist';
      // Show first two letters of the title as the fake album art.
      els.art.textContent    = (track.title || '♪').slice(0, 2).toUpperCase();
    }
    // Always keep the play/pause icon accurate, even if the playlist is empty.
    els.play.innerHTML = audio.paused ? '▶' : '❚❚';
  }

  /**
   * Highlight the active row on the music page.
   */
  function highlightActiveTrack() {
    if (!isMusicPage()) return;
    document.querySelectorAll('.spotify-track, .spotify-feature').forEach(el => {
      const idx = Number(el.dataset.track ?? -1);
      el.classList.toggle('active', idx === currentIndex);
    });
  }

  /**
   * Update the progress bar and current/duration labels.
   */
  function updateProgress() {
    const duration = audio.duration || 0;
    const current  = audio.currentTime || 0;
    const ratio    = duration ? (current / duration) * 100 : 0;
    els.bar.style.width      = ratio + '%';
    els.current.textContent  = formatTime(current);
    els.duration.textContent = formatTime(duration);
  }

  /**
   * Switch the volume icon between loud / quiet / muted.
   */
  function updateVolumeIcon() {
    const vol = audio.volume;
    els.volIcon.textContent = vol === 0 ? '🔇' : (vol < 0.5 ? '🔉' : '🔊');
  }

  // ── PLAYBACK CONTROL ─────────────────────────────────────────────────────

  /**
   * Load a track by index and optionally autoplay it.
   * Wraps around to the start/end of the playlist.
   */
  function loadTrack(index, autoplay) {
    if (!tracks.length) return;
    if (index < 0) index = tracks.length - 1;
    if (index >= tracks.length) index = 0;

    currentIndex = index;
    const track = tracks[index];
    if (!track) return; // slot has no audio yet

    const resolved = resolveUrl(track.src);
    // Only change src if it's a different track (prevents re-buffering).
    if (audio.src !== resolved) {
      audio.src = resolved;
      audio.load();
    }

    updatePlayerUI();
    highlightActiveTrack();
    player.classList.remove('is-hidden');

    if (autoplay) {
      const playPromise = audio.play();
      if (playPromise && typeof playPromise.then === 'function') {
        playPromise.catch((err) => {
          console.warn('Playback failed:', err?.name || err);
        });
      }
    }
    saveState();
  }

  /** Start playing a specific track index. */
  function playIndex(index) {
    loadTrack(index, true);
  }

  /** Toggle play/pause on the current track (or start track 0 if none selected). */
  function togglePlay() {
    if (currentIndex < 0) {
      if (tracks.length) playIndex(0);
      return;
    }
    if (audio.paused) {
      const p = audio.play();
      if (p && p.catch) p.catch((err) => console.warn('Toggle play failed:', err?.name || err));
    } else {
      audio.pause();
    }
  }

  /** Skip to the next track that actually has audio. */
  function playNext() {
    if (!tracks.length) return;
    let next = currentIndex + 1;
    while (next < tracks.length && !tracks[next]) next++;
    if (next >= tracks.length) next = 0;
    while (next < tracks.length && !tracks[next]) next++;
    if (tracks[next]) playIndex(next);
  }

  /** Go to previous track, or restart current track if we're past 3 seconds. */
  function playPrev() {
    if (!tracks.length) return;
    if (audio.currentTime > 3) {
      audio.currentTime = 0;
      return;
    }
    let prev = currentIndex - 1;
    while (prev >= 0 && !tracks[prev]) prev--;
    if (prev < 0) prev = tracks.length - 1;
    while (prev >= 0 && !tracks[prev]) prev--;
    if (tracks[prev]) playIndex(prev);
  }

  /**
   * Seek to the position clicked on the progress bar.
   */
  function seekFromEvent(e) {
    const rect = els.progress.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    if (audio.duration) audio.currentTime = ratio * audio.duration;
  }

  // ── MUSIC PAGE: BUILD PLAYLIST ───────────────────────────────────────────

  /**
   * Scan music.html for the feature card and every track row,
   * then populate the tracks[] array.
   * The feature card is index 0; rows follow from index 1 onward.
   */
  function readTracksFromPage() {
    // On non-music pages, keep the existing playlist so prev/next still work.
    if (!isMusicPage()) return;
    tracks = [];

    // 1) Featured playlist card at the top.
    const feature = document.querySelector('.spotify-feature');
    if (feature) {
      const btn = feature.querySelector('.spotify-play');
      if (btn && btn.dataset.audioSrc) {
        tracks.push({
          src:    btn.dataset.audioSrc,
          title:  btn.dataset.title  || feature.querySelector('h2')?.textContent || 'Feature',
          artist: btn.dataset.artist || 'Jaystore demo',
          el:     feature
        });
        feature.dataset.track = '0';
      }
    }

    // 2) Each track/playlist row.
    document.querySelectorAll('.spotify-track').forEach((el, i) => {
      const offset = feature ? 1 : 0; // rows start after the feature card
      const src    = el.dataset.audioSrc;
      const title  = el.dataset.title  || el.querySelector('.spotify-name')?.textContent || ('Track ' + (i + 1));
      const artist = el.dataset.artist || el.querySelector('.spotify-meta')?.textContent || 'Unknown';

      el.dataset.track = String(offset + i);
      if (src) {
        tracks[offset + i] = { src, title, artist, el };
      }
    });

    // Remember the playlist so other pages / reloads can still use prev/next.
    savePlaylist();
  }

  // ── MUSIC PAGE: BIND CLICKS ──────────────────────────────────────────────

  /**
   * Attach click handlers to the feature play button and each track row.
   * Also handle the per-row "Choose" file inputs for custom audio uploads.
   */
  function bindMusicPage() {
    if (!isMusicPage()) return;

    // Big green feature play button.
    const featureBtn = document.querySelector('.spotify-feature .spotify-play');
    if (featureBtn) {
      featureBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        playIndex(0); // feature card is always index 0
      });
    } else {
      console.warn('Feature play button not found');
    }

    // Individual track rows.
    document.querySelectorAll('.spotify-track').forEach(el => {
      const idx = Number(el.dataset.track);
      if (isNaN(idx) || idx < 0) return;

      // Clicking the row plays its track (unless an inner control was clicked).
      el.addEventListener('click', (e) => {
        if (e.target.closest('.spotify-track-upload') ||
            e.target.closest('.spotify-add') ||
            e.target.closest('.spotify-more')) return;

        const t = tracks[idx];
        if (t && t.src) {
          playIndex(idx);
        } else {
          // No audio yet; just reveal the player.
          player.classList.remove('is-hidden');
        }
      });

      // "Choose" file input replaces/overrides this row's audio.
      const input = el.querySelector('input[type="file"][data-track-input]');
      if (input) {
        input.addEventListener('change', (ev) => {
          const file = ev.target.files[0];
          if (!file) return;
          const url = URL.createObjectURL(file);
          const existing = tracks[idx];
          const title  = el.dataset.title  || el.querySelector('.spotify-name')?.textContent || file.name;
          const artist = el.dataset.artist || el.querySelector('.spotify-meta')?.textContent || 'Local file';

          if (existing) {
            existing.src    = url;
            existing.title  = title;
            existing.artist = artist;
          } else {
            tracks[idx] = { src: url, title, artist, el };
          }
          playIndex(idx);
        });
      }
    });
  }

  // ── FLOATING PLAYER CONTROLS ─────────────────────────────────────────────

  /**
   * Bind play/pause, prev/next, close, volume, and seeking on the player card.
   * Uses event delegation on the persistent player element so controls keep
   * working even after client-side page swaps replace #page-content.
   */
  function bindPlayerControls() {
    // Button clicks: play/pause, prev, next, close.
    player.addEventListener('click', (e) => {
      const btn = e.target.closest('.fp-btn, .fp-close');
      if (!btn) return;
      e.stopPropagation();

      if (btn.classList.contains('fp-play')) {
        togglePlay();
      } else if (btn.classList.contains('fp-prev')) {
        playPrev();
      } else if (btn.classList.contains('fp-next')) {
        playNext();
      } else if (btn.classList.contains('fp-close')) {
        audio.pause();
        player.classList.add('is-hidden');
        saveState();
      }
    });

    // Volume slider.
    player.addEventListener('input', (e) => {
      if (!e.target.classList.contains('fp-volume')) return;
      audio.volume = Number(e.target.value);
      updateVolumeIcon();
      saveState();
    });

    // Click-and-drag seeking on the progress bar.
    let seeking = false;
    player.addEventListener('pointerdown', (e) => {
      if (!e.target.closest('.fp-progress, .fp-progress-bar')) return;
      e.stopPropagation();
      seeking = true;
      seekFromEvent(e);
    });
    window.addEventListener('pointermove', (e) => {
      if (seeking) seekFromEvent(e);
    });
    window.addEventListener('pointerup', () => {
      seeking = false;
    });

    // Audio element events.
    audio.addEventListener('timeupdate', () => {
      updateProgress();
      // Save state every ~5 seconds during playback.
      if (Math.floor(audio.currentTime) % 5 === 0) saveState();
    });
    audio.addEventListener('loadedmetadata', updateProgress);
    audio.addEventListener('error', () => {
      console.error('Audio load error. src:', audio.src);
    });
    audio.addEventListener('play',  () => { updatePlayerUI(); saveState(); });
    audio.addEventListener('pause', () => { updatePlayerUI(); saveState(); });
    audio.addEventListener('ended', () => playNext());
    audio.addEventListener('volumechange', updateVolumeIcon);
  }

  /**
   * Resume the player after a page reload using saved localStorage data.
   */
  function restorePlayer() {
    const state = loadState();
    if (!state || !state.src) return;

    restoringState = true;
    audio.src = state.src;
    audio.load();

    if (typeof state.volume === 'number') {
      audio.volume = state.volume;
      els.volume.value = state.volume;
    }
    if (state.title)  els.title.textContent  = state.title;
    if (state.artist) els.artist.textContent = state.artist;
    els.art.textContent = (state.title || '♪').slice(0, 2).toUpperCase();
    currentIndex = typeof state.index === 'number' ? state.index : -1;

    if (state.hidden) player.classList.add('is-hidden');
    else              player.classList.remove('is-hidden');

    updateProgress();
    updateVolumeIcon();
    updatePlayerUI();

    if (state.time && isFinite(state.time)) {
      try {
        audio.currentTime = state.time;
      } catch (e) {
        // Seek may fail if metadata hasn't loaded yet; ignore.
      }
    }

    // Autoplay if it was playing before the reload.
    if (!state.paused) {
      const p = audio.play();
      if (p && p.catch) p.catch((err) => console.warn('Restore play failed:', err?.name || err));
    }
    restoringState = false;
  }

  // ── DRAGGABLE / SNAP PLAYER ──────────────────────────────────────────────

  const SNAP_MARGIN = 14; // gap from screen edges when snapped

  /**
   * Given the player's current rectangle, find the nearest snap target.
   * Targets: 4 corners + 4 edge midpoints = 8 spots.
   */
  function snapPosition(rect) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const halfW = vw / 2;
    const halfH = vh / 2;
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;

    const targets = [
      // 4 corners
      { x: SNAP_MARGIN,                              y: SNAP_MARGIN },
      { x: vw - rect.width - SNAP_MARGIN,            y: SNAP_MARGIN },
      { x: SNAP_MARGIN,                              y: vh - rect.height - SNAP_MARGIN },
      { x: vw - rect.width - SNAP_MARGIN,            y: vh - rect.height - SNAP_MARGIN },
      // 4 edge midpoints
      { x: halfW - rect.width / 2,                   y: SNAP_MARGIN },
      { x: halfW - rect.width / 2,                   y: vh - rect.height - SNAP_MARGIN },
      { x: SNAP_MARGIN,                              y: halfH - rect.height / 2 },
      { x: vw - rect.width - SNAP_MARGIN,            y: halfH - rect.height / 2 }
    ];

    let best = targets[0];
    let bestDist = Infinity;
    for (const t of targets) {
      const tcx = t.x + rect.width / 2;
      const tcy = t.y + rect.height / 2;
      const d = Math.hypot(cx - tcx, cy - tcy);
      if (d < bestDist) {
        bestDist = d;
        best = t;
      }
    }
    return best;
  }

  /** Remember the player's current screen position. */
  function savePosition() {
    const rect = player.getBoundingClientRect();
    try {
      localStorage.setItem(LS_KEYS.pos, JSON.stringify({ left: rect.left, top: rect.top }));
    } catch (e) {}
  }

  /** Restore the player's last saved position, clamped inside the viewport. */
  function loadPosition() {
    try {
      const raw = localStorage.getItem(LS_KEYS.pos);
      if (!raw) return;
      const pos = JSON.parse(raw);
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const rect = player.getBoundingClientRect();
      let left = Math.min(Math.max(0, pos.left), vw - rect.width);
      let top  = Math.min(Math.max(0, pos.top),  vh - rect.height);
      player.style.left   = left + 'px';
      player.style.top    = top + 'px';
      player.style.right  = 'auto';
      player.style.bottom = 'auto';
    } catch (e) {}
  }

  /**
   * Snap the player to the nearest corner/edge.
   * @param {boolean} animate - true when called after a drag release.
   */
  function snapPlayer(animate) {
    const rect = player.getBoundingClientRect();
    const target = snapPosition(rect);
    if (animate) player.classList.add('is-snapping');
    player.style.left   = target.x + 'px';
    player.style.top    = target.y + 'px';
    player.style.right  = 'auto';
    player.style.bottom = 'auto';
    if (animate) {
      setTimeout(() => player.classList.remove('is-snapping'), 220);
    }
    savePosition();
  }

  /**
   * Make the floating player draggable.
   * Clicks on the real controls (play/pause, prev/next, close, progress, volume)
   * are ignored so they keep working. Everything else on the card starts a drag.
   * On release, the player snaps to the nearest corner or edge.
   */
  function initDrag() {
    let dragging = false;
    let startX = 0, startY = 0;
    let origLeft = 0, origTop = 0;

    // List of selectors that should NEVER start a drag.
    const CONTROL_SELECTORS = '.fp-btn, .fp-close, .fp-controls, .fp-progress-wrap, .fp-progress, .fp-progress-bar, .fp-volume-wrap, .fp-volume, .fp-vol-icon';

    player.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return; // only left-click

      // If the click (or any ancestor) is a real control, let the control handle it.
      if (e.target.closest(CONTROL_SELECTORS)) return;

      dragging = true;
      if (player.setPointerCapture) player.setPointerCapture(e.pointerId);
      player.classList.add('is-dragging');

      startX = e.clientX;
      startY = e.clientY;
      const rect = player.getBoundingClientRect();
      origLeft = rect.left;
      origTop  = rect.top;
      player.style.left   = origLeft + 'px';
      player.style.top    = origTop + 'px';
      player.style.right  = 'auto';
      player.style.bottom = 'auto';
    });

    window.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      let left = origLeft + (e.clientX - startX);
      let top  = origTop  + (e.clientY - startY);
      const rect = player.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      // Keep the player fully inside the viewport.
      left = Math.max(0, Math.min(left, vw - rect.width));
      top  = Math.max(0, Math.min(top,  vh - rect.height));
      player.style.left = left + 'px';
      player.style.top  = top + 'px';
    });

    window.addEventListener('pointerup', () => {
      if (!dragging) return;
      dragging = false;
      player.classList.remove('is-dragging');
      snapPlayer(true);
    });
  }

  // ── CLIENT-SIDE NAVIGATION ───────────────────────────────────────────────
  // This is what lets audio keep playing when switching internal pages.

  const baseTitle = document.title;

  /**
   * Fetch a new page and swap in its #page-content, preserving the audio
   * and floating player that live outside that div.
   */
  async function navigateTo(url, push = true) {
    const cleanUrl = new URL(url, location.href);

    // External link -> normal browser navigation.
    if (cleanUrl.origin !== location.origin) {
      location.assign(url);
      return;
    }

    const path = cleanUrl.pathname.replace(BASE_PATH, '').replace(/^\//, '') || 'index.html';
    // Unknown internal path -> normal navigation.
    if (!INTERNAL_PATHS.includes(path)) {
      location.assign(url);
      return;
    }

    try {
      const res = await fetch(cleanUrl.href);
      if (!res.ok) throw new Error('fetch failed');
      const html = await res.text();
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');
      const nextContent = doc.getElementById('page-content');
      if (!nextContent) throw new Error('no page-content');

      // Replace only the page content; player + audio stay alive.
      const currentContent = document.getElementById('page-content');
      if (currentContent && nextContent) {
        currentContent.replaceWith(nextContent);
      }

      if (push && history.pushState) {
        history.pushState({ path: cleanUrl.pathname + cleanUrl.search }, '', cleanUrl.href);
      }
      document.title = doc.title || baseTitle;
      window.scrollTo(0, 0);

      // Re-bind page-specific behavior for the new content.
      initPageFeatures();
    } catch (err) {
      // Fallback to normal navigation if anything goes wrong.
      location.assign(url);
    }
  }

  /**
   * Hijack internal link clicks so they use navigateTo() instead of reloading.
   * Anchor links (#id) scroll smoothly to the target.
   */
  function interceptLinks(scope) {
    scope.addEventListener('click', (e) => {
      const a = e.target.closest('a[href]');
      if (!a) return;

      const href = a.getAttribute('href');
      if (!href) return;

      // Same-page anchor link.
      if (href.startsWith('#')) {
        const id = href.slice(1);
        const el = id ? document.getElementById(id) : null;
        if (el) {
          e.preventDefault();
          el.scrollIntoView({ behavior: 'smooth' });
          history.replaceState(history.state || {}, '', href);
        }
        return;
      }

      // External link -> let browser handle it.
      if (href.startsWith('http') && !href.startsWith(location.origin)) return;

      // Modifier clicks or new-tab clicks -> let browser handle it.
      if (a.target === '_blank' || e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;

      e.preventDefault();
      navigateTo(href, true);
    });
  }

  // Handle browser back/forward buttons.
  window.addEventListener('popstate', () => {
    navigateTo(location.href, false);
  });

  // ── PAGE-SPECIFIC FEATURE BINDERS ────────────────────────────────────────

  /**
   * Re-initialize whatever the current page needs after first load
   * or after a client-side navigation swap.
   */
  function initPageFeatures() {
    readTracksFromPage();      // builds the playlist on music.html (no-op elsewhere)
    restorePlaylist();         // loads cached playlist on other pages / reloads
    bindMusicPage();
    highlightActiveTrack();
    bindJourneyFeatures();
    bindShopFeatures();

    if (!restoringState && currentIndex >= 0) {
      updatePlayerUI();
    }
  }

  /**
   * Journey page: open modals on card click/Enter, close buttons,
   * routine day tabs, and video file uploads.
   */
  function bindJourneyFeatures() {
    const progressModal = document.getElementById('progressModal');
    const routineModal  = document.getElementById('routineModal');
    if (!progressModal && !routineModal) return;

    document.querySelectorAll('.journey-card').forEach(card => {
      card.addEventListener('click', () => {
        const modalId = card.dataset.modal;
        const modal = document.getElementById(modalId);
        if (modal && modal.showModal) modal.showModal();
      });
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          const modalId = card.dataset.modal;
          const modal = document.getElementById(modalId);
          if (modal && modal.showModal) modal.showModal();
        }
      });
    });

    document.querySelectorAll('dialog .modal-close').forEach(btn => {
      btn.addEventListener('click', () => {
        const dialog = btn.closest('dialog');
        if (dialog && dialog.close) dialog.close();
      });
    });

    const tabs = document.querySelectorAll('.routine-tab');
    const list = document.getElementById('routineList');
    if (tabs.length && list) {
      const routines = {
        3: ['Chest & Triceps', 'Back & Biceps', 'Legs & Shoulders'],
        4: ['Chest', 'Back', 'Legs', 'Shoulders & Arms'],
        5: ['Chest', 'Back', 'Legs', 'Shoulders', 'Arms & Core'],
        7: ['Chest', 'Back', 'Legs', 'Shoulders', 'Arms', 'Core & Cardio', 'Active Recovery']
      };

      function render(days) {
        list.innerHTML = '';
        (routines[days] || []).forEach((name, i) => {
          const day = document.createElement('div');
          day.className = 'routine-day';
          day.innerHTML = `<strong>Day ${i + 1}</strong><span>${name}</span><div class="routine-video"><strong>Upload Video</strong><small>Choose a file</small><input type="file" accept="video/*" /></div>`;
          list.appendChild(day);
        });
        bindRoutineUploads();
      }

      tabs.forEach(tab => {
        tab.addEventListener('click', () => {
          tabs.forEach(t => t.classList.remove('active'));
          tab.classList.add('active');
          render(Number(tab.dataset.days));
        });
      });

      const active = document.querySelector('.routine-tab.active');
      render(Number(active?.dataset.days || 3));
    }
  }

  /** Journey page: turn a selected video file into a preview in the routine list. */
  function bindRoutineUploads() {
    document.querySelectorAll('.routine-video input[type="file"]').forEach(input => {
      input.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const container = input.closest('.routine-video');
        let video = container.querySelector('video');
        if (!video) {
          video = document.createElement('video');
          video.controls = true;
          container.appendChild(video);
        }
        video.src = URL.createObjectURL(file);
        container.classList.add('has-video');
      });
    });
  }

  /**
   * Shop page: add-to-cart counter and live search filter.
   */
  function bindShopFeatures() {
    const grid = document.getElementById('productGrid');
    const countEl = document.getElementById('cartCount');
    if (!grid || !countEl) return;

    let cart = 0;
    grid.querySelectorAll('.add-cart').forEach(btn => {
      btn.addEventListener('click', () => {
        cart += 1;
        countEl.textContent = 'Cart: ' + cart;
      });
    });

    const form = document.querySelector('.search-form');
    if (form) {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const term = form.querySelector('input')?.value.toLowerCase().trim() || '';
        grid.querySelectorAll('.product-card').forEach(card => {
          const text = card.textContent.toLowerCase();
          card.style.display = text.includes(term) ? '' : 'none';
        });
      });
    }
  }

  // ── STARTUP ──────────────────────────────────────────────────────────────

  window.addEventListener('DOMContentLoaded', () => {
    interceptLinks(document);   // make internal links keep audio alive
    bindPlayerControls();       // floating player buttons / seek / volume
    loadPosition();             // last dragged position
    initDrag();                 // make player draggable
    initPageFeatures();         // bind current page behavior
    snapPlayer(false);          // snap to nearest edge on load
    restorePlayer();            // resume after reload
  });

  // Re-snap the player if the window is resized so it stays on screen.
  window.addEventListener('resize', () => {
    snapPlayer(true);
  });
})();
