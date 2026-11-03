import {
  DEFAULT_INSTANCES,
  TYPE,
  configure,
  getActive,
  setSelected,
  findInstance,
  makeInstance,
  probeAll,
  probe,
  healthFor,
  clearCache,
  trending,
  search,
  suggestions,
  video as fetchVideo,
  formatCount,
  formatBytes,
  formatDuration,
  parseVideoInput,
} from './api.js';
import { createPlayer, formatTime } from './player.js';

const PREF_KEY = 'recorded:prefs:v2';
const RESUME_PREFIX = 'recorded:resume:';
const APP_VERSION = '1.0.0';

const DEFAULT_PREFS = Object.freeze({
  theme: 'dark',
  accent: '#5b9dff',
  radius: 6,
  density: 1,
  bg: '',
  surface: '',
  text: '',
  muted: '',
  region: 'US',
  category: 'Default',
  instance: 'auto',
  proxy: '',
  autoplay: true,
  resume: true,
  hideShorts: false,
  quality: 'auto',
  searchSort: 'relevance',
  customInstances: [],
});

const REGIONS = [
  ['US', 'United States'],
  ['IR', 'Iran'],
  ['GB', 'United Kingdom'],
  ['CA', 'Canada'],
  ['AU', 'Australia'],
  ['DE', 'Germany'],
  ['FR', 'France'],
  ['NL', 'Netherlands'],
  ['SE', 'Sweden'],
  ['IN', 'India'],
  ['JP', 'Japan'],
  ['KR', 'South Korea'],
  ['BR', 'Brazil'],
  ['MX', 'Mexico'],
  ['TR', 'Türkiye'],
  ['AE', 'United Arab Emirates'],
  ['WORLD', 'Worldwide'],
];

const CATEGORIES = [
  ['Default', 'Trending'],
  ['Music', 'Music'],
  ['Gaming', 'Gaming'],
  ['Movies', 'Movies'],
];

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (m) => ESCAPES[m]);

const els = {
  app: document.getElementById('app'),
  searchForm: document.getElementById('search-form'),
  searchInput: document.getElementById('search-input'),
  searchClear: document.getElementById('search-clear'),
  suggestions: document.getElementById('suggestions'),
  instanceButton: document.getElementById('instance-button'),
  instanceDot: document.getElementById('instance-dot'),
  instanceName: document.getElementById('instance-name'),
  instanceDialog: document.getElementById('instance-dialog'),
  instanceList: document.getElementById('instance-list'),
  instanceRetest: document.getElementById('instance-retest'),
  downloadDialog: document.getElementById('download-dialog'),
  downloadList: document.getElementById('download-list'),
  downloadSub: document.getElementById('download-dialog-sub'),
  downloadNote: document.getElementById('download-note'),
  shortcutsDialog: document.getElementById('shortcuts-dialog'),
  toasts: document.getElementById('toasts'),
  metaTheme: document.querySelector('meta[name="theme-color"]'),
};

let prefs = loadPrefs();
let proxy = buildProxy(prefs.proxy);
let activePlayer = null;
let currentDetails = null;
let currentRoute = null;
let renderToken = 0;
let viewAbort = null;
let suggestionsController = null;
let suggestionsTimer = null;
let suggestionItems = [];
let suggestionIndex = -1;
let resettingSuggestions = false;
let resumeTimer = 0;

/* --------------------------------------------------------------------------
   Preferences and theme
   -------------------------------------------------------------------------- */

function loadPrefs() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(PREF_KEY) || '{}') || {};
  } catch {
    saved = {};
  }

  const merged = { ...DEFAULT_PREFS, ...saved };
  merged.theme = ['dark', 'light', 'system'].includes(merged.theme) ? merged.theme : 'dark';
  merged.accent = /^#[0-9a-f]{6}$/i.test(merged.accent) ? merged.accent : DEFAULT_PREFS.accent;
  merged.radius = Math.min(28, Math.max(0, Number(merged.radius) || 0));
  merged.density = Math.min(1.5, Math.max(0.75, Number(merged.density) || 1));
  merged.region = REGIONS.some(([code]) => code === merged.region) ? merged.region : 'US';
  merged.category = CATEGORIES.some(([key]) => key === merged.category) ? merged.category : 'Default';
  merged.instance = typeof merged.instance === 'string' ? merged.instance : 'auto';
  merged.proxy = typeof merged.proxy === 'string' ? merged.proxy.trim() : '';
  merged.autoplay = Boolean(merged.autoplay);
  merged.resume = Boolean(merged.resume);
  merged.hideShorts = Boolean(merged.hideShorts);
  merged.quality = typeof merged.quality === 'string' ? merged.quality : 'auto';
  merged.searchSort = ['relevance', 'date', 'views', 'rating'].includes(merged.searchSort)
    ? merged.searchSort
    : 'relevance';
  for (const key of ['bg', 'surface', 'text', 'muted']) {
    merged[key] = /^#[0-9a-f]{6}$/i.test(merged[key] || '') ? merged[key] : '';
  }

  merged.customInstances = Array.isArray(saved.customInstances)
    ? saved.customInstances
        .filter((item) => item && typeof item.url === 'string' && /^https?:\/\//i.test(item.url))
        .slice(0, 20)
        .map((item) => ({
          id: String(item.id || ''),
          name: String(item.name || 'custom'),
          url: String(item.url).replace(/\/+$/, ''),
          type: item.type === TYPE.PIPED ? TYPE.PIPED : TYPE.INVIDIOUS,
          custom: true,
          note: 'custom instance',
        }))
    : [];

  return merged;
}

function savePrefs() {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify(prefs));
  } catch {
    /* private mode / quota — the app still works without persistence */
  }
}

