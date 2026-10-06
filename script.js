const searchInput = document.querySelector('.search-form input');
    const searchForm = document.querySelector('.search-form');
    const productCards = document.querySelectorAll('.product-card');
    const cartCount = document.getElementById('cartCount');
    const playlistAudio = document.getElementById('playlistAudio');
    const trackButtons = document.querySelectorAll('.track');
    let cartTotal = 0;

    function saveUploadedFile(key, file) {
      if (!file || !window.localStorage) return null;

      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result;
          window.localStorage.setItem(`jaystore_${key}`, dataUrl);
          resolve(dataUrl);
        };
        reader.readAsDataURL(file);
      });
    }

    function restoreUploadedFile(key) {
      if (!window.localStorage) return null;
      return window.localStorage.getItem(`jaystore_${key}`);
    }

    document.querySelectorAll('[data-track-input]').forEach((input) => {
      const key = `track-${input.dataset.trackInput}`;
      const saved = restoreUploadedFile(key);

      if (saved && playlistAudio) {
        const track = input.closest('.spotify-track');
        if (track) {
          track.dataset.audioSrc = saved;
          const metaTarget = track.querySelector('.spotify-meta');
          if (metaTarget) {
            metaTarget.textContent = 'Uploaded track';
          }
          track.classList.add('active');
        }
        playlistAudio.src = saved;
        playlistAudio.load();
      }

      input.addEventListener('change', async () => {
        const file = input.files[0];
        if (!file) return;

        const trackIndex = input.dataset.trackInput;
        const track = input.closest('.spotify-track') || input.closest('.track');
        const fileSrc = await saveUploadedFile(key, file);

        if (fileSrc && playlistAudio) {
          playlistAudio.src = fileSrc;
          playlistAudio.load();
        }

        const nameTarget = document.getElementById(`trackName${trackIndex}`);
        if (nameTarget) {
          nameTarget.textContent = file.name;
        }

        if (track) {
          track.dataset.fileName = file.name;

          if (track.classList.contains('spotify-track')) {
            const metaTarget = track.querySelector('.spotify-meta');
            if (metaTarget) {
              metaTarget.textContent = file.name;
            }
            track.dataset.audioSrc = fileSrc;
            track.classList.add('active');
          } else {
            trackButtons.forEach((item) => item.classList.remove('active'));
            track.classList.add('active');
          }
        }
      });
    });

    trackButtons.forEach((track) => {
      track.addEventListener('click', (event) => {
        if (event.target.closest('.track-upload')) return;
        if (track.classList.contains('active') && playlistAudio.src) {
          playlistAudio.play();
        }
      });
    });

    if (searchForm) {
      searchForm.addEventListener('submit', (event) => {
        event.preventDefault();
        document.getElementById('shop').scrollIntoView({ behavior: 'smooth' });
      });
    }

    if (searchInput) {
      searchInput.addEventListener('input', () => {
        const searchTerm = searchInput.value.toLowerCase().trim();

        productCards.forEach((card) => {
          const matches = card.dataset.product.includes(searchTerm);
          card.hidden = !matches;
        });
      });
    }

    if (playlistAudio) {
      const spotifyTracks = document.querySelectorAll('.spotify-track');

      const setActiveSpotifyTrack = (row) => {
        spotifyTracks.forEach((track) => track.classList.toggle('active', track === row));
      };

      spotifyTracks.forEach((track) => {
        track.addEventListener('click', (event) => {
          if (event.target.closest('.spotify-track-upload')) return;

          setActiveSpotifyTrack(track);

          if (track.dataset.audioSrc) {
            playlistAudio.src = track.dataset.audioSrc;
            playlistAudio.load();
            playlistAudio.play().catch(() => {});
            return;
          }

          if (track.dataset.spotifyUrl) {
            window.open(track.dataset.spotifyUrl, '_blank', 'noopener');
          }
        });
      });

    }

    document.querySelectorAll('.add-cart').forEach((button) => {
      button.addEventListener('click', () => {
        cartTotal++;
        cartCount.textContent = `Cart: ${cartTotal}`;
        button.textContent = 'Added';
      });
    });

    const routines = {
      3: ['Push - chest, shoulders, triceps', 'Pull - back, biceps', 'Legs - quads, hamstrings, calves'],
      4: ['Upper - chest, back, shoulders, arms', 'Lower - quads, hamstrings, calves', 'Upper - strength and volume', 'Lower - legs and core'],
      5: ['Chest + triceps', 'Back + biceps', 'Legs', 'Shoulders + abs', 'Full body conditioning'],
      7: ['Chest + triceps', 'Back + biceps', 'Legs', 'Shoulders + abs', 'Arms + core', 'Full body strength', 'Active recovery / rest']
    };

    const routineList = document.getElementById('routineList');

    function showRoutine(days) {
      if (!routineList) return;

      const dayPlan = routines[days];
      if (!dayPlan) return;

      routineList.innerHTML = dayPlan.map((routine, index) => `
        <div class="routine-day">
          <strong>Day ${index + 1}</strong>
          <span>${routine}</span>
          <label class="routine-video">
            <strong>Add workout video</strong>
            <small>MP4 or MOV</small>
            <input type="file" accept="video/*" aria-label="Add video for Day ${index + 1}" />
            <video controls playsinline preload="metadata"></video>
          </label>
        </div>
      `).join('');

      routineList.querySelectorAll('.routine-video input').forEach((input) => {
        const key = `routine-video-${input.closest('.routine-day')?.querySelector('strong')?.textContent || Math.random()}`;
        const saved = restoreUploadedFile(key);
        if (saved) {
          const videoSlot = input.closest('.routine-video');
          const preview = videoSlot.querySelector('video');
          if (preview) preview.src = saved;
          videoSlot.classList.add('has-video');
        }

        input.addEventListener('change', async () => {
          const file = input.files[0];
          if (!file) return;

          const dataUrl = await saveUploadedFile(key, file);
          const videoSlot = input.closest('.routine-video');
          const preview = videoSlot.querySelector('video');
          if (preview && dataUrl) preview.src = dataUrl;
          videoSlot.classList.add('has-video');
        });
      });
    }

    if (routineList) {
      showRoutine(3);

      document.querySelectorAll('.routine-tab').forEach((tab) => {
        tab.addEventListener('click', () => {
          document.querySelectorAll('.routine-tab').forEach((item) => item.classList.remove('active'));
          tab.classList.add('active');
          showRoutine(tab.dataset.days);
        });
      });
    }

    document.querySelectorAll('.journey-card').forEach((card) => {
      const openModal = () => document.getElementById(card.dataset.modal).showModal();

      card.addEventListener('click', openModal);
      card.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openModal();
        }
      });
    });

    document.querySelectorAll('dialog').forEach((modal) => {
      modal.addEventListener('click', (event) => {
        if (event.target === modal || event.target.closest('.modal-close')) {
          modal.close();
        }
      });
    });

    document.querySelectorAll('.photo-upload input').forEach((input) => {
      const key = `photo-${input.dataset.preview}`;
      const saved = restoreUploadedFile(key);
      if (saved) {
        const preview = document.getElementById(input.dataset.preview);
        if (preview) {
          preview.src = saved;
        }
        input.closest('.photo-upload').classList.add('has-photo');
      }

      input.addEventListener('change', async () => {
        const file = input.files[0];
        if (!file) return;

        const dataUrl = await saveUploadedFile(key, file);
        const preview = document.getElementById(input.dataset.preview);
        if (preview && dataUrl) {
          preview.src = dataUrl;
        }
        input.closest('.photo-upload').classList.add('has-photo');
      });
    });
