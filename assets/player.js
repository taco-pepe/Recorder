/* Recorded player.
 *
 * Invidious gives us a DASH manifest whose segment URLs can be proxied through
 * the instance (`local=true`). Piped gives us a muxed MP4. dash.js is loaded
 * lazily, only when a watch page actually needs it.
 */

let dashLoader = null;

function loadDash() {
  if (globalThis.dashjs) return Promise.resolve(globalThis.dashjs);
  if (!dashLoader) {
    dashLoader = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = new URL('./vendor/dash.all.min.js', import.meta.url).href;
      script.async = true;
      script.onload = () => {
        if (globalThis.dashjs) resolve(globalThis.dashjs);
        else reject(new Error('dash.js loaded but did not register.'));
      };
      script.onerror = () => reject(new Error('Could not load the player engine.'));
      document.head.append(script);
    });
  }
  return dashLoader;
}

function absolute(url, base) {
  try {
    return new URL(url, base).href;
  } catch {
    return url;
  }
}

async function prepareManifest(url, proxy) {
  const response = await fetch(proxy(url));
  if (!response.ok) throw new Error(`Manifest fetch failed (${response.status}).`);
  const text = await response.text();
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('The instance sent a broken DASH manifest.');

  const periods = [...doc.querySelectorAll('Period')];
  const hasStreams = periods.some((period) => period.querySelector('AdaptationSet Representation'));
  if (!periods.length || !hasStreams) {
    throw new Error('This instance returned an empty DASH manifest.');
  }

  for (const node of doc.querySelectorAll('BaseURL')) {
    node.textContent = proxy(absolute(node.textContent.trim(), url));
  }

  const blob = new Blob([new XMLSerializer().serializeToString(doc)], { type: 'application/dash+xml' });
  const blobUrl = URL.createObjectURL(blob);
  return { url: blobUrl, revoke: () => URL.revokeObjectURL(blobUrl) };
}

function formatTime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

