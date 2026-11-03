/* Recorded API layer.
 *
 * Recorded does not scrape YouTube from your browser. It talks to public
 * Invidious / Piped instances, which do the fetching and proxying. There is no
 * server of our own, no account, and no analytics.
 *
 * The public instance landscape changes constantly. The list below is a
 * starting point, not a promise. You can add your own instance in Settings.
 */

export const TYPE = Object.freeze({ INVIDIOUS: 'invidious', PIPED: 'piped' });

export const DEFAULT_INSTANCES = Object.freeze([
  {
    id: 'chocolatemoo53',
    name: 'chocolatemoo53',
    url: 'https://yt.chocolatemoo53.com',
    type: TYPE.INVIDIOUS,
    note: 'API + DASH + downloads',
  },
  {
    id: 'ducks',
    name: 'ducks.party',
    url: 'https://pipedapi.ducks.party',
    type: TYPE.PIPED,
    note: 'Piped · proxied 360p',
  },
  {
    id: 'private-coffee',
    name: 'private.coffee',
    url: 'https://api.piped.private.coffee',
    type: TYPE.PIPED,
    note: 'Piped · proxied 360p',
  },
]);

const HEALTH_KEY = 'recorded:health:v1';
const REQUEST_TIMEOUT = 14000;
const PROBE_TIMEOUT = 5500;
const HEALTH_FRESH = 1000 * 60 * 10;
const BAD_COOLDOWN = 1000 * 60 * 2;
const cache = new Map();

export class ApiError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = details.code || 'unknown';
    this.status = details.status || 0;
    this.url = details.url || '';
    this.instance = details.instance || null;
    this.cause = details.cause;
  }
}

let state = {
  instances: DEFAULT_INSTANCES.map((i) => ({ ...i })),
  selected: 'auto',
  active: null,
  onActive: null,
  proxy: (url) => url,
};

const health = loadHealth();

function loadHealth() {
  try {
    const raw = JSON.parse(sessionStorage.getItem(HEALTH_KEY) || '{}');
    const map = new Map();
    for (const [key, value] of Object.entries(raw)) {
      if (value && typeof value.at === 'number') map.set(key, value);
    }
    return map;
  } catch {
    return new Map();
  }
}

function saveHealth() {
  try {
    const obj = {};
    for (const [key, value] of health.entries()) obj[key] = value;
    sessionStorage.setItem(HEALTH_KEY, JSON.stringify(obj));
  } catch {
    /* storage can be disabled; health is optional */
  }
}

function recordHealth(instance, ok, ms) {
  health.set(instance.url, { ok, ms: Math.round(ms), at: Date.now() });
  saveHealth();
}

export function healthFor(instance) {
  return health.get(instance.url) || null;
}

function isFresh(entry) {
  return entry && Date.now() - entry.at < HEALTH_FRESH;
}

function isCooling(instance) {
  const entry = health.get(instance.url);
  return entry && entry.ok === false && Date.now() - entry.at < BAD_COOLDOWN;
}

function setActive(instance) {
  if (!instance) return;
  if (state.active?.url === instance.url) return;
  state.active = instance;
  try {
    state.onActive?.(instance);
  } catch {
    /* UI callback errors must not break data fetching */
  }
}

export function configure({ instances, selected, onActive, proxy } = {}) {
  if (Array.isArray(instances)) {
    state.instances = instances.map((i) => ({ ...i }));
  }
  if (typeof selected === 'string') state.selected = selected;
  if (typeof onActive === 'function') state.onActive = onActive;
  if (typeof proxy === 'function') state.proxy = proxy;
}

export function getInstances() {
  return state.instances.slice();
}

export function getSelected() {
  return state.selected;
}

export function getActive() {
  return state.active;
}

export function setSelected(id) {
  state.selected = id || 'auto';
  state.active = null;
  cache.clear();
}

export function clearCache() {
  cache.clear();
}

export function findInstance(id) {
  return state.instances.find((i) => i.id === id) || null;
}

