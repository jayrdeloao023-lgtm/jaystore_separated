(function () {
  'use strict';

  const IS_MUSIC_PAGE = /\/music\.html?$/i.test(location.pathname) || location.pathname.endsWith('/music.html');
  const LS_PREFIX = 'jaystore_';
  const LS_KEYS = {
    player: LS_PREFIX + 'player',
    pos: LS_PREFIX + 'player_pos'
  };

  const INTERNAL_PATHS = ['index.html', 'about.html', 'shop.html', 'music.html', 'journey.html'];
  const BASE_PATH = location.pathname.replace(/[^/]+$/, '') || '/';

  function resolveUrl(src) {
    try {
      const url = new URL(src, location.href);
      url.pathname = encodeURI(url.pathname);
      return url.href;
    } catch (e) { return encodeURI(src); }
  }

  const audio = document.getElementById('persistent-audio');
  const player = document.getElementById('floating-player');

  if (!audio || !player) return;

  let tracks = [];
  let currentIndex = -1;
  let restoringState = false;

  const els = {
    art: player.querySelector('.fp-art'),
    title: player.querySelector('.fp-title'),
    artist: player.querySelector('.fp-artist'),
    play: player.querySelector('.fp-play'),
    prev: player.querySelector('.fp-prev'),
    next: player.querySelector('.fp-next'),
    close: player.querySelector('.fp-close'),
    progress: player.querySelector('.fp-progress'),
    bar: player.querySelector('.fp-progress-bar'),
    current: player.querySelector('.fp-current'),
    duration: player.querySelector('.fp-duration'),
    volume: player.querySelector('.fp-volume'),
    volIcon: player.querySelector('.fp-vol-icon')
  };

  function formatTime(seconds) {
    if (!isFinite(seconds) || isNaN(seconds)) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60).toString().padStart(2, '0');
    return m + ':' + s;
  }

  function saveState() {
    const state = {
      src: audio.currentSrc || '',
      title: currentIndex >= 0 && tracks[currentIndex] ? tracks[currentIndex].title : (els.title ? els.title.textContent : ''),
      artist: currentIndex >= 0 && tracks[currentIndex] ? tracks[currentIndex].artist : (els.artist ? els.artist.textContent : ''),
      index: currentIndex,
      time: audio.currentTime || 0,
      paused: audio.paused,
      volume: audio.volume,
      hidden: player.classList.contains('is-hidden'),
      playedOnce: currentIndex >= 0
    };
    try { localStorage.setItem(LS_KEYS.player, JSON.stringify(state)); } catch (e) {}
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(LS_KEYS.player);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function updatePlayerUI() {
    const track = tracks[currentIndex];
    if (!track) return;
    els.title.textContent = track.title || 'Untitled';
    els.artist.textContent = track.artist || 'Unknown artist';
    els.art.textContent = (track.title || '♪').slice(0, 2).toUpperCase();
    els.play.innerHTML = audio.paused ? '▶' : '❚❚';
  }

  function highlightActiveTrack() {
    if (!IS_MUSIC_PAGE) return;
    document.querySelectorAll('.spotify-track, .spotify-feature').forEach(el => {
      const idx = Number(el.dataset.track ?? -1);
      el.classList.toggle('active', idx === currentIndex);
    });
  }

  function loadTrack(index, autoplay) {
    if (!tracks.length) return;
    if (index < 0) index = tracks.length - 1;
    if (index >= tracks.length) index = 0;
    currentIndex = index;
    const track = tracks[index];
    if (!track) return;
    const resolved = resolveUrl(track.src);
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

  function playIndex(index) {
    loadTrack(index, true);
  }

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

  function playNext() {
    if (!tracks.length) return;
    let next = currentIndex + 1;
    while (next < tracks.length && !tracks[next]) next++;
    if (next >= tracks.length) next = 0;
    while (next < tracks.length && !tracks[next]) next++;
    if (tracks[next]) playIndex(next);
  }

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

  function seekFromEvent(e) {
    const rect = els.progress.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    if (audio.duration) audio.currentTime = ratio * audio.duration;
  }

  function updateProgress() {
    const duration = audio.duration || 0;
    const current = audio.currentTime || 0;
    const ratio = duration ? (current / duration) * 100 : 0;
    els.bar.style.width = ratio + '%';
    els.current.textContent = formatTime(current);
    els.duration.textContent = formatTime(duration);
  }

  function updateVolumeIcon() {
    const vol = audio.volume;
    els.volIcon.textContent = vol === 0 ? '🔇' : (vol < 0.5 ? '🔉' : '🔊');
  }

  function readTracksFromPage() {
    if (!IS_MUSIC_PAGE) return;
    tracks = [];
    const feature = document.querySelector('.spotify-feature');
    if (feature) {
      const btn = feature.querySelector('.spotify-play');
      if (btn && btn.dataset.audioSrc) {
        tracks.push({
          src: btn.dataset.audioSrc,
          title: btn.dataset.title || feature.querySelector('h2')?.textContent || 'Feature',
          artist: btn.dataset.artist || 'Jaystore demo',
          el: feature
        });
        feature.dataset.track = '0';
      }
    }
    document.querySelectorAll('.spotify-track').forEach((el, i) => {
      const offset = feature ? 1 : 0;
      const src = el.dataset.audioSrc;
      const title = el.dataset.title || el.querySelector('.spotify-name')?.textContent || ('Track ' + (i + 1));
      const artist = el.dataset.artist || el.querySelector('.spotify-meta')?.textContent || 'Unknown';
      el.dataset.track = String(offset + i);
      if (src) {
        tracks[offset + i] = { src, title, artist, el };
      }
    });
  }

  function bindMusicPage() {
    if (!IS_MUSIC_PAGE) return;
    const featureBtn = document.querySelector('.spotify-feature .spotify-play');
    if (featureBtn) {
      featureBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        playIndex(0);
      });
    } else {
      console.warn('Feature play button not found');
    }

    document.querySelectorAll('.spotify-track').forEach(el => {
      const idx = Number(el.dataset.track);
      if (isNaN(idx) || idx < 0) return;
      el.addEventListener('click', (e) => {
        if (e.target.closest('.spotify-track-upload') || e.target.closest('.spotify-add') || e.target.closest('.spotify-more')) return;
        const t = tracks[idx];
        if (t && t.src) playIndex(idx);
        else player.classList.remove('is-hidden');
      });

      const input = el.querySelector('input[type="file"][data-track-input]');
      if (input) {
        input.addEventListener('change', (ev) => {
          const file = ev.target.files[0];
          if (!file) return;
          const url = URL.createObjectURL(file);
          const existing = tracks[idx];
          if (existing) {
            existing.src = url;
            existing.title = el.dataset.title || el.querySelector('.spotify-name')?.textContent || file.name;
            existing.artist = el.dataset.artist || el.querySelector('.spotify-meta')?.textContent || 'Local file';
          } else {
            const title = el.dataset.title || el.querySelector('.spotify-name')?.textContent || file.name;
            const artist = el.dataset.artist || el.querySelector('.spotify-meta')?.textContent || 'Local file';
            tracks[idx] = { src: url, title, artist, el };
          }
          playIndex(idx);
        });
      }
    });
  }

  function bindPlayerControls() {
    els.play.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePlay();
    });
    els.next.addEventListener('click', (e) => {
      e.stopPropagation();
      playNext();
    });
    els.prev.addEventListener('click', (e) => {
      e.stopPropagation();
      playPrev();
    });
    els.close.addEventListener('click', (e) => {
      e.stopPropagation();
      audio.pause();
      player.classList.add('is-hidden');
      saveState();
    });
    els.volume.addEventListener('click', (e) => e.stopPropagation());
    els.volume.addEventListener('input', () => {
      audio.volume = Number(els.volume.value);
      updateVolumeIcon();
      saveState();
    });

    let seeking = false;
    els.progress.addEventListener('pointerdown', (e) => {
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

    audio.addEventListener('timeupdate', () => {
      updateProgress();
      if (Math.floor(audio.currentTime) % 5 === 0) saveState();
    });
    audio.addEventListener('loadedmetadata', updateProgress);
    audio.addEventListener('error', () => {
      console.error('Audio load error. src:', audio.src);
    });
    audio.addEventListener('play', () => { updatePlayerUI(); saveState(); });
    audio.addEventListener('pause', () => { updatePlayerUI(); saveState(); });
    audio.addEventListener('ended', () => playNext());
    audio.addEventListener('volumechange', updateVolumeIcon);
  }

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
    if (state.title) els.title.textContent = state.title;
    if (state.artist) els.artist.textContent = state.artist;
    els.art.textContent = (state.title || '♪').slice(0, 2).toUpperCase();
    currentIndex = typeof state.index === 'number' ? state.index : -1;
    if (state.hidden) player.classList.add('is-hidden');
    else player.classList.remove('is-hidden');
    updateProgress();
    updateVolumeIcon();
    if (state.time && isFinite(state.time)) {
      try {
        audio.currentTime = state.time;
      } catch (e) {}
    }
    if (!state.paused) {
      const p = audio.play();
      if (p && p.catch) p.catch((err) => console.warn('Restore play failed:', err?.name || err));
    }
    restoringState = false;
  }

  const SNAP_MARGIN = 14;

  function snapPosition(rect) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const halfW = vw / 2;
    const halfH = vh / 2;
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;

    const targets = [
      { x: SNAP_MARGIN, y: SNAP_MARGIN },
      { x: vw - rect.width - SNAP_MARGIN, y: SNAP_MARGIN },
      { x: SNAP_MARGIN, y: vh - rect.height - SNAP_MARGIN },
      { x: vw - rect.width - SNAP_MARGIN, y: vh - rect.height - SNAP_MARGIN },
      { x: halfW - rect.width / 2, y: SNAP_MARGIN },
      { x: halfW - rect.width / 2, y: vh - rect.height - SNAP_MARGIN },
      { x: SNAP_MARGIN, y: halfH - rect.height / 2 },
      { x: vw - rect.width - SNAP_MARGIN, y: halfH - rect.height / 2 }
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

  function savePosition() {
    const rect = player.getBoundingClientRect();
    try {
      localStorage.setItem(LS_KEYS.pos, JSON.stringify({ left: rect.left, top: rect.top }));
    } catch (e) {}
  }

  function loadPosition() {
    try {
      const raw = localStorage.getItem(LS_KEYS.pos);
      if (!raw) return;
      const pos = JSON.parse(raw);
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const rect = player.getBoundingClientRect();
      let left = Math.min(Math.max(0, pos.left), vw - rect.width);
      let top = Math.min(Math.max(0, pos.top), vh - rect.height);
      player.style.left = left + 'px';
      player.style.top = top + 'px';
      player.style.right = 'auto';
      player.style.bottom = 'auto';
    } catch (e) {}
  }

  function snapPlayer(animate) {
    const rect = player.getBoundingClientRect();
    const target = snapPosition(rect);
    if (animate) player.classList.add('is-snapping');
    player.style.left = target.x + 'px';
    player.style.top = target.y + 'px';
    player.style.right = 'auto';
    player.style.bottom = 'auto';
    if (animate) {
      setTimeout(() => player.classList.remove('is-snapping'), 220);
    }
    savePosition();
  }

  function initDrag() {
    let dragging = false;
    let startX = 0, startY = 0;
    let origLeft = 0, origTop = 0;
    const handle = player.querySelector('.fp-handle') || player;

    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (e.target.closest('.fp-btn, .fp-close, .fp-progress, .fp-volume')) return;
      dragging = true;
      player.setPointerCapture && player.setPointerCapture(e.pointerId);
      player.classList.add('is-dragging');
      startX = e.clientX;
      startY = e.clientY;
      const rect = player.getBoundingClientRect();
      origLeft = rect.left;
      origTop = rect.top;
      player.style.left = origLeft + 'px';
      player.style.top = origTop + 'px';
      player.style.right = 'auto';
      player.style.bottom = 'auto';
    });

    window.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      let left = origLeft + dx;
      let top = origTop + dy;
      const rect = player.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      left = Math.max(0, Math.min(left, vw - rect.width));
      top = Math.max(0, Math.min(top, vh - rect.height));
      player.style.left = left + 'px';
      player.style.top = top + 'px';
    });

    window.addEventListener('pointerup', () => {
      if (!dragging) return;
      dragging = false;
      player.classList.remove('is-dragging');
      snapPlayer(true);
    });
  }

  const baseTitle = document.title;
  async function navigateTo(url, push = true) {
    const cleanUrl = new URL(url, location.href);
    if (cleanUrl.origin !== location.origin) {
      location.assign(url);
      return;
    }
    const path = cleanUrl.pathname.replace(BASE_PATH, '').replace(/^\//, '') || 'index.html';
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

      const currentContent = document.getElementById('page-content');
      if (currentContent && nextContent) {
        currentContent.replaceWith(nextContent);
      }
      if (push && history.pushState) {
        history.pushState({ path: cleanUrl.pathname + cleanUrl.search }, '', cleanUrl.href);
      }
      document.title = doc.title || baseTitle;
      window.scrollTo(0, 0);
      initPageFeatures();
    } catch (err) {
      location.assign(url);
    }
  }

  function interceptLinks(scope) {
    scope.addEventListener('click', (e) => {
      const a = e.target.closest('a[href]');
      if (!a) return;
      const href = a.getAttribute('href');
      if (!href) return;
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
      if (href.startsWith('http') && !href.startsWith(location.origin)) return;
      if (a.target === '_blank' || e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      navigateTo(href, true);
    });
  }

  function initPageFeatures() {
    readTracksFromPage();
    bindMusicPage();
    highlightActiveTrack();
    bindJourneyFeatures();
    bindShopFeatures();
    if (!restoringState && currentIndex >= 0 && tracks[currentIndex]) {
      updatePlayerUI();
    }
    if (IS_MUSIC_PAGE) {
      console.log('Music page tracks:', tracks.map(t => t ? t.title : null));
    }
  }

  function bindJourneyFeatures() {
    const progressModal = document.getElementById('progressModal');
    const routineModal = document.getElementById('routineModal');
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

  window.addEventListener('popstate', () => {
    navigateTo(location.href, false);
  });

  window.addEventListener('DOMContentLoaded', () => {
    interceptLinks(document);
    bindPlayerControls();
    loadPosition();
    initDrag();
    initPageFeatures();
    snapPlayer(false);
    restorePlayer();
  });

  window.addEventListener('resize', () => {
    snapPlayer(true);
  });
})();
