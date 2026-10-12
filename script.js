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

  const SCRIPT_VERSION = 'jaystore-player-v5';
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

  // Replace these with the Project URL and publishable (anon) key from Supabase.
  // Never put a service_role key in browser code.
  const SUPABASE_URL = 'https://wjbxtjdwdwjleutqpifw.supabase.co';
  const SUPABASE_ANON_KEY = 'sb_publishable_iWlNdvF0DvUXFJGb5ebM2w_hkseUlYf'
  let supabaseClient = null;
  let supabaseClientPromise = null;

  function getSupabaseClient() {
    if (supabaseClient) return Promise.resolve(supabaseClient);
    if (supabaseClientPromise) return supabaseClientPromise;

    supabaseClientPromise = new Promise((resolve, reject) => {
      if (SUPABASE_URL.includes('YOUR_PROJECT_ID') || SUPABASE_ANON_KEY.includes('YOUR_SUPABASE_ANON_KEY')) {
        reject(new Error('Add your Supabase Project URL and anon key in script.js first.'));
        return;
      }

      function createClient() {
        if (!window.supabase || !window.supabase.createClient) {
          reject(new Error('Supabase SDK did not load. Check your internet connection and try again.'));
          return;
        }
        supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
        resolve(supabaseClient);
      }

      if (window.supabase && window.supabase.createClient) {
        createClient();
        return;
      }

      const sdk = document.createElement('script');
      sdk.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
      sdk.onload = createClient;
      sdk.onerror = () => reject(new Error('Could not load the Supabase SDK.'));
      document.head.appendChild(sdk);
    }).catch(error => {
      supabaseClientPromise = null;
      throw error;
    });

    return supabaseClientPromise;
  }

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
  const INTERNAL_PATHS = ['index.html', 'about.html', 'shop.html', 'music.html', 'journey.html', 'workout.html'];
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
    bindWorkoutFeatures();

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
    const routineModal = document.getElementById('routineModal');
    if (!progressModal && !routineModal) return;

    document.querySelectorAll('.journey-card').forEach(card => {
      const openModal = () => {
        const modal = document.getElementById(card.dataset.modal);
        if (modal && modal.showModal) modal.showModal();
      };
      card.addEventListener('click', openModal);
      card.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openModal();
        }
      });
    });

    document.querySelectorAll('dialog .modal-close').forEach(button => {
      button.addEventListener('click', () => {
        const dialog = button.closest('dialog');
        if (dialog && dialog.close) dialog.close();
      });
    });

    document.querySelectorAll('.photo-upload input[type="file"][data-preview]').forEach(input => {
      input.addEventListener('change', () => {
        const file = input.files && input.files[0];
        if (!file) return;
        const preview = document.getElementById(input.dataset.preview);
        const container = input.closest('.photo-upload');
        if (!preview || !container) return;
        preview.src = URL.createObjectURL(file);
        container.classList.add('has-photo');
      });
    });

    const routines = {
      3: ['Chest & Triceps', 'Back & Biceps', 'Legs & Shoulders'],
      4: ['Chest', 'Back', 'Legs', 'Shoulders & Arms'],
      5: ['Chest', 'Back', 'Legs', 'Shoulders', 'Arms & Core'],
      7: ['Chest', 'Back', 'Legs', 'Shoulders', 'Arms', 'Core & Cardio', 'Active Recovery']
    };
    const tabs = document.querySelectorAll('.routine-tab');
    const list = document.getElementById('routineList');

    function renderRoutine(days) {
      if (!list) return;
      list.replaceChildren();
      (routines[days] || []).forEach((name, index) => {
        const day = document.createElement('div');
        day.className = 'routine-day';
        const label = document.createElement('strong');
        label.textContent = 'Day ' + (index + 1);
        const routineName = document.createElement('span');
        routineName.textContent = name;
        const videoUpload = document.createElement('div');
        videoUpload.className = 'routine-video';
        const uploadLabel = document.createElement('strong');
        uploadLabel.textContent = 'Upload Video';
        const uploadHint = document.createElement('small');
        uploadHint.textContent = 'Choose a file';
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'video/*';
        videoUpload.append(uploadLabel, uploadHint, input);
        day.append(label, routineName, videoUpload);
        list.appendChild(day);
      });
      bindRoutineUploads();
    }

    tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        tabs.forEach(item => item.classList.remove('active'));
        tab.classList.add('active');
        renderRoutine(Number(tab.dataset.days));
      });
    });
    const activeTab = document.querySelector('.routine-tab.active');
    if (list) renderRoutine(Number(activeTab ? activeTab.dataset.days : 3));
  }

  function bindRoutineUploads() {
    document.querySelectorAll('.routine-video input[type="file"]').forEach(input => {
      input.addEventListener('change', () => {
        const file = input.files && input.files[0];
        if (!file) return;
        const container = input.closest('.routine-video');
        if (!container) return;
        let video = container.querySelector('video');
        if (!video) {
          video = document.createElement('video');
          video.controls = true;
          video.playsInline = true;
          container.appendChild(video);
        }
        video.src = URL.createObjectURL(file);
        container.classList.add('has-video');
      });
    });
  }

  function bindShopFeatures() {
    const grid = document.getElementById('productGrid');
    const countEl = document.getElementById('cartCount');
    const status = document.getElementById('shopStatus');
    if (!grid || !countEl) return;

    const cart = new Map();
    const form = document.querySelector('.search-form');
    const searchInput = form ? form.querySelector('input') : null;
    const checkoutDialog = document.getElementById('checkoutDialog');
    const checkoutForm = document.getElementById('checkoutForm');
    const checkoutItems = document.getElementById('checkoutItems');
    const checkoutTotal = document.getElementById('checkoutTotal');
    const checkoutStatus = document.getElementById('checkoutStatus');
    const bagDialog = document.getElementById('bagDialog');
    const bagOpenButton = document.getElementById('openBag');
    const bagItems = document.getElementById('bagItems');
    const bagTotal = document.getElementById('bagTotal');
    const bagEmpty = document.getElementById('bagEmpty');
    const bagCheckoutButton = document.getElementById('bagCheckout');
    const submitButton = document.getElementById('submitOrder');
    const deliveryStep = document.getElementById('deliveryStep');
    const paymentStep = document.getElementById('paymentStep');
    const checkoutTitle = document.getElementById('checkoutTitle');
    const continueButton = document.getElementById('continueCheckout');

    function showCheckoutStep(step) {
      const showingDelivery = step === 'delivery';
      deliveryStep.hidden = !showingDelivery;
      paymentStep.hidden = showingDelivery;
      checkoutTitle.textContent = showingDelivery ? 'Delivery Information' : 'Checkout';
      document.querySelector('.checkout-content').scrollTop = 0;
    }

    function formatPrice(amount) {
      return new Intl.NumberFormat('en-PH', {
        style: 'currency',
        currency: 'PHP'
      }).format(amount);
    }

    function updateCartCount() {
      let total = 0;
      cart.forEach(item => {
        total += item.quantity;
      });
      countEl.textContent = String(total);
      if (bagOpenButton) {
        bagOpenButton.setAttribute('aria-label', 'Open shopping bag, ' + total + (total === 1 ? ' item' : ' items'));
      }
      if (bagCheckoutButton) bagCheckoutButton.disabled = total === 0;
      if (bagEmpty) bagEmpty.hidden = total > 0;
    }

    function renderCartItems(container) {
      if (!container) return;
      container.replaceChildren();
      let total = 0;
      cart.forEach(item => {
        const line = document.createElement('div');
        line.className = 'checkout-line';
        const details = document.createElement('span');
        details.textContent = item.name;
        const quantityDetails = document.createElement('small');
        quantityDetails.textContent = 'Quantity: ' + item.quantity + ' × ' + formatPrice(item.price);
        details.appendChild(quantityDetails);
        const lineTotal = document.createElement('strong');
        lineTotal.textContent = formatPrice(item.price * item.quantity);
        const controls = document.createElement('div');
        controls.className = 'checkout-quantity';
        const decrease = document.createElement('button');
        decrease.type = 'button';
        decrease.dataset.cartAction = 'decrease';
        decrease.dataset.productId = item.id;
        decrease.setAttribute('aria-label', 'Decrease ' + item.name + ' quantity');
        decrease.textContent = '−';
        const quantityCount = document.createElement('span');
        quantityCount.textContent = String(item.quantity);
        const increase = document.createElement('button');
        increase.type = 'button';
        increase.dataset.cartAction = 'increase';
        increase.dataset.productId = item.id;
        increase.setAttribute('aria-label', 'Increase ' + item.name + ' quantity');
        increase.textContent = '+';
        increase.disabled = item.quantity >= item.stock;
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'checkout-remove';
        remove.dataset.cartAction = 'remove';
        remove.dataset.productId = item.id;
        remove.textContent = 'Remove';
        controls.append(decrease, quantityCount, increase, remove);
        line.append(details, lineTotal, controls);
        container.appendChild(line);
        total += item.price * item.quantity;
      });
      return total;
    }

    function renderCheckoutSummary() {
      const total = renderCartItems(checkoutItems);
      if (checkoutTotal && Number.isFinite(total)) checkoutTotal.textContent = formatPrice(total);
    }

    function renderBag() {
      const total = renderCartItems(bagItems);
      if (bagTotal && Number.isFinite(total)) bagTotal.textContent = formatPrice(total);
      if (bagEmpty) bagEmpty.hidden = cart.size > 0;
    }

    function showCheckoutStatus(message, type) {
      if (!checkoutStatus) return;
      checkoutStatus.textContent = message || '';
      checkoutStatus.classList.toggle('is-error', type === 'error');
      checkoutStatus.classList.toggle('is-success', type === 'success');
    }

    function applySearch() {
      const term = searchInput ? searchInput.value.toLowerCase().trim() : '';
      grid.querySelectorAll('.product-card').forEach(card => {
        const searchableText = (card.dataset.product || '') + ' ' + card.textContent;
        card.hidden = !searchableText.toLowerCase().includes(term);
      });
    }

    function bindProductButtons() {
      grid.querySelectorAll('.add-cart').forEach(button => {
        if (button.dataset.cartBound === 'true') return;
        button.dataset.cartBound = 'true';
        button.addEventListener('click', () => {
          const productId = button.dataset.productId;
          const stock = Number(button.dataset.stock);
          const card = button.closest('.product-card');
          if (!productId || !card) return;
          const quantityInCart = cart.get(productId)?.quantity || 0;
          if (quantityInCart >= stock) {
            showCheckoutStatus('Your cart already has the maximum available stock for this product.', 'error');
            return;
          }
          const item = cart.get(productId) || {
            id: productId,
            name: button.dataset.productName || card.querySelector('h3')?.textContent.trim() || productId,
            price: Number(button.dataset.price),
            stock,
            quantity: 0
          };
          item.quantity += 1;
          cart.set(productId, item);
          updateCartCount();
          renderBag();
          if (checkoutDialog && checkoutDialog.open) renderCheckoutSummary();
          showCheckoutStatus('', '');
        });
      });
    }

    // Local product photos. Each product id maps to an image in assets/image/product.
    // The text badge is kept as a fallback if a photo can't be loaded.
    const PRODUCT_IMAGES = {
      dumbbell: 'assets/image/product/dbell.jpeg',
      band: 'assets/image/product/band.jpeg',
      shaker: 'assets/image/product/shaker.jpeg',
      whey: 'assets/image/product/whey.jpeg',
      gloves: 'assets/image/product/gloves.jpeg',
      belt: 'assets/image/product/belt.jpeg'
    };

    function renderProducts(products) {
      grid.replaceChildren();
      products.forEach(product => {
        const cartItem = cart.get(product.id);
        if (!cartItem) return;
        cartItem.name = product.name;
        cartItem.price = Number(product.price);
        cartItem.stock = Number(product.stock);
      });
      products.forEach(product => {
        const card = document.createElement('article');
        card.className = 'product-card';
        card.dataset.product = [product.name].concat(product.search_terms || []).join(' ').toLowerCase();

        const image = document.createElement('div');
        image.className = 'product-image';
        const imageSrc = PRODUCT_IMAGES[product.id];
        if (imageSrc) {
          const img = document.createElement('img');
          img.src = imageSrc;
          img.alt = product.name;
          img.loading = 'lazy';
          // If the photo can't load, fall back to the text badge.
          img.addEventListener('error', () => {
            img.remove();
            image.textContent = product.badge || product.name;
          });
          image.appendChild(img);
        } else {
          image.textContent = product.badge || product.name;
        }
        const title = document.createElement('h3');
        title.textContent = product.name;
        const description = document.createElement('p');
        description.textContent = product.description || '';
        const stockLabel = document.createElement('p');
        stockLabel.className = 'product-stock';
        stockLabel.textContent = product.stock > 0 ? 'In stock: ' + product.stock : 'Out of stock';
        const footer = document.createElement('div');
        footer.className = 'product-footer';
        const price = document.createElement('span');
        price.className = 'product-price';
        price.textContent = formatPrice(Number(product.price));
        const button = document.createElement('button');
        button.className = 'add-cart';
        button.type = 'button';
        button.textContent = product.stock > 0 ? 'Add to cart' : 'Out of stock';
        button.disabled = product.stock <= 0;
        button.dataset.productId = product.id;
        button.dataset.stock = String(product.stock);
        button.dataset.price = String(product.price);
        button.dataset.productName = product.name;
        footer.append(price, button);
        card.append(image, title, description, stockLabel, footer);
        grid.appendChild(card);
      });
      bindProductButtons();
      applySearch();
      updateCartCount();
    }

    bindProductButtons();
    if (form) {
      form.addEventListener('submit', event => {
        event.preventDefault();
        applySearch();
      });
      if (searchInput) searchInput.addEventListener('input', applySearch);
    }

    async function loadProducts() {
      const client = await getSupabaseClient();
      const { data, error } = await client
        .from('shop_products')
        .select('id, name, description, price, stock, badge, search_terms')
        .eq('active', true)
        .order('sort_order', { ascending: true });
      if (error) throw error;
      renderProducts(data);
      if (status) status.textContent = data.length
        ? 'Product catalog and stock levels loaded from Supabase.'
        : 'No active products are listed in Supabase yet.';
    }

    loadProducts().catch(error => {
        console.error('Could not load Shop Gear products from Supabase:', error);
        if (status) {
          status.textContent = 'Could not load the Supabase product catalog: ' +
            (error.message || 'Supabase returned an unknown error.') +
            ' The sample products are shown instead.';
          status.classList.add('is-error');
        }
      });

    if (bagOpenButton && bagDialog) {
      bagOpenButton.addEventListener('click', () => {
        renderBag();
        if (bagDialog.showModal) bagDialog.showModal();
      });
    }

    if (bagCheckoutButton && checkoutDialog) {
      bagCheckoutButton.addEventListener('click', () => {
        if (!cart.size) return;
        showCheckoutStep('delivery');
        renderCheckoutSummary();
        showCheckoutStatus('', '');
        if (bagDialog && bagDialog.open) bagDialog.close();
        if (checkoutDialog.showModal) checkoutDialog.showModal();
      });
    }

    [
      ['closeBag', () => bagDialog],
      ['continueShopping', () => bagDialog],
      ['closeCheckout', () => checkoutDialog],
      ['cancelCheckout', () => checkoutDialog]
    ].forEach(([id, getDialog]) => {
      const closeButton = document.getElementById(id);
      const dialog = getDialog();
      if (closeButton && dialog) closeButton.addEventListener('click', () => dialog.close());
    });

    if (continueButton) {
      continueButton.addEventListener('click', () => {
        const deliveryFields = Array.from(deliveryStep.querySelectorAll('input, textarea'));
        const invalidField = deliveryFields.find(field => !field.checkValidity());
        if (invalidField) {
          invalidField.reportValidity();
          return;
        }
        renderCheckoutSummary();
        showCheckoutStatus('', '');
        showCheckoutStep('payment');
      });
    }

    const backButton = document.getElementById('backToDelivery');
    if (backButton) backButton.addEventListener('click', () => showCheckoutStep('delivery'));

    [bagItems, checkoutItems].forEach(container => {
      if (container) container.addEventListener('click', event => {
        const button = event.target.closest('button[data-cart-action]');
        if (!button) return;
        const item = cart.get(button.dataset.productId);
        if (!item) return;
        if (button.dataset.cartAction === 'remove' ||
            (button.dataset.cartAction === 'decrease' && item.quantity === 1)) {
          cart.delete(item.id);
        } else if (button.dataset.cartAction === 'decrease') {
          item.quantity -= 1;
        } else if (button.dataset.cartAction === 'increase' && item.quantity < item.stock) {
          item.quantity += 1;
        }
        updateCartCount();
        renderBag();
        renderCheckoutSummary();
      });
    });

    if (checkoutForm) {
      checkoutForm.addEventListener('submit', async event => {
        event.preventDefault();
        if (!cart.size) {
          showCheckoutStatus('Add at least one item before placing an order.', 'error');
          return;
        }

        submitButton.disabled = true;
        showCheckoutStatus('Submitting your order…', '');
        try {
          const client = await getSupabaseClient();
          const values = new FormData(checkoutForm);
          const { data, error } = await client.rpc('place_shop_order', {
            p_customer_name: values.get('customerName'),
            p_customer_email: values.get('customerEmail'),
            p_customer_phone: values.get('customerPhone'),
            p_delivery_address: values.get('deliveryAddress'),
            p_payment_method: values.get('paymentMethod'),
            p_items: Array.from(cart.values(), item => ({
              id: item.id,
              quantity: item.quantity
            }))
          });
          if (error) throw error;

          const order = Array.isArray(data) ? data[0] : data;
          if (!order || !order.order_number) {
            throw new Error('Supabase saved the order but returned no order number.');
          }
          cart.clear();
          updateCartCount();
          checkoutForm.reset();
          showCheckoutStatus(
            'Order ' + order.order_number + ' placed. Total: ' + formatPrice(Number(order.total_amount)) +
            '. Payment will be arranged using your selected method.',
            'success'
          );
          loadProducts().catch(refreshError => {
            console.error('Order was placed, but the product list could not refresh:', refreshError);
            if (status) {
              status.textContent = 'Order placed, but stock could not refresh. Reload the page to see current inventory.';
              status.classList.add('is-error');
            }
          });
        } catch (error) {
          const reason = error && (error.message || error.hint || error.details);
          console.error('Could not place Shop Gear order:', reason || error);
          showCheckoutStatus(
            'Could not place your order: ' + (reason || 'Supabase returned an unknown error.'),
            'error'
          );
        } finally {
          submitButton.disabled = false;
        }
      });
    }
  }

  /**
   * Workout page: muscle-group tabs and a video modal.
   * Each tutorial card carries its video src + title in data attributes.
   */
  function bindWorkoutFeatures() {
    const tabs  = document.querySelectorAll('.workout-tab');
    const cards = document.querySelectorAll('.workout-card');
    const modal = document.getElementById('workoutModal');
    const video = document.getElementById('workoutVideo');
    const title = document.getElementById('workoutModalTitle');
    if (!tabs.length && !modal) return;

    // Show only the cards belonging to one muscle group.
    function showGroup(group) {
      cards.forEach(card => {
        card.style.display = (card.dataset.group === group) ? '' : 'none';
      });
    }

    tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        tabs.forEach(t => {
          t.classList.remove('active');
          t.setAttribute('aria-selected', 'false');
        });
        tab.classList.add('active');
        tab.setAttribute('aria-selected', 'true');
        showGroup(tab.dataset.group);
      });
    });

    if (modal && video) {
      // Open the modal and start playback for a card.
      function openCard(card) {
        title.textContent = card.dataset.title || 'Workout tutorial';
        video.src = card.dataset.src;
        video.load();
        if (modal.showModal) modal.showModal();
        const p = video.play();
        if (p && p.catch) p.catch(() => {});
      }

      cards.forEach(card => {
        card.addEventListener('click', () => openCard(card));
        card.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openCard(card);
          }
        });
      });

      // Stop playback and unload the video when the modal closes.
      modal.querySelectorAll('.modal-close').forEach(btn => {
        btn.addEventListener('click', () => {
          modal.close();
          video.pause();
          video.removeAttribute('src');
          video.load();
        });
      });
    }

    // Initial render matches the active tab.
    const active = document.querySelector('.workout-tab.active');
    showGroup(active ? active.dataset.group : 'chest');
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