export function makeInstance(url, type = TYPE.INVIDIOUS, name = '') {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('That does not look like a URL.');
  }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error('Only http(s) instances are supported.');
  if (parsed.username || parsed.password) throw new Error('Do not put credentials in an instance URL.');
  parsed.search = '';
  parsed.hash = '';
  const base = parsed.href.replace(/\/+$/, '');
  return {
    id: `custom-${base.replace(/[^a-z0-9]+/gi, '-').slice(0, 48)}`,
    name: name || parsed.hostname,
    url: base,
    type,
    custom: true,
    note: 'custom instance',
  };
}

function join(base, path) {
  return `${base.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
}

function timeoutSignal(ms, external) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, ms);

  const onAbort = () => controller.abort();
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener('abort', onAbort, { once: true });
  }

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    cleanup: () => {
      clearTimeout(timer);
      external?.removeEventListener('abort', onAbort);
    },
  };
}

async function readJson(response, url, instance) {
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('json')) {
    throw new ApiError('The instance returned something that was not JSON.', {
      code: 'bad-response',
      status: response.status,
      url,
      instance,
    });
  }
  try {
    return await response.json();
  } catch (cause) {
    throw new ApiError('The instance sent malformed JSON.', {
      code: 'bad-response',
      status: response.status,
      url,
      instance,
      cause,
    });
  }
}

async function fetchJson(url, instance, { timeout = REQUEST_TIMEOUT, signal } = {}) {
  const effectiveUrl = state.proxy(url);
  const wrapped = timeoutSignal(timeout, signal);
  try {
    const response = await fetch(effectiveUrl, {
      signal: wrapped.signal,
      headers: { Accept: 'application/json' },
      cache: 'default',
    });
    if (!response.ok) {
      throw new ApiError(`Instance returned HTTP ${response.status}.`, {
        code: response.status === 401 || response.status === 403 ? 'blocked' : 'http',
        status: response.status,
        url,
        instance,
      });
    }
    return await readJson(response, url, instance);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (wrapped.didTimeout()) {
      throw new ApiError('The instance took too long to answer.', {
        code: 'timeout',
        url,
        instance,
        cause: error,
      });
    }
    if (signal?.aborted) {
      throw new ApiError('Request cancelled.', { code: 'aborted', url, instance, cause: error });
    }
    throw new ApiError('Could not reach the instance. It may be down, blocked, or missing CORS headers.', {
      code: 'network',
      url,
      instance,
      cause: error,
    });
  } finally {
    wrapped.cleanup();
  }
}

function rank(instances, { prefer = TYPE.INVIDIOUS } = {}) {
  const now = Date.now();
  return [...instances].sort((a, b) => {
    const ha = health.get(a.url);
    const hb = health.get(b.url);

    const score = (instance, entry) => {
      let value = 0;
      if (!entry || now - entry.at > HEALTH_FRESH) value += 40; // unknown
      else if (entry.ok) value += 0;
      else value += 100;
      if (entry?.ok) value += Math.min(entry.ms, 5000) / 1000;
      if (instance.type !== prefer) value += 3;
      if (instance === state.active) value -= 4;
      if (instance.id === state.selected) value -= 6;
      return value;
    };

    return score(a, ha) - score(b, hb);
  });
}

function candidates(types, prefer) {
  let pool = state.instances.filter((i) => i.enabled !== false && types.includes(i.type));

  if (state.selected !== 'auto') {
    const selected = pool.find((i) => i.id === state.selected);
    if (selected) {
      pool = [selected, ...pool.filter((i) => i !== selected)];
    }
  }

  const live = pool.filter((i) => !isCooling(i));
  const cooling = pool.filter((i) => isCooling(i));
  return [...rank(live, { prefer }), ...rank(cooling, { prefer })];
}

export async function request(path, { types = [TYPE.INVIDIOUS, TYPE.PIPED], prefer, timeout, signal, ttl = 0 } = {}) {
  const list = candidates(types, prefer);
  if (!list.length) {
    throw new ApiError('No instances of that type are configured.', { code: 'no-instance' });
  }

  let lastError = null;
  for (const instance of list) {
    const url = join(instance.url, path);
    const cacheKey = `${instance.url}${path}`;
    const hit = cache.get(cacheKey);
    if (ttl > 0 && hit && Date.now() - hit.at < ttl) {
      setActive(instance);
      health.set(instance.url, { ok: true, ms: hit.ms || 0, at: Date.now() });
      return hit.data;
    }

    const started = performance.now();
    try {
      const data = await fetchJson(url, instance, { timeout, signal });
      const ms = performance.now() - started;
      recordHealth(instance, true, ms);
      setActive(instance);
      if (ttl > 0) cache.set(cacheKey, { at: Date.now(), data, ms });
      return data;
    } catch (error) {
      if (error.code === 'aborted') throw error;
      lastError = error;
      recordHealth(instance, false, performance.now() - started);
      // Try the next instance.
    }
  }

  throw lastError || new ApiError('Every instance failed.', { code: 'all-failed' });
}

export async function probe(instance, { timeout = PROBE_TIMEOUT } = {}) {
  const endpoint = instance.type === TYPE.INVIDIOUS ? '/api/v1/stats' : '/healthcheck';
  const url = join(instance.url, endpoint);
  const effectiveUrl = state.proxy(url);
  const started = performance.now();
  const wrapped = timeoutSignal(timeout);
  try {
    const response = await fetch(effectiveUrl, {
      signal: wrapped.signal,
      cache: 'no-store',
      headers: { Accept: instance.type === TYPE.INVIDIOUS ? 'application/json' : 'text/plain' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (instance.type === TYPE.INVIDIOUS) {
      const type = response.headers.get('content-type') || '';
      if (!type.includes('json')) throw new Error('Not JSON');
      await response.json();
    } else {
      await response.text();
    }
    const ms = performance.now() - started;
    recordHealth(instance, true, ms);
    return { ok: true, ms: Math.round(ms) };
  } catch {
    const ms = performance.now() - started;
    recordHealth(instance, false, ms);
    return { ok: false, ms: Math.round(ms) };
  } finally {
    wrapped.cleanup();
  }
}

export async function probeAll({ onResult } = {}) {
  const list = state.instances.filter((i) => i.enabled !== false);
  const results = await Promise.all(
    list.map(async (instance) => {
      const result = await probe(instance);
      onResult?.(instance, result);
      return { instance, ...result };
    }),
  );
  return results.sort((a, b) => Number(b.ok) - Number(a.ok) || a.ms - b.ms);
}

/* --------------------------------------------------------------------------
   Normalizers
   -------------------------------------------------------------------------- */

function asNumber(value, fallback = 0) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function stripHtml(value = '') {
  return String(value)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function pickThumb(thumbs = [], max = 720) {
  if (!Array.isArray(thumbs) || !thumbs.length) return '';
  const usable = thumbs
    .filter((t) => t && typeof t.url === 'string')
    .map((t) => ({ url: t.url, width: asNumber(t.width, 0) }))
    .sort((a, b) => a.width - b.width);
  return (usable.find((t) => t.width >= max) || usable[usable.length - 1])?.url || '';
}

function invidiousVideo(video) {
  const thumbs = video.videoThumbnails || [];
  return {
    id: video.videoId,
    title: video.title || 'Untitled',
    author: video.author || '',
    authorId: video.authorId || '',
    authorThumb: pickThumb(video.authorThumbnails || [], 100),
    thumb: pickThumb(thumbs, 480) || `https://i.ytimg.com/vi/${video.videoId}/hqdefault.jpg`,
    description: stripHtml(video.description || video.descriptionHtml || ''),
    views: asNumber(video.viewCount),
    viewsText: video.viewCountText || '',
    published: video.published || 0,
    publishedText: video.publishedText || '',
    duration: asNumber(video.lengthSeconds),
    live: Boolean(video.liveNow),
    upcoming: Boolean(video.isUpcoming),
    premium: Boolean(video.premium),
    provider: TYPE.INVIDIOUS,
  };
}