function buildProxy(raw) {
  const value = String(raw || '').trim();
  if (!value) return (url) => url;
  return (url) => {
    if (!/^https?:\/\//i.test(url)) return url;
    if (url.startsWith(value)) return url;
    if (value.includes('{url}')) return value.replaceAll('{url}', encodeURIComponent(url));
    if (/[?&]url=$/.test(value)) return `${value}${encodeURIComponent(url)}`;
    const separator = value.includes('?') ? '&' : '?';
    return `${value}${separator}url=${encodeURIComponent(url)}`;
  };
}

function refreshProxy() {
  proxy = buildProxy(prefs.proxy);
}

function applyTheme() {
  const root = document.documentElement;
  const systemLight = matchMedia('(prefers-color-scheme: light)').matches;
  const light = prefs.theme === 'light' || (prefs.theme === 'system' && systemLight);
  root.dataset.theme = light ? 'light' : 'dark';
  root.style.colorScheme = light ? 'light' : 'dark';

  root.style.setProperty('--rc-accent', prefs.accent);
  root.style.setProperty('--rc-radius', `${prefs.radius}px`);
  root.style.setProperty('--rc-radius-lg', `${Math.round(prefs.radius * 1.5)}px`);
  root.style.setProperty('--rc-radius-sm', `${Math.round(prefs.radius * 0.65)}px`);
  root.style.setProperty('--rc-gap', `${Math.round(16 * prefs.density)}px`);

  const optional = {
    '--rc-bg': prefs.bg,
    '--rc-bg-soft': prefs.bg,
    '--rc-surface': prefs.surface,
    '--rc-surface-2': prefs.surface,
    '--rc-text': prefs.text,
    '--rc-text-2': prefs.text,
    '--rc-muted': prefs.muted,
  };
  for (const [name, value] of Object.entries(optional)) {
    if (value) root.style.setProperty(name, value);
    else root.style.removeProperty(name);
  }

  if (els.metaTheme) {
    els.metaTheme.content = prefs.bg || (light ? '#ffffff' : '#0d0d0d');
  }
}

function resetTheme() {
  prefs.accent = DEFAULT_PREFS.accent;
  prefs.radius = DEFAULT_PREFS.radius;
  prefs.density = DEFAULT_PREFS.density;
  prefs.bg = '';
  prefs.surface = '';
  prefs.text = '';
  prefs.muted = '';
  savePrefs();
  applyTheme();
}

/* --------------------------------------------------------------------------
   Instances
   -------------------------------------------------------------------------- */

function allInstances() {
  const defaults = DEFAULT_INSTANCES.map((item) => ({ ...item }));
  const custom = prefs.customInstances.map((item) => ({ ...item, custom: true }));
  const seen = new Set();
  return [...defaults, ...custom].filter((item) => {
    if (!item.url || seen.has(item.url)) return false;
    seen.add(item.url);
    return true;
  });
}

function applyConfig() {
  refreshProxy();
  configure({
    instances: allInstances(),
    selected: prefs.instance,
    proxy: (url) => proxy(url),
    onActive: (instance) => {
      updateInstancePill(instance, 'ok');
      addPreconnect(instance.url);
    },
  });
}

function updateInstancePill(instance, stateName = 'ok') {
  if (!els.instanceName || !els.instanceDot) return;
  els.instanceName.textContent = instance?.name || 'auto';
  els.instanceDot.dataset.state = stateName;
  els.instanceButton.title = instance
    ? `${instance.name} — ${instance.type}${instance.url ? ` — ${instance.url}` : ''}`
    : 'Choose instance';
}

function updatePillFromHealth() {
  const instance = currentActive();
  if (!instance) {
    updateInstancePill(null, 'busy');
    return;
  }
  const entry = healthFor(instance);
  updateInstancePill(instance, entry?.ok === false ? 'bad' : entry?.ok ? 'ok' : 'busy');
}

function currentActive() {
  return getActive();
}

updatePillFromHealth();

function addPreconnect(url) {
  try {
    const origin = new URL(url).origin;
    if (document.querySelector(`link[data-rc-preconnect="${origin}"]`)) return;
    const link = document.createElement('link');
    link.rel = 'preconnect';
    link.href = origin;
    link.dataset.rcPreconnect = origin;
    document.head.append(link);
  } catch {
    /* ignore malformed URLs */
  }
}

function setSelectedInstance(id) {
  prefs.instance = id;
  savePrefs();
  setSelected(id);
  applyConfig();
  const instance = id === 'auto' ? currentActive() : findInstance(id);
  updateInstancePill(instance, id === 'auto' ? 'busy' : 'ok');
}

function instanceStatus(instance) {
  const entry = healthFor(instance);
  if (!entry) return { label: 'untested', state: 'busy' };
  if (entry.ok) return { label: `${entry.ms} ms`, state: 'ok' };
  return { label: 'unreachable', state: 'bad' };
}

function instanceRow(instance, { selected = false, remove = false, auto = false } = {}) {
  const status = auto
    ? { label: currentActive()?.name ? `via ${currentActive().name}` : 'not connected', state: currentActive() ? 'ok' : 'busy' }
    : instanceStatus(instance);
  const name = auto ? 'Auto' : esc(instance.name);
  const url = auto ? 'Fastest healthy instance, with fallback.' : esc(instance.url);
  const type = auto ? 'auto' : instance.type;
  const typeClass = type === TYPE.PIPED ? 'rc-pill--piped' : type === TYPE.INVIDIOUS ? 'rc-pill--inv' : '';
  const use = selected
    ? '<span class="rc-muted rc-small">using</span>'
    : `<button class="rc-btn rc-btn--ghost rc-dl__btn" type="button" data-use-instance="${esc(auto ? 'auto' : instance.id)}">Use</button>`;
  return `
    <div class="rc-instance-row" data-selected="${selected}" data-instance-id="${esc(auto ? 'auto' : instance.id)}">
      <span class="rc-instance__dot" data-state="${status.state}" aria-hidden="true"></span>
      <div style="min-width:0">
        <div class="rc-instance-row__name">${name}</div>
        <div class="rc-instance-row__sub">${url}</div>
      </div>
      <div class="rc-row" style="gap:6px">
        <span class="rc-pill ${typeClass}">${esc(type)}</span>
        <span class="rc-instance-row__time">${esc(status.label)}</span>
        ${remove ? `<button class="rc-btn rc-btn--quiet rc-dl__btn" type="button" data-remove-instance="${esc(instance.id)}" aria-label="Remove ${esc(instance.name)}">Remove</button>` : ''}
      </div>
      ${use}
    </div>
  `;
}

function renderInstanceList() {
  if (!els.instanceList) return;
  const selected = prefs.instance;
  const rows = [instanceRow(null, { auto: true, selected: selected === 'auto' })];
  for (const instance of allInstances()) {
    rows.push(instanceRow(instance, { selected: selected === instance.id }));
  }
  els.instanceList.innerHTML = rows.join('');
}

function openInstanceDialog() {
  renderInstanceList();
  if (!els.instanceDialog.open) els.instanceDialog.showModal();
}

function chooseInstance(id) {
  setSelectedInstance(id);
  renderInstanceList();
  renderRoute({ scroll: false });
  const chosen = id === 'auto' ? 'Auto' : findInstance(id)?.name || id;
  toast(`Using ${chosen}.`);
}

function removeInstance(id) {
  prefs.customInstances = prefs.customInstances.filter((item) => item.id !== id);
  if (prefs.instance === id) prefs.instance = 'auto';
  savePrefs();
  applyConfig();
  renderInstanceList();
  renderRoute({ scroll: false });
  toast('Removed.');
}

/* --------------------------------------------------------------------------
   Utilities
   -------------------------------------------------------------------------- */

function safeUrl(value) {
  if (!value) return '';
  try {
    const url = new URL(String(value));
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.href;
  } catch {
    /* not a URL */
  }
  return '';
}

function mediaUrl(value) {
  const url = safeUrl(value);
  return url ? proxy(url) : '';
}

function series(...parts) {
  return parts
    .filter((part) => part !== null && part !== undefined && String(part).trim() !== '')
    .map((part) => String(part))
    .join(' · ');
}

function go(hash) {
  if (location.hash === hash) {
    renderRoute({ scroll: false });
  } else {
    location.hash = hash;
  }
}

function toast(message, { kind = 'info', timeout = 4500 } = {}) {
  if (!els.toasts) return;
  while (els.toasts.children.length >= 4) els.toasts.firstElementChild?.remove();
  const node = document.createElement('div');
  node.className = 'rc-toast';
  node.dataset.kind = kind;
  const icon = kind === 'error' ? 'i-x' : kind === 'info' ? 'i-spark' : 'i-check';
  node.innerHTML = `<svg class="rc-icon" aria-hidden="true"><use href="#${icon}"/></svg><span>${esc(message)}</span>`;
  els.toasts.append(node);
  setTimeout(() => {
    node.style.opacity = '0';
    node.style.transform = 'translateY(6px)';
    setTimeout(() => node.remove(), 180);
  }, timeout);
}

async function copyText(text) {
  const value = String(text ?? '');
  try {
    await navigator.clipboard.writeText(value);
    toast('Copied.');
    return true;
  } catch {
    try {
      const area = document.createElement('textarea');
      area.value = value;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.append(area);
      area.select();
      document.execCommand('copy');
      area.remove();
      toast('Copied.');
      return true;
    } catch {
      toast('Could not copy.', { kind: 'error' });
      return false;
    }
  }
}

function openDialog(dialog) {
  if (dialog && !dialog.open) dialog.showModal();
}

function closeDialogs() {
  for (const dialog of document.querySelectorAll('dialog[open]')) {
    try {
      dialog.close();
    } catch {
      /* ignore */
    }
  }
}

function skeletonGrid(count = 10, row = false) {
  const item = row
    ? `<div class="rc-card rc-card--row"><div class="rc-skel rc-skel--thumb"></div><div><div class="rc-skel rc-skel--line"></div><div class="rc-skel rc-skel--line short"></div><div class="rc-skel rc-skel--line tiny"></div></div></div>`
    : `<div><div class="rc-skel rc-skel--thumb"></div><div class="rc-skel rc-skel--line"></div><div class="rc-skel rc-skel--line short"></div><div class="rc-skel rc-skel--line tiny"></div></div>`;
  return `<div class="${row ? 'rc-list' : 'rc-grid'}" aria-hidden="true">${item.repeat(count)}</div>`;
}

function hydrateImages(root) {
  for (const img of root.querySelectorAll('img[data-thumb]')) {
    if (img.complete && img.naturalWidth > 0) {
      img.classList.add('is-loaded');
      continue;
    }
    img.addEventListener('load', () => img.classList.add('is-loaded'), { once: true });
    img.addEventListener('error', () => {
      img.removeAttribute('src');
      img.style.display = 'none';
    }, { once: true });
  }
}

function errorPanel(message, { retry = true } = {}) {
  return `
    <div class="rc-error" role="alert">
      <h3>Could not load this page.</h3>
      <p>${esc(message)}</p>
      <div class="rc-error__actions">
        ${retry ? '<button class="rc-btn" type="button" data-retry><svg class="rc-icon" aria-hidden="true"><use href="#i-refresh"/></svg> Try again</button>' : ''}
        <button class="rc-btn rc-btn--ghost" type="button" data-open-instances>Choose instance</button>
      </div>
    </div>
  `;
}

function videoHref(video) {
  return `#/watch?v=${encodeURIComponent(video.id)}`;
}

function viewsLabel(video) {
  if (video.views > 0) return `${formatCount(video.views)} views`;
  return video.viewsText || '';
}

function videoCard(video, { row = false, related = false } = {}) {
  if (!video || !/^[\w-]{11}$/.test(video.id || '')) return '';
  const thumb = mediaUrl(video.thumb);
  const live = video.live || video.upcoming;
  const duration = live ? '' : formatDuration(video.duration);
  const badge = video.live ? '<span class="rc-card__live">LIVE</span>' : video.upcoming ? '<span class="rc-card__live">SOON</span>' : '';
  const meta = series(esc(video.author), esc(viewsLabel(video)), esc(video.publishedText));
  const classes = ['rc-card'];
  if (row) classes.push('rc-card--row');
  if (related) classes.push('rc-card--related');
  return `
    <article class="${classes.join(' ')}">
      <a class="rc-card__link" href="${videoHref(video)}" aria-label="${esc(video.title)}">
        <div class="rc-card__thumb">
          ${thumb ? `<img data-thumb src="${esc(thumb)}" alt="" loading="lazy" decoding="async">` : ''}
          ${badge}
          ${duration ? `<span class="rc-card__dur">${esc(duration)}</span>` : ''}
        </div>
        <div class="rc-card__body">
          <h3 class="rc-card__title">${esc(video.title)}</h3>
          <div class="rc-card__meta">${meta}</div>
          ${row && video.description ? `<p class="rc-card__desc">${esc(video.description)}</p>` : ''}
        </div>
      </a>
    </article>
  `;
}

function renderVideos(items, root, { row = false } = {}) {
  if (!root) return;
  root.innerHTML = items.map((video) => videoCard(video, { row })).join('');
  hydrateImages(root);
}

function filteredVideos(items) {
  if (!prefs.hideShorts) return items;
  return items.filter((video) => !video.duration || video.duration > 60);
}

function updateSearchInput(value) {
  if (document.activeElement === els.searchInput) return;
  els.searchInput.value = value || '';
  els.searchClear.hidden = !els.searchInput.value;
}

function updateNav(path) {
  for (const link of document.querySelectorAll('.rc-nav__link[data-nav]')) {
    const key = link.dataset.nav;
    const current = (key === 'home' && (path === '/' || path === '')) || (key === 'settings' && path === '/settings');
    if (current) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

/* --------------------------------------------------------------------------
   Router
   -------------------------------------------------------------------------- */

function parseHash() {
  const raw = location.hash.startsWith('#') ? location.hash.slice(1) : location.hash;
  const value = raw || '/';
  const [path, query = ''] = value.split('?');
  return { path: path || '/', params: new URLSearchParams(query), hash: value };
}

function cleanupView() {
  if (activePlayer) {
    activePlayer.destroy();
    activePlayer = null;
  }
  currentDetails = null;
  closeDialogs();
}

async function renderRoute({ scroll = true } = {}) {
  const token = ++renderToken;
  viewAbort?.abort();
  viewAbort = new AbortController();
  cleanupView();

  const route = parseHash();
  currentRoute = route;
  updateNav(route.path);
  updateSearchInput(route.path === '/search' ? route.params.get('q') || '' : '');
  if (scroll) window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });

  if (route.path === '/' || route.path === '') return renderHome(token, route);
  if (route.path === '/search') return renderSearch(token, route);
  if (route.path === '/watch') return renderWatch(token, route);
  if (route.path === '/settings') return renderSettings(token, route);
  if (route.path === '/theme') return renderTheme(token, route);
  return renderNotFound(token);
}

function isStale(token) {
  return token !== renderToken;
}

async function withBusy(fn) {
  updateInstancePill(currentActive(), 'busy');
  try {
    const result = await fn();
    updateInstancePill(currentActive(), 'ok');
    return result;
  } catch (error) {
    updateInstancePill(currentActive(), 'bad');
    throw error;
  }
}

/* --------------------------------------------------------------------------
   Home
   -------------------------------------------------------------------------- */

function regionOptions(value) {
  return REGIONS.map(([code, name]) => `<option value="${code}" ${code === value ? 'selected' : ''}>${esc(name)}</option>`).join('');
}

async function renderHome(token, route) {
  document.title = 'Trending — Recorded';
  const regionName = REGIONS.find(([code]) => code === prefs.region)?.[1] || prefs.region;
  els.app.innerHTML = `
    <section class="rc-page-head">
      <div>
        <h1 class="rc-page-title">Trending</h1>
        <p class="rc-page-sub">${esc(regionName)}</p>
      </div>
      <div class="rc-row">
        <label class="rc-sr-only" for="region-select">Trending region</label>
        <select class="rc-select rc-select--inline" id="region-select">${regionOptions(prefs.region)}</select>
        <button class="rc-btn rc-btn--ghost" type="button" id="trend-refresh">
          <svg class="rc-icon" aria-hidden="true"><use href="#i-refresh"/></svg> Refresh
        </button>
      </div>
    </section>
    <div class="rc-toolbar">
      <div class="rc-tabs" role="group" aria-label="Trending category">
        ${CATEGORIES.map(([key, label]) => `<button class="rc-chip" type="button" data-category="${key}" aria-pressed="${key === prefs.category}">${esc(label)}</button>`).join('')}
      </div>
      <span class="rc-muted rc-small" id="trend-note">Loading</span>
    </div>
    <div id="trend-body">${skeletonGrid(10)}</div>
  `;

  document.getElementById('region-select')?.addEventListener('change', (event) => {
    prefs.region = event.target.value;
    savePrefs();
    renderRoute({ scroll: false });
  });
  document.getElementById('trend-refresh')?.addEventListener('click', () => {
    clearCache();
    renderRoute({ scroll: false });
  });
  for (const chip of document.querySelectorAll('[data-category]')) {
    chip.addEventListener('click', () => {
      prefs.category = chip.dataset.category;
      savePrefs();
      renderRoute({ scroll: false });
    });
  }

  const body = document.getElementById('trend-body');
  const note = document.getElementById('trend-note');
  try {
    const items = await withBusy(() =>
      trending({ region: prefs.region, type: prefs.category, signal: viewAbort.signal }),
    );
    if (isStale(token)) return;
    const visible = filteredVideos(items);
    const active = currentActive();
    if (note) {
      const via = active ? `via ${active.name}` : '';
      const fallback = active?.type === TYPE.PIPED && prefs.category !== 'Default'
        ? 'Piped has no category feed — showing general trending'
        : '';
      note.textContent = series(via, fallback);
    }
    if (!visible.length) {
      body.innerHTML = `
        <div class="rc-empty">
          <svg class="rc-icon" aria-hidden="true"><use href="#i-spark"/></svg>
          <h3>No videos returned.</h3>
          <p>Try another region or another instance.</p>
          <button class="rc-btn" type="button" data-open-instances>Choose instance</button>
        </div>`;
      return;
    }
    body.innerHTML = `<div class="rc-grid"></div>`;
    renderVideos(visible, body.firstElementChild);
  } catch (error) {
    if (error.code === 'aborted' || isStale(token)) return;
    if (note) note.textContent = '';
    body.innerHTML = errorPanel(error.message);
  }
}

/* --------------------------------------------------------------------------
   Search
   -------------------------------------------------------------------------- */

async function renderSearch(token, route) {
  const query = (route.params.get('q') || '').trim();
  const page = Math.max(1, Number(route.params.get('page')) || 1);
  const sort = route.params.get('sort') || prefs.searchSort;
  if (!query) {
    go('#/');
    return;
  }
  document.title = `${query} — Recorded`;
  const sortOptions = [
    ['relevance', 'Relevance'],
    ['date', 'Upload date'],
    ['views', 'Views'],
    ['rating', 'Rating'],
  ];

  els.app.innerHTML = `
    <section class="rc-page-head">
      <div>
        <h1 class="rc-page-title">${esc(query)}</h1>
        <p class="rc-page-sub" id="search-sub">Searching</p>
      </div>
      <div class="rc-row">
        <label class="rc-sr-only" for="sort-select">Sort results</label>
        <select class="rc-select rc-select--inline" id="sort-select">
          ${sortOptions.map(([key, label]) => `<option value="${key}" ${key === sort ? 'selected' : ''}>${esc(label)}</option>`).join('')}
        </select>
      </div>
    </section>
    <div id="search-body">${skeletonGrid(6, true)}</div>
    <div class="rc-row" id="search-pager" style="justify-content:center;margin-top:20px"></div>
  `;

  document.getElementById('sort-select')?.addEventListener('change', (event) => {
    prefs.searchSort = event.target.value;
    savePrefs();
    go(`#/search?q=${encodeURIComponent(query)}&sort=${encodeURIComponent(event.target.value)}&page=1`);
  });

  const body = document.getElementById('search-body');
  const sub = document.getElementById('search-sub');
  const pager = document.getElementById('search-pager');
  try {
    const result = await withBusy(() =>
      search({ query, page, sort, signal: viewAbort.signal }),
    );
    if (isStale(token)) return;
    const active = currentActive();
    const items = filteredVideos(result.items || []);
    sub.textContent = series(
      `${items.length} ${items.length === 1 ? 'result' : 'results'}`,
      active ? `via ${active.name}` : '',
      result.provider === TYPE.PIPED && page === 1 ? 'Piped supports one page of results' : '',
    );
    if (!items.length) {
      body.innerHTML = `
        <div class="rc-empty">
          <svg class="rc-icon" aria-hidden="true"><use href="#i-search"/></svg>
          <h3>No results.</h3>
          <p>Try a shorter query, or paste a YouTube link into the search bar.</p>
        </div>`;
      return;
    }
    body.innerHTML = `<div class="rc-list"></div>`;
    renderVideos(items, body.firstElementChild, { row: true });

    if (result.provider === TYPE.INVIDIOUS) {
      pager.innerHTML = `
        ${page > 1 ? `<button class="rc-btn rc-btn--ghost" type="button" data-page="${page - 1}">Previous</button>` : ''}
        ${items.length >= 15 ? `<button class="rc-btn rc-btn--accent" type="button" data-page="${page + 1}">Next page</button>` : ''}
      `;
      for (const button of pager.querySelectorAll('[data-page]')) {
        button.addEventListener('click', () => {
          go(`#/search?q=${encodeURIComponent(query)}&sort=${encodeURIComponent(sort)}&page=${button.dataset.page}`);
        });
      }
    }
  } catch (error) {
    if (error.code === 'aborted' || isStale(token)) return;
    sub.textContent = '';
    body.innerHTML = errorPanel(error.message);
  }
}

/* --------------------------------------------------------------------------
   Watch
   -------------------------------------------------------------------------- */

function formatQualityLabel(height) {
  if (!height) return 'Auto';
  if (height >= 2160) return '4K';
  if (height >= 1440) return '1440p';
  return `${height}p`;
}

function downloadGroups(details) {
  const groups = [];
  if (details.downloads.muxed?.length) groups.push(['Video + audio', details.downloads.muxed]);
  if (details.downloads.videoOnly?.length) groups.push(['Video only · no sound', details.downloads.videoOnly]);
  if (details.downloads.audio?.length) groups.push(['Audio only', details.downloads.audio]);
  return groups;
}

function openDownloads() {
  if (!currentDetails) return;
  const details = currentDetails;
  const groups = downloadGroups(details);
  els.downloadSub.textContent = details.title;
  if (!groups.length) {
    els.downloadList.innerHTML = `
      <div class="rc-empty" style="padding:28px 16px">
        <svg class="rc-icon" aria-hidden="true"><use href="#i-download"/></svg>
        <h3>No formats available.</h3>
        <p>This instance did not return any streams for that video. Try another instance.</p>
        <button class="rc-btn" type="button" data-open-instances>Choose instance</button>
      </div>`;
    els.downloadNote.textContent = 'Live streams and some region-locked videos cannot be downloaded.';
  } else {
    els.downloadList.innerHTML = groups
      .map(([title, items]) => {
        const rows = items
          .map((item) => {
            const url = safeUrl(item.downloadUrl);
            const proxied = url ? proxy(url) : '';
            const size = formatBytes(item.size);
            return `
              <div class="rc-dl">
                <div>
                  <div class="rc-dl__label">${esc(item.label)}</div>
                  <div class="rc-dl__sub">${esc(item.sub || '')}</div>
                </div>
                <div class="rc-dl__size">${esc(size || 'size unknown')}</div>
                ${proxied
                  ? `<a class="rc-btn rc-btn--accent rc-dl__btn" href="${esc(proxied)}" download="${esc(item.label)}" target="_blank" rel="noopener">Save</a>`
                  : '<span class="rc-muted rc-small">unavailable</span>'}
              </div>`;
          })
          .join('');
        return `<section class="rc-dl-group"><h3 class="rc-dl-group__title">${esc(title)}</h3>${rows}</section>`;
      })
      .join('');
    const provider = details.streams.provider === TYPE.PIPED ? 'Piped' : 'Invidious';
    els.downloadNote.textContent = `Served by ${provider} at ${details.streams.instanceUrl.replace(/^https?:\/\//, '')}. If a file opens in a tab, right-click it and choose “Save video as…”.`;
  }
  openDialog(els.downloadDialog);
}

function downloadAria(details) {
  return details.downloads.muxed.length + details.downloads.videoOnly.length + details.downloads.audio.length > 0;
}

async function renderWatch(token, route) {
  const id = (route.params.get('v') || '').trim();
  if (!/^[\w-]{11}$/.test(id)) {
    return renderNotFound(token, 'That video id does not look right.');
  }
  document.title = 'Loading — Recorded';

  els.app.innerHTML = `
    <div class="rc-watch">
      <div class="rc-watch__main" id="watch-main">
        <div class="rc-skel" style="aspect-ratio:16/9;border-radius:var(--rc-radius)"></div>
        <div class="rc-skel rc-skel--line" style="width:70%;height:18px;margin-top:14px"></div>
        <div class="rc-skel rc-skel--line" style="width:45%"></div>
        <div class="rc-skel rc-skel--line" style="width:62%;margin-top:18px"></div>
      </div>
      <aside class="rc-watch__side">
        <div class="rc-side-title">Related</div>
        ${skeletonGrid(4, true)}
      </aside>
    </div>
  `;

  try {
    const details = await withBusy(() => fetchVideo(id, { signal: viewAbort.signal }));
    if (isStale(token)) return;
    currentDetails = details;
    document.title = `${details.title} — Recorded`;
    renderWatchView(token, details);
  } catch (error) {
    if (error.code === 'aborted' || isStale(token)) return;
    els.app.innerHTML = errorPanel(error.message);
  }
}

function renderWatchView(token, details) {
  const live = details.live;
  const upcoming = details.upcoming;
  const canDownload = !live && !upcoming && downloadAria(details);
  const audioAvailable = Boolean(details.streams.audioUrl);
  const meta = series(
    details.views > 0 ? `${formatCount(details.views)} views` : '',
    details.publishedText,
    details.likes > 0 ? `${formatCount(details.likes)} likes` : '',
  );
  const tags = [
    details.live ? '<span class="rc-tag rc-tag--accent">LIVE</span>' : '',
    details.upcoming ? '<span class="rc-tag rc-tag--accent">UPCOMING</span>' : '',
  ].filter(Boolean).join('');

  const related = (details.related || []).filter((item) => item.id !== details.id);
  const hasRelated = related.length > 0;

  els.app.innerHTML = `
    <div class="rc-watch ${hasRelated ? '' : 'rc-watch--solo'}">
      <div class="rc-watch__main">
        <div class="rc-player" id="player-shell" style="position:relative"></div>
        <div class="rc-playerbar">
          <div class="rc-playerbar__group">
            <div class="rc-seg" role="group" aria-label="Playback mode">
              <button class="rc-seg__btn" type="button" data-mode="video" aria-pressed="true">Video</button>
              <button class="rc-seg__btn" type="button" data-mode="audio" aria-pressed="false" ${audioAvailable ? '' : 'disabled title="No audio-only stream available"'}>
                <svg class="rc-icon" style="width:12px;height:12px" aria-hidden="true"><use href="#i-music"/></svg> Audio
              </button>
            </div>
            <details class="rc-menu" id="quality-menu" hidden>
              <summary id="quality-summary">Auto</summary>
              <div class="rc-menu__list" id="quality-list"></div>
            </details>
            <details class="rc-menu" id="speed-menu">
              <summary id="speed-summary">1×</summary>
              <div class="rc-menu__list">
                ${[0.5, 0.75, 1, 1.25, 1.5, 2].map((rate) => `<button class="rc-menu__item" type="button" data-rate="${rate}" aria-checked="${rate === 1}">${rate}×</button>`).join('')}
              </div>
            </details>
          </div>
          <div class="rc-playerbar__group">
            <button class="rc-btn" type="button" data-open-downloads ${canDownload ? '' : 'disabled'}>
              <svg class="rc-icon" aria-hidden="true"><use href="#i-download"/></svg> Download
            </button>
            <button class="rc-iconbtn" type="button" data-copy-link title="Copy link" aria-label="Copy link">
              <svg class="rc-icon" aria-hidden="true"><use href="#i-copy"/></svg>
            </button>
            <a class="rc-iconbtn" href="https://www.youtube.com/watch?v=${encodeURIComponent(details.id)}" target="_blank" rel="noopener" title="Open on YouTube" aria-label="Open on YouTube">
              <svg class="rc-icon" aria-hidden="true"><use href="#i-external"/></svg>
            </a>
          </div>
        </div>

        <div class="rc-error" id="player-problem" role="alert" hidden style="margin-top:10px">
          <h3>Playback failed.</h3>
          <p id="player-problem-text"></p>
          <div class="rc-error__actions">
            <button class="rc-btn" type="button" data-retry>Reload</button>
            <button class="rc-btn rc-btn--ghost" type="button" data-open-instances>Try another instance</button>
          </div>
        </div>

        <header class="rc-videohead">
          <h1 class="rc-videohead__title">${esc(details.title)}</h1>
          <div class="rc-videohead__meta">${meta ? esc(meta) : ''}</div>
          ${tags ? `<div class="rc-videohead__chips">${tags}</div>` : ''}
        </header>

        <div class="rc-author">
          ${details.authorThumb ? `<img data-thumb src="${esc(mediaUrl(details.authorThumb))}" alt="" loading="lazy" decoding="async">` : ''}
          <div>
            <div class="rc-author__name">${esc(details.author || 'Unknown channel')}</div>
            <div class="rc-author__sub">${esc(details.subCountText || '')}</div>
          </div>
          <div class="rc-author__actions">
            <button class="rc-btn rc-btn--ghost" type="button" data-search-author="${esc(details.author)}">Search channel</button>
          </div>
        </div>

        ${details.description ? `
          <div class="rc-desc ${details.description.length > 380 ? 'is-clamped' : ''}" id="video-description">${esc(details.description)}</div>
          ${details.description.length > 380 ? '<button class="rc-btn rc-btn--quiet rc-desc__more" type="button" data-expand-description>Show more</button>' : ''}
        ` : ''}
      </div>

      <aside class="rc-watch__side">
        <div class="rc-side-title">Related <span>${related.length || ''}</span></div>
        ${hasRelated ? `<div class="rc-related" id="related-list">${related.map((item) => videoCard(item, { related: true })).join('')}</div>` : '<p class="rc-muted rc-small">No related videos.</p>'}
      </aside>
    </div>
  `;

  hydrateImages(document);

  const playerShell = document.getElementById('player-shell');
  let chosenQuality = prefs.quality && prefs.quality !== 'auto' ? String(prefs.quality) : 'auto';
  let problemShown = false;
  const showProblem = (message) => {
    if (problemShown) return;
    problemShown = true;
    const box = document.getElementById('player-problem');
    const text = document.getElementById('player-problem-text');
    if (box && text) {
      text.textContent = message;
      box.hidden = false;
    }
  };

  const player = createPlayer({
    container: playerShell,
    details,
    proxy: (url) => proxy(url),
    autoplay: prefs.autoplay,
    onError: ({ message }) => {
      showProblem(message || 'The instance could not play that stream.');
      toast(message || 'Player error', { kind: 'error' });
    },    onNotice: (message) => toast(message, { kind: 'info' }),
    onQualities: (qualities) => {
      const menu = document.getElementById('quality-menu');
      const list = document.getElementById('quality-list');
      const summary = document.getElementById('quality-summary');
      if (!menu || !list || !summary) return;
      if (!qualities.length) {
        menu.hidden = true;
        list.innerHTML = '';
        return;
      }
      menu.hidden = false;
      const options = [{ height: 'auto', label: 'Auto' }, ...qualities.map((q) => ({ height: q.height, label: formatQualityLabel(q.height) }))];
      if (!options.some((option) => String(option.height) === chosenQuality)) chosenQuality = 'auto';
      list.innerHTML = options
        .map((option) => `<button class="rc-menu__item" type="button" data-quality="${option.height}" aria-checked="${String(option.height) === chosenQuality}">${esc(option.label)}<small>${option.height === 'auto' ? 'ABR' : `${option.height}p`}</small></button>`)
        .join('');
      summary.textContent = chosenQuality === 'auto' ? 'Auto' : formatQualityLabel(Number(chosenQuality));
      for (const button of list.querySelectorAll('[data-quality]')) {
        button.addEventListener('click', () => {
          const value = button.dataset.quality;
          chosenQuality = value;
          summary.textContent = value === 'auto' ? 'Auto' : formatQualityLabel(Number(value));
          for (const item of list.querySelectorAll('[data-quality]')) item.setAttribute('aria-checked', String(item === button));
          player.setQuality(value);
          menu.open = false;
        });
      }
      const preferred = prefs.quality;
      if (preferred && preferred !== 'auto') {
        const target = qualities.find((q) => String(q.height) === String(preferred));
        if (target) {
          chosenQuality = String(target.height);
          summary.textContent = formatQualityLabel(target.height);
          for (const item of list.querySelectorAll('[data-quality]')) {
            item.setAttribute('aria-checked', String(item.dataset.quality === chosenQuality));
          }
          player.setQuality(target.height);
        }
      }
    },
    onState: (state) => {
      const audioButton = document.querySelector('[data-mode="audio"]');
      const videoButton = document.querySelector('[data-mode="video"]');
      if (audioButton && videoButton) {
        audioButton.setAttribute('aria-pressed', String(state.mode === 'audio'));
        videoButton.setAttribute('aria-pressed', String(state.mode === 'video'));
      }
      if (state.playing) {
        playerShell?.classList.add('is-playing');
      } else {
        playerShell?.classList.remove('is-playing');
      }
    },
    onTime: ({ currentTime, duration }) => {
      if (!prefs.resume || !Number.isFinite(currentTime)) return;
      const now = Date.now();
      if (now - resumeTimer < 5000) return;
      resumeTimer = now;
      if (currentTime > 8 && duration > 20) {
        try {
          localStorage.setItem(`${RESUME_PREFIX}${details.id}`, JSON.stringify({ t: currentTime, at: now }));
        } catch {
          /* ignore */
        }
      }
    },
  });

  activePlayer = player;

  // Restore a previous position once the media knows its duration.
  if (prefs.resume) {
    const saved = readResume(details.id);
    if (saved) {
      let applied = false;
      const applyResume = () => {
        if (applied) return;
        const media = player.currentMedia();
        if (media && media.duration > 20 && saved.t < media.duration - 12 && saved.t > 8) {
          applied = true;
          player.setCurrentTime(saved.t);
          toast(`Resumed at ${formatTime(saved.t)}`, { kind: 'info', timeout: 3200 });
        }
      };
      player.video.addEventListener('loadedmetadata', () => setTimeout(applyResume, 250));
      player.video.addEventListener('canplay', () => setTimeout(applyResume, 500), { once: true });
      const interval = setInterval(() => {
        applyResume();
        if (applied) clearInterval(interval);
      }, 700);
      setTimeout(() => clearInterval(interval), 12000);
    }
  }

  // Mode switching
  for (const button of document.querySelectorAll('[data-mode]')) {
    button.addEventListener('click', () => {
      const mode = button.dataset.mode;
      const ok = player.setMode(mode);
      if (!ok) {
        toast('No audio-only stream for this video.', { kind: 'info' });
        return;
      }
      if (mode === 'audio' && !details.streams.audioUrl) return;
      for (const other of document.querySelectorAll('[data-mode]')) {
        other.setAttribute('aria-pressed', String(other === button));
      }
    });
  }

  // Speed
  for (const button of document.querySelectorAll('[data-rate]')) {
    button.addEventListener('click', () => {
      const rate = Number(button.dataset.rate) || 1;
      player.setRate(rate);
      const summary = document.getElementById('speed-summary');
      if (summary) summary.textContent = `${rate}×`;
      for (const other of document.querySelectorAll('[data-rate]')) {
        other.setAttribute('aria-checked', String(other === button));
      }
      button.closest('details')?.removeAttribute('open');
    });
  }

  // Description
  document.querySelector('[data-expand-description]')?.addEventListener('click', (event) => {
    const description = document.getElementById('video-description');
    if (!description) return;
    const expanded = description.classList.toggle('is-clamped') === false;
    event.currentTarget.textContent = expanded ? 'Show less' : 'Show more';
  });

  // Copy + downloads + authors are handled by the delegated listener below.
  document.querySelector('[data-back]')?.addEventListener('click', (event) => {
    event.preventDefault();
    if (history.length > 1) history.back();
    else go('#/');
  });

  // Show a useful hint when the whole video is downloads-only.
  if (!details.streams.dashUrl && !details.streams.playbackUrl && details.streams.audioUrl) {
    toast('Only audio is available for this video.', { kind: 'info', timeout: 5000 });
  }
}

function readResume(id) {
  try {
    const saved = JSON.parse(localStorage.getItem(`${RESUME_PREFIX}${id}`) || 'null');
    if (!saved || typeof saved.t !== 'number' || !Number.isFinite(saved.t)) return null;
    if (Date.now() - saved.at > 1000 * 60 * 60 * 24 * 60) return null;
    return saved;
  } catch {
    return null;
  }
}

/* --------------------------------------------------------------------------
   Settings
   -------------------------------------------------------------------------- */

function settingsInstanceList() {
  const rows = [instanceRow(null, { auto: true, selected: prefs.instance === 'auto' })];
  for (const instance of allInstances()) {
    rows.push(instanceRow(instance, {
      selected: prefs.instance === instance.id,
      remove: Boolean(instance.custom),
    }));
  }
  return rows.join('');
}

function themeOptions() {
  return [
    ['dark', 'Dark'],
    ['light', 'Light'],
    ['system', 'System'],
  ].map(([value, label]) => `<option value="${value}" ${prefs.theme === value ? 'selected' : ''}>${label}</option>`).join('');
}

function qualityOptions() {
  return [
    ['auto', 'Auto (ABR)'],
    ['2160', '2160p / 4K'],
    ['1440', '1440p'],
    ['1080', '1080p'],
    ['720', '720p'],
    ['480', '480p'],
    ['360', '360p'],
  ].map(([value, label]) => `<option value="${value}" ${prefs.quality === value ? 'selected' : ''}>${label}</option>`).join('');
}

async function renderSettings(token) {
  document.title = 'Settings — Recorded';
  els.app.innerHTML = `
    <section class="rc-page-head">
      <div>
        <h1 class="rc-page-title">Settings</h1>
      </div>
    </section>
    <div class="rc-settings">
      <nav class="rc-settings__nav" aria-label="Settings sections">
        <button type="button" data-scroll="settings-appearance">Appearance</button>
        <button type="button" data-scroll="settings-playback">Playback</button>
        <button type="button" data-scroll="settings-network">Network</button>
        <button type="button" data-scroll="settings-data">Data</button>
        <button type="button" data-scroll="settings-about">About</button>
      </nav>
      <div class="rc-settings__content">
        <section class="rc-section" id="settings-appearance">
          <h2 class="rc-section__title">Appearance</h2>
          <p class="rc-section__sub">Theme and layout.</p>
          <label class="rc-field">
            <span class="rc-field__label">Theme</span>
            <select class="rc-select" data-pref="theme">${themeOptions()}</select>
          </label>
          <div class="rc-field">
            <span class="rc-field__label">Custom theme</span>
            <div class="rc-field__row">
              <a class="rc-btn" href="#/theme">Open theme studio</a>
              <button class="rc-btn rc-btn--ghost" type="button" data-reset-theme>Reset theme</button>
            </div>
            <span class="rc-field__hint">Colours, spacing and the Stylus snippet live there.</span>
          </div>
        </section>

        <section class="rc-section" id="settings-playback">
          <h2 class="rc-section__title">Playback</h2>
          <p class="rc-section__sub">Defaults for the player.</p>
          <label class="rc-field">
            <span class="rc-field__label">Trending region</span>
            <select class="rc-select" data-pref="region">${regionOptions(prefs.region)}</select>
          </label>
          <label class="rc-field">
            <span class="rc-field__label">Preferred quality</span>
            <select class="rc-select" data-pref="quality">${qualityOptions()}</select>
            <span class="rc-field__hint">Used when the instance provides a quality ladder.</span>
          </label>
          <label class="rc-field">
            <span class="rc-field__label">Autoplay</span>
            <span class="rc-switch"><input type="checkbox" data-pref="autoplay" ${prefs.autoplay ? 'checked' : ''}><span class="rc-switch__track"></span></span>
          </label>
          <label class="rc-field">
            <span class="rc-field__label">Resume where I stopped</span>
            <span class="rc-switch"><input type="checkbox" data-pref="resume" ${prefs.resume ? 'checked' : ''}><span class="rc-switch__track"></span></span>
            <span class="rc-field__hint">Positions are stored in this browser.</span>
          </label>
          <label class="rc-field">
            <span class="rc-field__label">Hide Shorts</span>
            <span class="rc-switch"><input type="checkbox" data-pref="hideShorts" ${prefs.hideShorts ? 'checked' : ''}><span class="rc-switch__track"></span></span>
            <span class="rc-field__hint">Hides videos 60 seconds or shorter.</span>
          </label>
        </section>

        <section class="rc-section" id="settings-network">
          <h2 class="rc-section__title">Network</h2>
          <p class="rc-section__sub">Servers used for requests.</p>
          <div class="rc-field">
            <span class="rc-field__label">Instance</span>
            <div class="rc-instance-list" id="settings-instance-list">${settingsInstanceList()}</div>
            <div class="rc-field__row" style="margin-top:8px">
              <button class="rc-btn" type="button" data-test-instances>Test all</button>
              <button class="rc-btn rc-btn--ghost" type="button" data-open-instances>Open picker</button>
            </div>
          </div>
          <div class="rc-field">
            <span class="rc-field__label">Add a custom instance</span>
            <form id="add-instance-form" class="rc-row" style="align-items:stretch">
              <input class="rc-input" name="url" type="url" placeholder="https://your-invidious.example" aria-label="Custom instance URL" style="flex:1 1 240px">
              <input class="rc-input" name="name" type="text" placeholder="Name (optional)" aria-label="Custom instance nickname" style="flex:0 1 160px">
              <select class="rc-select" name="type" aria-label="Instance type" style="flex:0 1 130px">
                <option value="invidious">Invidious</option>
                <option value="piped">Piped</option>
              </select>
              <button class="rc-btn rc-btn--accent" type="submit">Add</button>
            </form>
            <span class="rc-field__hint">Invidious provides DASH and downloads. Piped provides a 360p fallback.</span>
          </div>
          <div class="rc-field">
            <span class="rc-field__label">Relay</span>
            <div class="rc-field__row">
              <input class="rc-input" id="proxy-input" type="url" value="${esc(prefs.proxy)}" placeholder="https://relay.example/relay.php?url=" aria-label="Relay URL" style="flex:1 1 280px">
              <button class="rc-btn" type="button" id="proxy-save">Save</button>
            </div>
            <span class="rc-field__hint">Optional. Sends API, thumbnail and media requests through your own relay. Leave blank to connect directly. See <a href="./php/README.md" target="_blank" rel="noopener" style="color:var(--rc-accent)">php/README.md</a>.</span>
          </div>
        </section>

        <section class="rc-section" id="settings-data">
          <h2 class="rc-section__title">Data</h2>
          <p class="rc-section__sub">Stored in this browser only.</p>
          <div class="rc-field">
            <span class="rc-field__label">Watch positions</span>
            <div class="rc-field__row">
              <button class="rc-btn rc-btn--ghost" type="button" data-clear-resume>Clear watch positions</button>
            </div>
          </div>
          <div class="rc-field">
            <span class="rc-field__label">Settings</span>
            <div class="rc-field__row">
              <button class="rc-btn rc-btn--ghost" type="button" data-export-settings>Export JSON</button>
              <label class="rc-btn rc-btn--ghost" style="cursor:pointer">Import JSON<input type="file" accept="application/json,.json" data-import-settings hidden></label>
              <button class="rc-btn rc-btn--quiet" type="button" data-reset-settings>Reset everything</button>
            </div>
          </div>
        </section>

        <section class="rc-section" id="settings-about">
          <h2 class="rc-section__title">About</h2>
          <p class="rc-section__sub">Recorded ${APP_VERSION}. A static front end. No accounts, no analytics.</p>
          <div class="rc-field">
            <span class="rc-field__hint" style="line-height:1.7">
              Recorded uses public <a href="https://invidious.io" target="_blank" rel="noopener" style="color:var(--rc-accent)">Invidious</a>
              and <a href="https://piped.video" target="_blank" rel="noopener" style="color:var(--rc-accent)">Piped</a> instances.
              Those instances see your requests. Downloads are served by the instance. Recorded does not host or re-upload video.
            </span>
          </div>
          <div class="rc-field">
            <span class="rc-field__label">Keyboard</span>
            <button class="rc-btn rc-btn--ghost" type="button" data-open-shortcuts>Open shortcut sheet</button>
          </div>
        </section>
      </div>
    </div>
  `;

  wireSettings(token);
}

function wireSettings(token) {
  for (const element of els.app.querySelectorAll('[data-pref]')) {
    const key = element.dataset.pref;
    element.addEventListener(element.type === 'range' || element.type === 'color' ? 'input' : 'change', () => {
      let value;
      if (element.type === 'checkbox') value = element.checked;
      else if (element.type === 'range') value = Number(element.value);
      else value = element.value;

      prefs[key] = value;
      savePrefs();

      if (key === 'theme' || key === 'accent' || key === 'radius' || key === 'density') {
        applyTheme();
        const output = els.app.querySelector(`[data-pref-value="${key}"]`);
        if (output) output.textContent = key === 'radius' ? `${value}px` : key === 'density' ? `${value}×` : '';
        if (key === 'accent') {
          const label = element.parentElement?.querySelector('.rc-mono');
          if (label) label.textContent = value;
        }
      }
      if (key === 'proxy') applyConfig();
      if (key === 'instance') {
        setSelectedInstance(value);
      }
    });
  }

  for (const button of els.app.querySelectorAll('[data-scroll]')) {
    button.addEventListener('click', () => {
      document.getElementById(button.dataset.scroll)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  document.getElementById('add-instance-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try {
      const instance = makeInstance(String(data.get('url') || '').trim(), data.get('type') === TYPE.PIPED ? TYPE.PIPED : TYPE.INVIDIOUS, String(data.get('name') || '').trim());
      if (allInstances().some((item) => item.url === instance.url)) {
        throw new Error('That instance is already in the list.');
      }
      prefs.customInstances.push(instance);
      setSelectedInstance(instance.id);
      probe(instance).then(() => {
        if (currentRoute?.path === '/settings') renderRoute({ scroll: false });
      });
      toast(`Added ${instance.name}.`);
      renderRoute({ scroll: false });
    } catch (error) {
      toast(error.message || 'Could not add that instance.', { kind: 'error' });
    }
  });

  document.getElementById('proxy-save')?.addEventListener('click', () => {
    const value = document.getElementById('proxy-input')?.value.trim() || '';
    if (value && !/^https?:\/\//i.test(value)) {
      toast('The relay needs an http(s) URL.', { kind: 'error' });
      return;
    }
    prefs.proxy = value;
    savePrefs();
    applyConfig();
    clearCache();
    toast(value ? 'Relay saved.' : 'Relay removed.');
    renderRoute({ scroll: false });
  });

  document.querySelector('[data-clear-resume]')?.addEventListener('click', () => {
    const keys = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key?.startsWith(RESUME_PREFIX)) keys.push(key);
    }
    for (const key of keys) localStorage.removeItem(key);
    toast(`Cleared ${keys.length} watch position${keys.length === 1 ? '' : 's'}.`);
  });

  document.querySelector('[data-export-settings]')?.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(prefs, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'recorded-settings.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  document.querySelector('[data-import-settings]')?.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > 200_000) {
      toast('That settings file is too large.', { kind: 'error' });
      return;
    }
    try {
      const parsed = JSON.parse(await file.text());
      if (!parsed || typeof parsed !== 'object') throw new Error('Not a settings file.');
      localStorage.setItem(PREF_KEY, JSON.stringify(parsed));
      prefs = loadPrefs();
      applyTheme();
      applyConfig();
      renderRoute({ scroll: false });
      toast('Settings imported.');
    } catch (error) {
      toast(error.message || 'Could not read that settings file.', { kind: 'error' });
    }
  });

  document.querySelector('[data-reset-settings]')?.addEventListener('click', () => {
    if (!confirm('Reset all settings? Watch positions and custom instances will also be removed.')) return;
    localStorage.removeItem(PREF_KEY);
    prefs = loadPrefs();
    applyTheme();
    applyConfig();
    renderRoute({ scroll: false });
    toast('Settings reset.');
  });
}