export function createPlayer({ container, details, proxy = (u) => u, autoplay = true, onError, onNotice, onQualities, onState, onTime } = {}) {
  const video = document.createElement('video');
  video.controls = true;
  video.playsInline = true;
  video.preload = 'metadata';
  video.poster = details.thumbnail || details.thumb || '';
  video.setAttribute('aria-label', details.title || 'Video player');

  const stage = document.createElement('div');
  stage.className = 'rc-audio-stage';
  stage.innerHTML = `
    <div class="rc-audio-stage__disc" aria-hidden="true"></div>
    <div class="rc-audio-stage__label">Audio only</div>
    <div class="rc-audio-stage__bar">
      <audio controls preload="metadata" aria-label="Audio player"></audio>
    </div>
  `;

  const audio = stage.querySelector('audio');

  const loading = document.createElement('div');
  loading.className = 'rc-player__loading';
  loading.innerHTML = '<div class="rc-spinner" aria-hidden="true"></div><span>Loading stream…</span>';

  container.append(video, stage, loading);

  const state = {
    dash: null,
    manifestUrl: null,
    revoke: null,
    mode: 'video',
    destroyed: false,
    qualities: [],
    rate: 1,
    recovering: false,
    fallbackStarted: false,
    fallbackIndex: 0,
  };

  function setLoading(text) {
    if (text) {
      loading.hidden = false;
      const span = loading.querySelector('span');
      if (span) span.textContent = text;
    } else {
      loading.hidden = true;
    }
  }

  function emitState() {
    const media = currentMedia();
    onState?.({
      playing: media ? !media.paused && !media.ended : false,
      mode: state.mode,
      muted: media ? media.muted : false,
      volume: media ? media.volume : 1,
      rate: state.rate,
      duration: media?.duration || 0,
      currentTime: media?.currentTime || 0,
    });
  }

  function currentMedia() {
    if (state.mode === 'audio' && !audio.hidden) return audio;
    return video;
  }

  function wireMedia(media, kind) {
    media.addEventListener('play', emitState);
    media.addEventListener('pause', emitState);
    media.addEventListener('ended', emitState);
    media.addEventListener('volumechange', emitState);
    media.addEventListener('playing', () => {
      if (currentMedia() === media) setLoading(null);
    });
    media.addEventListener('timeupdate', () => {
      if (currentMedia() !== media) return;
      onTime?.({ currentTime: media.currentTime || 0, duration: media.duration || 0, mode: state.mode });
    });
    media.addEventListener('loadedmetadata', () => {
      if (kind === 'audio') {
        stage.querySelector('.rc-audio-stage__label').textContent =
          `Audio only · ${formatTime(media.duration)}`;
      }
      emitState();
    });
    media.addEventListener('error', () => {
      if (state.destroyed || state.recovering) return;
      const message = kind === 'audio' ? 'Could not load the audio stream.' : 'Could not load the video stream.';
      onError?.({ message, kind });
    });
  }

  wireMedia(video, 'video');
  wireMedia(audio, 'audio');

  function collectQualities() {
    if (!state.dash) return [];
    try {
      const list = state.dash.getRepresentationsByType('video') || [];
      const seen = new Set();
      const qualities = [];
      for (const item of list) {
        if (!item || !item.height || seen.has(item.height)) continue;
        seen.add(item.height);
        qualities.push({
          height: item.height,
          width: item.width,
          bitrate: item.bandwidth,
          id: item.id,
          index: item.index,
        });
      }
      qualities.sort((a, b) => b.height - a.height);
      state.qualities = qualities;
      onQualities?.(state.qualities);
    } catch {
      state.qualities = [];
      onQualities?.([]);
    }
    return state.qualities;
  }

  function setQuality(quality) {
    if (!state.dash) return false;
    try {
      if (quality === 'auto' || quality == null) {
        state.dash.updateSettings({ streaming: { abr: { autoSwitchBitrate: { video: true } } } });
        return true;
      }
      const target = state.qualities.find((q) => q.height === Number(quality));
      if (!target) return false;
      state.dash.updateSettings({ streaming: { abr: { autoSwitchBitrate: { video: false } } } });
      if (target.id != null && state.dash.setRepresentationForTypeById) {
        state.dash.setRepresentationForTypeById('video', String(target.id), true);
        return true;
      }
      if (target.index != null && state.dash.setRepresentationForTypeByIndex) {
        state.dash.setRepresentationForTypeByIndex('video', target.index, true);
        return true;
      }
    } catch {
      return false;
    }
    return false;
  }

  function attachCaptions() {
    const tracks = details.captions || [];
    for (const caption of tracks.slice(0, 20)) {
      if (!caption.url) continue;
      const track = document.createElement('track');
      track.kind = 'captions';
      track.label = caption.label || caption.lang || 'Captions';
      track.srclang = caption.lang || 'en';
      track.src = proxy(caption.url);
      video.append(track);
    }
  }

  function resetDash() {
    if (state.revoke) {
      state.revoke();
      state.revoke = null;
    }
    try {
      state.dash?.reset();
    } catch {
      /* dash may not have initialised */
    }
    state.dash = null;
    state.qualities = [];
    onQualities?.([]);
  }

  function audioFallback(reason) {
    if (!details.streams.audioUrl) return false;
    state.recovering = true;
    setLoading(null);
    if (!audio.src) {
      audio.src = proxy(details.streams.audioUrl);
      audio.load();
    }
    setMode('audio');
    onNotice?.('Only audio is available for this video.');
    state.recovering = false;
    return true;
  }

  function nextNativeFallback(reason) {
    if (state.destroyed) return;
    const sources = [];
    const push = (url) => {
      if (url && !sources.includes(url)) sources.push(url);
    };
    push(details.streams.playbackUrl);
    for (const item of details.streams.muxed || []) push(item?.url);
    if (details.streams.hlsUrl && video.canPlayType('application/vnd.apple.mpegurl')) {
      push(details.streams.hlsUrl);
    }

    if (state.fallbackIndex < sources.length) {
      playNative(sources[state.fallbackIndex], reason);
      state.fallbackIndex += 1;
      return;
    }

    if (audioFallback(reason)) return;

    state.recovering = false;
    setLoading(null);
    onError?.({ message: reason || 'No playable stream was returned.', kind: 'video' });
  }

  function playNative(url, reason) {
    setLoading('Trying a fallback stream…');
    if (reason) onNotice?.(`${reason} Trying a fallback stream.`);
    video.src = proxy(url);
    video.load();

    const finish = () => {
      video.removeEventListener('loadedmetadata', onMeta);
      video.removeEventListener('error', onFail);
    };
    const onMeta = () => {
      finish();
      state.recovering = false;
      setLoading(null);
      if (autoplay) video.play().catch(() => {});
      emitState();
    };
    const onFail = () => {
      finish();
      state.recovering = true;
      nextNativeFallback(reason);
    };
    video.addEventListener('loadedmetadata', onMeta);
    video.addEventListener('error', onFail);
  }

  function beginFallback(reason, { notify = true } = {}) {
    if (state.destroyed || state.fallbackStarted) return;
    state.fallbackStarted = true;
    state.recovering = true;
    state.fallbackIndex = 0;
    resetDash();
    if (notify && reason) onNotice?.(reason);
    nextNativeFallback(reason);
  }

  async function tryDash() {
    setLoading('Loading stream…');
    const dashjs = await loadDash();
    const manifest = await prepareManifest(details.streams.dashUrl, proxy);
    state.manifestUrl = manifest.url;
    state.revoke = manifest.revoke;
    if (state.destroyed) {
      manifest.revoke?.();
      return;
    }

    state.dash = dashjs.MediaPlayer().create();
    state.dash.updateSettings({
      debug: { logLevel: 0 },
      streaming: {
        buffer: { fastSwitchEnabled: true, stallThreshold: 0.5 },
      },
    });

    state.dash.on('manifestLoaded', () => {
      if (state.destroyed) return;
      collectQualities();
      setLoading(null);
      emitState();
    });
    state.dash.on('canPlay', () => {
      if (state.destroyed) return;
      setLoading(null);
      emitState();
    });
    state.dash.on('representationSwitch', () => collectQualities());
    state.dash.on('error', (event) => {
      const message =
        event?.error === 'capability' || event?.error === 'MEDIA_ERR_SRC_NOT_SUPPORTED'
          ? 'This browser cannot play that stream.'
          : 'The instance could not keep the stream alive.';
      beginFallback(message);
    });

    state.dash.initialize(video, manifest.url, autoplay);
  }

  function setMode(mode, { autoplay: shouldPlay = true } = {}) {
    const next = mode === 'audio' ? 'audio' : 'video';
    if (next === 'audio' && !details.streams.audioUrl) return false;

    const previous = currentMedia();
    const time = previous?.currentTime || 0;
    const wasPlaying = previous ? !previous.paused : false;

    if (next === 'audio') {
      video.pause();
      stage.classList.add('is-on');
      stage.classList.toggle('is-playing', wasPlaying || shouldPlay);
      audio.hidden = false;
      if (!audio.src) {
        audio.src = proxy(details.streams.audioUrl);
        audio.load();
      }
      if (time > 0 && Number.isFinite(time)) {
        try {
          audio.currentTime = Math.min(time, audio.duration || time);
        } catch {
          /* metadata may not be ready yet */
        }
      }
      state.mode = 'audio';
      setLoading(null);
      if (shouldPlay) audio.play().catch(() => {});
    } else {
      audio.pause();
      stage.classList.remove('is-on', 'is-playing');
      state.mode = 'video';
      if (wasPlaying || shouldPlay) {
        const t = audio.currentTime || 0;
        if (t > 0) {
          try {
            if (state.dash?.seek) state.dash.seek(t);
            else video.currentTime = t;
          } catch {
            /* ignore */
          }
        }
        video.play().catch(() => {});
      }
    }

    state.rate = 1;
    currentMedia().playbackRate = state.rate;
    emitState();
    return true;
  }

  audio.addEventListener('play', () => stage.classList.add('is-playing'));
  audio.addEventListener('pause', () => stage.classList.remove('is-playing'));
  video.addEventListener('play', () => stage.classList.remove('is-playing'));

  const api = {
    video,
    audio,
    stage,
    start,
    setMode,
    setQuality,
    getQualities: () => state.qualities,
    get mode() {
      return state.mode;
    },
    currentMedia,
    togglePlay() {
      const media = currentMedia();
      if (!media) return;
      if (media.paused) media.play().catch(() => {});
      else media.pause();
    },
    seekBy(seconds) {
      const media = currentMedia();
      if (!media) return;
      const max = media.duration || Infinity;
      const next = Math.min(max, Math.max(0, (media.currentTime || 0) + seconds));
      if (state.mode === 'video' && state.dash?.seek) state.dash.seek(next);
      else media.currentTime = next;
    },
    toggleMute() {
      const media = currentMedia();
      if (!media) return;
      media.muted = !media.muted;
    },
    setRate(rate) {
      state.rate = Math.min(2, Math.max(0.25, Number(rate) || 1));
      currentMedia().playbackRate = state.rate;
      emitState();
    },
    getCurrentTime() {
      return currentMedia()?.currentTime || 0;
    },
    setCurrentTime(seconds) {
      if (!Number.isFinite(seconds) || seconds <= 0) return;
      if (state.mode === 'video' && state.dash?.seek) {
        state.dash.seek(seconds);
      } else {
        try {
          currentMedia().currentTime = seconds;
        } catch {
          /* metadata not ready */
        }
      }
    },
    destroy() {
      state.destroyed = true;
      try {
        video.pause();
        audio.pause();
        state.dash?.reset();
      } catch {
        /* ignore */
      }
      if (state.revoke) state.revoke();
      video.removeAttribute('src');
      video.load();
      audio.removeAttribute('src');
      audio.load();
      video.remove();
      stage.remove();
      loading.remove();
      state.dash = null;
    },
  };

  async function start() {
    attachCaptions();
    if (!details.streams.dashUrl) {
      beginFallback('', { notify: false });
      return;
    }
    try {
      await tryDash();
    } catch (error) {
      if (state.destroyed) return;
      beginFallback(error.message || 'The video stream did not start.');
    }
  }

  start();
  return api;
}

export { formatTime };