function pipedVideo(video) {
  let id = video.videoId || '';
  if (!id && typeof video.url === 'string') {
    const match = video.url.match(/[?&]v=([\w-]{11})/);
    id = match?.[1] || '';
  }
  return {
    id,
    title: video.title || 'Untitled',
    author: video.uploaderName || video.uploader || '',
    authorId: (video.uploaderUrl || '').replace(/^\/channel\//, ''),
    authorThumb: video.uploaderAvatar || '',
    thumb: video.thumbnail || (id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : ''),
    description: stripHtml(video.shortDescription || video.description || ''),
    views: asNumber(video.views),
    viewsText: '',
    published: asNumber(video.uploaded),
    publishedText: video.uploadedDate || '',
    duration: asNumber(video.duration),
    live: Boolean(video.isLive || video.livestream) || asNumber(video.duration, 0) < 0,
    upcoming: Boolean(video.isUpcoming),
    premium: false,
    provider: TYPE.PIPED,
  };
}

function normalizeVideo(video, provider) {
  return provider === TYPE.PIPED ? pipedVideo(video) : invidiousVideo(video);
}

function videoFromItem(item, provider) {
  if (provider === TYPE.PIPED) {
    if (item.type && item.type !== 'stream' && item.type !== 'video') return null;
    return pipedVideo(item);
  }
  return item.type && item.type !== 'video' ? null : invidiousVideo(item);
}

function safeSlug(value, fallback = 'recorded') {
  return (value || fallback)
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}\s._-]+/gu, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80) || fallback;
}