async function testAllInstances(button) {
  const original = button.innerHTML;
  button.disabled = true;
  button.textContent = 'Testing…';
  await probeAll();
  button.disabled = false;
  button.innerHTML = original;
  updateInstancePill(currentActive(), 'ok');
  if (currentRoute?.path === '/settings') renderRoute({ scroll: false });
  if (els.instanceDialog.open) renderInstanceList();
}

function wireInstanceRows(root) {
  root.addEventListener('click', (event) => {
    const use = event.target.closest('[data-use-instance]');
    if (use) {
      chooseInstance(use.dataset.useInstance);
      return;
    }
    const remove = event.target.closest('[data-remove-instance]');
    if (remove) removeInstance(remove.dataset.removeInstance);
  });
}

/* --------------------------------------------------------------------------
   Theme studio
   -------------------------------------------------------------------------- */

function currentVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function hexOr(value, fallback) {
  return /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
}

function themeSnippet() {
  const defaults = {
    accent: currentVar('--rc-accent') || prefs.accent,
    bg: currentVar('--rc-bg') || '#0d0d0d',
    surface: currentVar('--rc-surface') || '#171717',
    text: currentVar('--rc-text') || '#ebebeb',
    muted: currentVar('--rc-muted') || '#909090',
  };
  const scope = `${location.origin}${location.pathname.replace(/[^/]*$/, '')}`;
  const radius = prefs.radius;
  const gap = Math.round(16 * prefs.density);
  return `/* Recorded custom theme.
   Stylus > Write new style > paste.
   Only include the variables you want to change. */
@-moz-document url-prefix("${scope}") {
  :root {
    --rc-accent: ${hexOr(prefs.accent, defaults.accent)};
    --rc-bg: ${hexOr(prefs.bg, defaults.bg)};
    --rc-surface: ${hexOr(prefs.surface, defaults.surface)};
    --rc-text: ${hexOr(prefs.text, defaults.text)};
    --rc-muted: ${hexOr(prefs.muted, defaults.muted)};
    --rc-radius: ${radius}px;
    --rc-gap: ${gap}px;
  }

  /* Examples:
  .rc-card__thumb { border-radius: 8px; }
  .rc-header { border-bottom-color: transparent; }
  */
}`;
}