function filename(title, label, ext) {
  const suffix = label ? `-${label}` : '';
  return `${safeSlug(title)}${suffix}.${ext}`;
}

function invidiousDownloads(details, instance) {
  const videoId = details.videoId;
  const base = instance.url.replace(/\/+$/, '');
  const makeUrl = (itag, title) => {
    const params = new URLSearchParams({ id: videoId, itag: String(itag), local: 'true' });
    if (title) params.set('title', title);
    return `${base}/latest_version?${params.toString()}`;
  };

  const muxed = (details.formatStreams || [])
    .filter((f) => f && f.url && /^video\//.test(f.type || ''))
    .map((f) => ({
      itag: f.itag,
      label: f.qualityLabel || f.quality || 'Video + audio',
      sub: `${f.container || 'mp4'} · ${f.encoding || 'h264'} · with audio`,
      size: asNumber(f.clen, 0),
      ext: f.container || 'mp4',
      url: makeUrl(f.itag, filename(details.title, f.qualityLabel || '', f.container || 'mp4')),
      downloadUrl: makeUrl(f.itag, filename(details.title, f.qualityLabel || '', f.container || 'mp4')),
    }));

  const adaptive = details.adaptiveFormats || [];
  const videoOnly = adaptive
    .filter((f) => f && f.url && /^video\/mp4/.test(f.type || ''))
    .map((f) => {
      const height = asNumber(f.height, 0) || asNumber((f.resolution || '').replace(/p$/, ''), 0);
      const label = f.qualityLabel || (height ? `${height}p` : 'Video');
      const ext = f.container || 'mp4';
      return {
        itag: f.itag,
        height,
        label,
        sub: `${ext} · ${f.encoding || 'h264'}${f.fps ? ` · ${f.fps}fps` : ''} · no audio`,
        size: asNumber(f.clen, 0),
        ext,
        url: makeUrl(f.itag, filename(details.title, label, ext)),
        downloadUrl: makeUrl(f.itag, filename(details.title, label, ext)),
      };
    })
    .sort((a, b) => b.height - a.height);

  const audio = adaptive
    .filter((f) => f && f.url && /^audio\//.test(f.type || ''))
    .map((f) => {
      const kbps = Math.round(asNumber(f.bitrate) / 1000);
      const isM4a = /m4a|mp4/.test(f.container || f.type || '');
      const label = `Audio · ${kbps || '?'} kbps`;
      const ext = isM4a ? 'm4a' : (f.container || 'webm');
      return {
        itag: f.itag,
        label,
        sub: `${ext} · ${f.encoding || (isM4a ? 'aac' : 'opus')}`,
        size: asNumber(f.clen, 0),
        ext,
        url: makeUrl(f.itag, filename(details.title, 'audio', ext)),
        downloadUrl: makeUrl(f.itag, filename(details.title, 'audio', ext)),
      };
    })
    .sort((a, b) => b.size - a.size);

  return { muxed, videoOnly, audio };
}

function pipedDownloads(streams) {
  const videoStreams = streams.videoStreams || [];
  const audioStreams = streams.audioStreams || [];

  const muxed = videoStreams
    .filter((s) => !s.videoOnly && s.url && !/HLS|LBRY/i.test(s.quality || '') && !/mpegurl/i.test(s.mimeType || ''))
    .map((s) => ({
      itag: s.itag,
      label: s.quality || s.format || 'Video',
      sub: `${s.format || 'mp4'} · with audio`,
      size: asNumber(s.contentLength, 0),
      ext: /webm/i.test(s.mimeType || s.format || '') ? 'webm' : 'mp4',
      url: s.url,
      downloadUrl: s.url,
    }));

  const videoOnly = videoStreams
    .filter((s) => s.videoOnly && s.url && !/HLS|LBRY/i.test(s.quality || ''))
    .map((s) => ({
      itag: s.itag,
      label: s.quality || 'Video',
      sub: `${s.format || 'mp4'} · no audio`,
      size: asNumber(s.contentLength, 0),
      ext: /webm/i.test(s.mimeType || s.format || '') ? 'webm' : 'mp4',
      url: s.url,
      downloadUrl: s.url,
    }));

  const audio = audioStreams
    .filter((s) => s.url)
    .map((s) => ({
      itag: s.itag,
      label: s.quality || `Audio · ${Math.round(asNumber(s.bitrate) / 1000)} kbps`,
      sub: `${s.format || 'm4a'} · audio`,
      size: asNumber(s.contentLength, 0),
      ext: /webm|opus/i.test(`${s.format} ${s.mimeType} ${s.codec}`) ? 'webm' : 'm4a',
      url: s.url,
      downloadUrl: s.url,
    }));

  return { muxed, videoOnly, audio };
}

/* --------------------------------------------------------------------------
   Public calls
   -------------------------------------------------------------------------- */

export async function trending({ region = 'US', type = 'Default', signal } = {}) {
  const tag = `${region}:${type}`;
  const path = `/api/v1/trending?region=${encodeURIComponent(region)}&type=${encodeURIComponent(type)}`;
  try {
    const data = await request(path, { prefer: TYPE.INVIDIOUS, signal, ttl: 1000 * 60 * 3 });
    return (Array.isArray(data) ? data : []).map((item) => videoFromItem(item, TYPE.INVIDIOUS)).filter(Boolean);
  } catch (error) {
    if (error.code === 'aborted') throw error;
    const data = await request(`/trending?region=${encodeURIComponent(region)}`, {
      types: [TYPE.PIPED],
      prefer: TYPE.PIPED,
      signal,
      ttl: 1000 * 60 * 3,
    });
    return (Array.isArray(data) ? data : []).map((item) => videoFromItem(item, TYPE.PIPED)).filter(Boolean);
  }
}

export async function search({ query, page = 1, sort = 'relevance', signal } = {}) {
  const q = String(query || '').trim();
  if (!q) return { items: [], page: 1, provider: null };

  for (const provider of [TYPE.INVIDIOUS, TYPE.PIPED]) {
    try {
      if (provider === TYPE.INVIDIOUS) {
        const sortMap = {
          relevance: 'relevance',
          date: 'upload_date',
          views: 'view_count',
          rating: 'rating',
        };
        const path = `/api/v1/search?q=${encodeURIComponent(q)}&page=${page}&sort_by=${sortMap[sort] || 'relevance'}&type=video`;
        const data = await request(path, { types: [TYPE.INVIDIOUS], prefer: TYPE.INVIDIOUS, signal, ttl: 1000 * 60 * 3 });
        return {
          items: (Array.isArray(data) ? data : []).map((item) => videoFromItem(item, TYPE.INVIDIOUS)).filter(Boolean),
          page,
          provider: TYPE.INVIDIOUS,
        };
      }

      const data = await request(`/search?q=${encodeURIComponent(q)}&filter=videos`, {
        types: [TYPE.PIPED],
        prefer: TYPE.PIPED,
        signal,
        ttl: 1000 * 60 * 3,
      });
      return {
        items: (data.items || []).map((item) => videoFromItem(item, TYPE.PIPED)).filter(Boolean),
        page: 1,
        provider: TYPE.PIPED,
        nextpage: data.nextpage || null,
      };
    } catch (error) {
      if (error.code === 'aborted') throw error;
      if (provider === TYPE.INVIDIOUS) continue;
      throw error;
    }
  }

  return { items: [], page, provider: null };
}

export async function suggestions(query, { signal } = {}) {
  const q = String(query || '').trim();
  if (!q) return [];
  try {
    const data = await request(`/api/v1/search/suggestions?q=${encodeURIComponent(q)}`, {
      types: [TYPE.INVIDIOUS],
      prefer: TYPE.INVIDIOUS,
      timeout: 5000,
      signal,
      ttl: 1000 * 60,
    });
    if (Array.isArray(data)) return data.slice(0, 8);
    if (Array.isArray(data.suggestions)) return data.suggestions.slice(0, 8);
  } catch {
    /* Piped fallback below */
  }
  try {
    const data = await request(`/suggestions?query=${encodeURIComponent(q)}`, {
      types: [TYPE.PIPED],
      prefer: TYPE.PIPED,
      timeout: 5000,
      signal,
      ttl: 1000 * 60,
    });
    return Array.isArray(data) ? data.slice(0, 8) : [];
  } catch {
    return [];
  }
}

export async function video(videoId, { signal } = {}) {
  const id = String(videoId || '').trim();
  if (!/^[\w-]{11}$/.test(id)) {
    throw new ApiError('That video id looks wrong.', { code: 'bad-id' });
  }

  let lastError = null;
  for (const provider of [TYPE.INVIDIOUS, TYPE.PIPED]) {
    try {
      if (provider === TYPE.INVIDIOUS) {
        const data = await request(`/api/v1/videos/${encodeURIComponent(id)}?local=true`, {
          types: [TYPE.INVIDIOUS],
          prefer: TYPE.INVIDIOUS,
          signal,
          ttl: 1000 * 60 * 8,
        });
        const active = state.active;
        const view = normalizeVideo(data, TYPE.INVIDIOUS);
        const downloads = invidiousDownloads(data, active);
        const audioFormat = [...(data.adaptiveFormats || [])]
          .filter((f) => /^audio\/mp4/.test(f.type || ''))
          .sort((a, b) => asNumber(b.bitrate) - asNumber(a.bitrate))[0];

        return {
          ...view,
          description: stripHtml(data.description || ''),
          likes: asNumber(data.likeCount),
          dislikes: asNumber(data.dislikeCount),
          subCountText: data.subCountText || '',
          genre: data.genre || '',
          keywords: Array.isArray(data.keywords) ? data.keywords.slice(0, 12) : [],
          captions: (data.captions || []).map((c) => ({
            label: c.label || c.language_code,
            lang: c.language_code,
            url: c.url?.startsWith('http') ? c.url : `${active.url}${c.url || ''}`,
          })),
          thumbnail: pickThumb(data.videoThumbnails || [], 1280) || view.thumb,
          related: (data.recommendedVideos || [])
            .map((item) => videoFromItem(item, TYPE.INVIDIOUS))
            .filter(Boolean)
            .slice(0, 12),
          streams: {
            provider: TYPE.INVIDIOUS,
            instanceUrl: active.url,
            dashUrl: `${active.url}/api/manifest/dash/id/${encodeURIComponent(id)}?local=true`,
            hlsUrl: data.hlsUrl || '',
            audioUrl: audioFormat
              ? `${active.url}/latest_version?id=${encodeURIComponent(id)}&itag=${audioFormat.itag}&local=true`
              : '',
            audioStreams: downloads.audio,
            muxed: downloads.muxed,
            videoOnly: downloads.videoOnly,
          },
          downloads,
          rawProvider: TYPE.INVIDIOUS,
        };
      }

      const data = await request(`/streams/${encodeURIComponent(id)}`, {
        types: [TYPE.PIPED],
        prefer: TYPE.PIPED,
        signal,
        ttl: 1000 * 60 * 8,
      });
      if (data.error) {
        throw new ApiError(data.error, { code: 'stream-error', instance: state.active });
      }
      const active = state.active;
      const view = normalizeVideo(data, TYPE.PIPED);
      const downloads = pipedDownloads(data);
      const muxed = data.videoStreams?.find(
        (s) => !s.videoOnly && s.url && !/HLS|LBRY/i.test(s.quality || '') && !/mpegurl/i.test(s.mimeType || ''),
      );
      const audio = data.audioStreams?.find((s) => s.url);

      return {
        ...view,
        id,
        title: data.title || view.title,
        author: data.uploader || view.author,
        authorId: (data.uploaderUrl || '').replace(/^\/channel\//, ''),
        authorThumb: data.uploaderAvatar || view.authorThumb,
        thumbnail: data.thumbnailUrl || view.thumb,
        thumb: data.thumbnailUrl || view.thumb,
        description: stripHtml(data.description || ''),
        likes: asNumber(data.likes),
        dislikes: asNumber(data.dislikes),
        subCountText: '',
        genre: data.category || '',
        keywords: [],
        captions: [],
        related: (data.relatedStreams || [])
          .map((item) => videoFromItem(item, TYPE.PIPED))
          .filter(Boolean)
          .slice(0, 12),
        streams: {
          provider: TYPE.PIPED,
          instanceUrl: active.url,
          dashUrl: '',
          hlsUrl: data.hls || '',
          audioUrl: audio?.url || '',
          audioStreams: downloads.audio,
          muxed: downloads.muxed,
          videoOnly: downloads.videoOnly,
          playbackUrl: muxed?.url || '',
        },
        downloads,
        rawProvider: TYPE.PIPED,
      };
    } catch (error) {
      if (error.code === 'aborted') throw error;
      lastError = error;
    }
  }

  throw lastError || new ApiError('No instance could load that video.', { code: 'all-failed' });
}

export function formatCount(value) {
  const n = asNumber(value, 0);
  if (n <= 0) return '';
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

export function formatBytes(bytes) {
  const n = asNumber(bytes, 0);
  if (!n || n < 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let value = n;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

export function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(asNumber(seconds, 0)));
  if (!total) return '';
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

export function parseVideoInput(value) {
  const input = String(value || '').trim();
  if (!input) return null;
  if (/^[\w-]{11}$/.test(input)) return input;

  try {
    const url = new URL(input.startsWith('http') ? input : `https://${input}`);
    const host = url.hostname.replace(/^www\./, '');
    if (host === 'youtu.be') {
      const id = url.pathname.split('/').filter(Boolean)[0];
      return /^[\w-]{11}$/.test(id) ? id : null;
    }
    if (host.endsWith('youtube.com') || host.endsWith('youtube-nocookie.com')) {
      const v = url.searchParams.get('v');
      if (v && /^[\w-]{11}$/.test(v)) return v;
      const match = url.pathname.match(/\/(?:embed|shorts|live|v)\/([\w-]{11})/);
      return match?.[1] || null;
    }
    if (host.includes('invidious') || host.includes('piped')) {
      const v = url.searchParams.get('v');
      if (v && /^[\w-]{11}$/.test(v)) return v;
      const match = url.pathname.match(/\/watch\/([\w-]{11})/);
      return match?.[1] || null;
    }
  } catch {
    return null;
  }
  return null;
}

export { TYPE as INSTANCE_TYPES };