function themeColorField(label, key, value) {
  return `
    <div class="rc-theme__color">
      <input class="rc-color" type="color" data-theme-color="${key}" value="${esc(value)}" aria-label="${esc(label)}">
      <label>${esc(label)}<br><span class="rc-mono" style="font-size:10px;color:var(--rc-faint)">${esc(value)}</span></label>
    </div>
  `;
}

async function renderTheme(token) {
  document.title = 'Theme studio — Recorded';
  const computed = {
    accent: prefs.accent,
    bg: hexOr(prefs.bg, currentVar('--rc-bg') || '#0a0a0d'),
    surface: hexOr(prefs.surface, currentVar('--rc-surface') || '#14141b'),
    text: hexOr(prefs.text, currentVar('--rc-text') || '#f2f2f6'),
    muted: hexOr(prefs.muted, currentVar('--rc-muted') || '#9797a8'),
  };

  els.app.innerHTML = `
    <section class="rc-page-head">
      <div>
        <h1 class="rc-page-title">Theme</h1>
        <p class="rc-page-sub">Colours and spacing. Export as a Stylus userstyle.</p>
      </div>
      <div class="rc-row">
        <button class="rc-btn rc-btn--ghost" type="button" data-reset-theme>Reset</button>
        <button class="rc-btn rc-btn--accent" type="button" data-copy-theme>
          <svg class="rc-icon" aria-hidden="true"><use href="#i-copy"/></svg> Copy Stylus
        </button>
      </div>
    </section>

    <div class="rc-theme">
      <div class="rc-theme__form">
        <section class="rc-theme__group">
          <h3>Colours</h3>
          <div class="rc-theme__colors">
            ${themeColorField('Accent', 'accent', computed.accent)}
            ${themeColorField('Background', 'bg', computed.bg)}
            ${themeColorField('Surface', 'surface', computed.surface)}
            ${themeColorField('Text', 'text', computed.text)}
            ${themeColorField('Muted text', 'muted', computed.muted)}
          </div>
        </section>
        <section class="rc-theme__group">
          <h3>Shape</h3>
          <label class="rc-field" style="border:0;padding:0">
            <span class="rc-field__label">Roundness <span class="rc-muted" data-pref-value="radius">${prefs.radius}px</span></span>
            <input class="rc-range" type="range" min="0" max="28" step="1" data-theme-range="radius" value="${prefs.radius}">
          </label>
          <label class="rc-field" style="border:0;padding:10px 0 0">
            <span class="rc-field__label">Density <span class="rc-muted" data-pref-value="density">${prefs.density}×</span></span>
            <input class="rc-range" type="range" min="0.75" max="1.5" step="0.05" data-theme-range="density" value="${prefs.density}">
          </label>
        </section>
        <section class="rc-theme__group">
          <h3>Selectors</h3>
          <p class="rc-small rc-muted" style="line-height:1.6">
            Stable hooks: <code>.rc-header</code>, <code>.rc-search</code>, <code>.rc-card</code>,
            <code>.rc-card__thumb</code>, <code>.rc-card__title</code>, <code>.rc-btn</code>,
            <code>.rc-chip</code>, <code>.rc-player</code>, <code>.rc-watch</code>,
            <code>.rc-dialog</code>, <code>.rc-footer</code>.
            All colours and spacing are set through <code>--rc-*</code> variables.
            <a href="./THEMING.md" target="_blank" rel="noopener" style="color:var(--rc-accent)">THEMING.md</a>
          </p>
        </section>
      </div>

      <aside class="rc-theme__preview" aria-label="Theme preview">
        <div class="rc-theme__preview-title">Preview</div>
        <div class="rc-brand" style="margin-bottom:10px">
          <span class="rc-brand__name">Recorded</span>
        </div>
        <div class="rc-search" style="min-height:32px;margin-bottom:10px">
          <svg class="rc-icon rc-search__icon" aria-hidden="true"><use href="#i-search"/></svg>
          <span class="rc-muted rc-small" style="padding-left:6px">Search</span>
        </div>
        <article class="rc-card">
          <div class="rc-card__thumb" style="background:var(--rc-surface-2)">
            <span class="rc-card__dur">12:04</span>
          </div>
          <div class="rc-card__body">
            <h3 class="rc-card__title">A video title in two lines</h3>
            <div class="rc-card__meta">Channel · 12K views · today</div>
          </div>
        </article>
        <div class="rc-row" style="margin-top:10px">
          <span class="rc-chip" aria-pressed="true">Trending</span>
          <span class="rc-chip">Music</span>
        </div>
        <p class="rc-theme__note">The preview uses the real search, card and chip styles.</p>
      </aside>
    </div>

    <section class="rc-section" style="margin-top:22px">
      <div class="rc-spread" style="margin-bottom:6px">
        <h2 class="rc-section__title" style="font-size:14px">Stylus</h2>
        <button class="rc-btn rc-btn--ghost" type="button" data-copy-theme>
          <svg class="rc-icon" aria-hidden="true"><use href="#i-copy"/></svg> Copy
        </button>
      </div>
      <div class="rc-theme__code">
        <pre id="theme-code">${esc(themeSnippet())}</pre>
      </div>
      <p class="rc-small rc-muted" style="margin-top:6px">Target: <code>${esc(location.origin + location.pathname.replace(/[^/]*$/, ''))}</code></p>
    </section>
  `;

  const updateSnippet = () => {
    const pre = document.getElementById('theme-code');
    if (pre) pre.textContent = themeSnippet();
  };

  for (const input of els.app.querySelectorAll('[data-theme-color]')) {
    input.addEventListener('input', () => {
      const key = input.dataset.themeColor;
      prefs[key] = input.value;
      savePrefs();
      applyTheme();
      const label = input.parentElement?.querySelector('.rc-mono');
      if (label) label.textContent = input.value;
      updateSnippet();
    });
  }

  for (const input of els.app.querySelectorAll('[data-theme-range]')) {
    const key = input.dataset.themeRange;
    input.addEventListener('input', () => {
      prefs[key] = Number(input.value);
      savePrefs();
      applyTheme();
      const output = els.app.querySelector(`[data-pref-value="${key}"]`);
      if (output) output.textContent = key === 'radius' ? `${input.value}px` : `${input.value}×`;
      updateSnippet();
    });
  }

  if (isStale(token)) return;
}

/* --------------------------------------------------------------------------
   Not found
   -------------------------------------------------------------------------- */

function renderNotFound(token, message = 'That page does not exist.') {
  document.title = 'Not found — Recorded';
  els.app.innerHTML = `
    <div class="rc-empty" style="margin-top:32px">
      <svg class="rc-icon" aria-hidden="true"><use href="#i-x"/></svg>
      <h3>Not found.</h3>
      <p>${esc(message)}</p>
      <a class="rc-btn rc-btn--accent" href="#/">Back to trending</a>
    </div>
  `;
}

/* --------------------------------------------------------------------------
   Search suggestions
   -------------------------------------------------------------------------- */

function hideSuggestions() {
  els.suggestions.hidden = true;
  els.suggestions.innerHTML = '';
  suggestionItems = [];
  suggestionIndex = -1;
}

function renderSuggestions(items) {
  suggestionItems = items;
  suggestionIndex = -1;
  if (!items.length) {
    hideSuggestions();
    return;
  }
  els.suggestions.innerHTML = items
    .map((item, index) => `
      <button class="rc-suggest__item" type="button" role="option" aria-selected="false" data-suggestion-index="${index}">
        <svg class="rc-icon" aria-hidden="true"><use href="#${item.type === 'video' ? 'i-play' : 'i-search'}"/></svg>
        <span>${esc(item.label)}</span>
      </button>
    `)
    .join('');
  els.suggestions.hidden = false;
  for (const button of els.suggestions.querySelectorAll('[data-suggestion-index]')) {
    button.addEventListener('click', () => {
      const item = suggestionItems[Number(button.dataset.suggestionIndex)];
      applySuggestion(item);
    });
  }
}

function applySuggestion(item) {
  if (!item) return;
  hideSuggestions();
  if (item.type === 'video' && item.id) {
    go(`#/watch?v=${item.id}`);
  } else {
    els.searchInput.value = item.label;
    els.searchClear.hidden = false;
    go(`#/search?q=${encodeURIComponent(item.label)}`);
  }
}

function scheduleSuggestions() {
  clearTimeout(suggestionsTimer);
  suggestionsController?.abort();
  const value = els.searchInput.value.trim();
  els.searchClear.hidden = !value;
  if (!value) {
    hideSuggestions();
    return;
  }

  const directId = parseVideoInput(value);
  const direct = directId ? [{ type: 'video', id: directId, label: `Open video ${directId}` }] : [];
  if (direct.length) renderSuggestions(direct);

  suggestionsTimer = setTimeout(async () => {
    suggestionsController = new AbortController();
    const local = direct.slice();
    try {
      const remote = await suggestions(value, { signal: suggestionsController.signal });
      if (els.searchInput.value.trim() !== value) return;
      const items = [
        ...local,
        ...remote
          .filter((label) => label && label.toLowerCase() !== value.toLowerCase())
          .map((label) => ({ type: 'query', label })),
      ];
      renderSuggestions(items.slice(0, 9));
    } catch {
      if (!local.length) hideSuggestions();
    }
  }, 170);
}

function moveSuggestion(delta) {
  if (!suggestionItems.length) return;
  suggestionIndex = (suggestionIndex + delta + suggestionItems.length) % suggestionItems.length;
  const buttons = els.suggestions.querySelectorAll('[data-suggestion-index]');
  buttons.forEach((button, index) => {
    const selected = index === suggestionIndex;
    button.setAttribute('aria-selected', String(selected));
    if (selected) button.scrollIntoView({ block: 'nearest' });
  });
}

/* --------------------------------------------------------------------------
   Global events
   -------------------------------------------------------------------------- */

function bindGlobalEvents() {
  els.searchForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (suggestionIndex >= 0) {
      applySuggestion(suggestionItems[suggestionIndex]);
      return;
    }
    const value = els.searchInput.value.trim();
    if (!value) return;
    const id = parseVideoInput(value);
    hideSuggestions();
    if (id) go(`#/watch?v=${id}`);
    else go(`#/search?q=${encodeURIComponent(value)}&sort=${prefs.searchSort}&page=1`);
  });

  els.searchInput.addEventListener('input', scheduleSuggestions);
  els.searchInput.addEventListener('focus', () => {
    if (suggestionItems.length) els.suggestions.hidden = false;
    else if (els.searchInput.value.trim()) scheduleSuggestions();
  });
  els.searchInput.addEventListener('blur', () => {
    setTimeout(() => {
      if (!els.suggestions.contains(document.activeElement)) hideSuggestions();
    }, 120);
  });
  els.searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveSuggestion(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveSuggestion(-1);
    } else if (event.key === 'Escape') {
      hideSuggestions();
      els.searchInput.blur();
    }
  });
  els.searchClear.addEventListener('click', () => {
    els.searchInput.value = '';
    els.searchClear.hidden = true;
    hideSuggestions();
    els.searchInput.focus();
  });

  document.addEventListener('click', (event) => {
    if (!els.searchForm.contains(event.target)) hideSuggestions();
    if (event.target.closest('[data-close-dialog]')) {
      event.target.closest('dialog')?.close();
    }
    if (event.target.closest('[data-open-shortcuts]')) openDialog(els.shortcutsDialog);
    if (event.target.closest('[data-open-instances]')) openInstanceDialog();
  });

  els.instanceButton.addEventListener('click', openInstanceDialog);
  els.instanceRetest.addEventListener('click', () => testAllInstances(els.instanceRetest));
  wireInstanceRows(els.app);
  wireInstanceRows(els.instanceList);

  els.app.addEventListener('click', (event) => {
    const retry = event.target.closest('[data-retry]');
    if (retry) renderRoute({ scroll: false });
    const instances = event.target.closest('[data-open-instances]');
    if (instances) openInstanceDialog();
    const downloads = event.target.closest('[data-open-downloads]');
    if (downloads) openDownloads();
    const copy = event.target.closest('[data-copy-link]');
    if (copy) copyText(location.href);
    const author = event.target.closest('[data-search-author]');
    if (author) go(`#/search?q=${encodeURIComponent(author.dataset.searchAuthor)}`);
    const test = event.target.closest('[data-test-instances]');
    if (test) testAllInstances(test);
    const themeCopy = event.target.closest('[data-copy-theme]');
    if (themeCopy) copyText(themeSnippet());
    const resetThemeButton = event.target.closest('[data-reset-theme]');
    if (resetThemeButton) {
      resetTheme();
      renderRoute({ scroll: false });
      toast('Theme reset.');
    }
  });

  document.addEventListener('keydown', (event) => {
    const tag = event.target.tagName;
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || event.target.isContentEditable;
    if (typing) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (document.querySelector('dialog[open]')) return;

    if (event.key === '/' && !typing) {
      event.preventDefault();
      els.searchInput.focus();
      els.searchInput.select();
      return;
    }
    if (event.key === '?') {
      event.preventDefault();
      openDialog(els.shortcutsDialog);
      return;
    }
    if (event.key === 'Escape') {
      hideSuggestions();
      return;
    }
    if (currentRoute?.path !== '/watch' || !activePlayer) return;

    switch (event.key.toLowerCase()) {
      case 'k':
      case ' ':
        event.preventDefault();
        activePlayer.togglePlay();
        break;
      case 'j':
        activePlayer.seekBy(-10);
        break;
      case 'l':
        activePlayer.seekBy(10);
        break;
      case 'm':
        activePlayer.toggleMute();
        break;
      case 'f':
        document.getElementById('player-shell')?.requestFullscreen?.();
        break;
      case 'd':
        event.preventDefault();
        openDownloads();
        break;
      case 'a': {
        const next = activePlayer.mode === 'audio' ? 'video' : 'audio';
        if (activePlayer.setMode(next)) {
          for (const button of document.querySelectorAll('[data-mode]')) {
            button.setAttribute('aria-pressed', String(button.dataset.mode === next));
          }
        }
        break;
      }
      case ',':
        activePlayer.setRate(Math.max(0.25, (activePlayer.currentMedia()?.playbackRate || 1) - 0.25));
        break;
      case '.':
        activePlayer.setRate(Math.min(2, (activePlayer.currentMedia()?.playbackRate || 1) + 0.25));
        break;
      default:
        break;
    }
  });

  window.addEventListener('hashchange', () => renderRoute());
  matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', () => {
    if (prefs.theme === 'system') applyTheme();
  });

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(() => {
        /* offline shell is a nice-to-have */
      });
    });
  }
}

/* --------------------------------------------------------------------------
   Boot
   -------------------------------------------------------------------------- */

applyTheme();
applyConfig();
bindGlobalEvents();
renderRoute();

// Warm the health data without delaying the first render.
setTimeout(async () => {
  try {
    await probeAll({
      onResult: (instance) => {
        if (instance.url === currentActive()?.url) {
          const status = instanceStatus(instance);
          updateInstancePill(instance, status.state === 'ok' ? 'ok' : 'bad');
        }
      },
    });
    if (els.instanceDialog.open) renderInstanceList();
  } catch {
    /* health checks are best-effort */
  }
}, 1400);
