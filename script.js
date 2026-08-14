'use strict';
/* ============================================================
   AURA X · Principal Fullstack Audio Engine
   Multi-source streaming: Piped/Invidious + SoundCloud + Hitmo
   Failover, Web Audio FX, Playlists, Visualizer
   ============================================================ */

const STORE_KEY = 'aura_x_v1';
const TIMEOUT = 8500;

const PIPED = { good: 0, list: [
  'https://pipedapi.kavin.rocks',
  'https://api.piped.private.coffee',
  'https://pipedapi.adminforge.de',
  'https://pipedapi.reallyaweso.me',
  'https://pipedapi.ducks.party',
  'https://pipedapi.leptons.xyz'
]};
const INVIDIOUS = { good: 0, list: [
  'https://invidious.nerdvpn.de',
  'https://inv.nadeko.net',
  'https://invidious.f5.si',
  'https://iv.melmac.space',
  'https://yewtu.be',
  'https://invidious.jing.rocks'
]};

// SoundCloud client_id (несколько вариантов с фолбэком)
const SC_CLIENT_IDS = [
  'iZIs9mchc0X5lhcv1KinOhPnku3MhWc9',
  '2t9loNQH90kzJcsFCODdigxfp325aq4z82QEAfAq8YB53',
  'J5xmSaree4x8ZYvZ7y8Lz94T8Y6H2Gk3'
];
const SC_PROXY = 'https://corsproxy.io/?';

const state = {
  screen: 'search',
  source: 'all', // 'all' | 'piped' | 'soundcloud'
  queue: [], current: -1, track: null,
  candidates: [], cand: 0,
  shuffle: false, repeat: 0,
  vol: 0.9, muted: false, draggingSeek: false,
  favorites: [],
  playlists: [],
  currentPlaylist: null, // {name, idx}
  searchToken: 0, playToken: 0,
  scClientId: null,
  settings: {
    rate: 1, preservePitch: true,
    bassOn: false, bass: 8,
    vizOn: true,
    theme: 'violet', discStyle: 'vinyl',
    blur: 16, dim: 50, wallpaper: null,
  },
  audioGraphReady: false,
};

/* ---------- DOM ---------- */
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const audio = $('#audio');
const cover = $('#cover'), disc = $('#disc'), discGlass = $('#discGlass'), discNeon = $('#discNeon'), discWrap = $('#discWrap');
const npTitle = $('#npTitle'), npArtist = $('#npArtist'), pillSrc = $('#pillSrc'), pillQ = $('#pillQ'), pillFx = $('#pillFx');
const seekFill = $('#seekFill'), seekThumb = $('#seekThumb'), seekBuffer = $('#seekBuffer'), seekbar = $('#seekbar');
const tCur = $('#tCur'), tDur = $('#tDur');
const btnPlay = $('#btnPlay'), icoPlay = $('#icoPlay'), icoPause = $('#icoPause');
const btnPrev = $('#btnPrev'), btnNext = $('#btnNext'), btnShuffle = $('#btnShuffle'), btnRepeat = $('#btnRepeat'), repBadge = $('#repBadge');
const muteBtn = $('#muteBtn'), icoVol = $('#icoVol'), icoMute = $('#icoMute');
const volbar = $('#volbar'), volFill = $('#volFill'), volThumb = $('#volThumb');
const btnFav = $('#btnFav');
const qInput = $('#q'), spin = $('#spin');
const resultsEl = $('#results'), favsList = $('#favsList'), playlistsEl = $('#playlists');
const toastsEl = $('#toasts'), vizEl = $('#viz'), vctx = vizEl.getContext('2d');
const rateSlider = $('#rateSlider'), rateVal = $('#rateVal');
const bassSlider = $('#bassSlider'), bassVal = $('#bassVal');
const blurSlider = $('#blurSlider'), blurVal = $('#blurVal');
const dimSlider = $('#dimSlider'), dimVal = $('#dimVal');
const btnUploadWall = $('#btnUploadWall'), wallInput = $('#wallInput'), btnResetWall = $('#btnResetWall');
const wallpaper = $('#wallpaper');
const statPiped = $('#statPiped'), statInv = $('#statInv'), statSc = $('#statSc');

const NOTE_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg>';

/* ---------- storage ---------- */
function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      favorites: state.favorites,
      playlists: state.playlists,
      settings: state.settings,
      vol: state.vol,
    }));
  } catch (e) {}
}
function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return;
    const d = JSON.parse(raw);
    if (Array.isArray(d.favorites)) state.favorites = d.favorites;
    if (Array.isArray(d.playlists)) state.playlists = d.playlists;
    if (d.settings) Object.assign(state.settings, d.settings);
    if (typeof d.vol === 'number') state.vol = d.vol;
  } catch (e) {}
}

/* ---------- utils ---------- */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = (s) => (!isFinite(s) || s <= 0) ? '0:00' : Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const canPlay = (m) => m ? audio.canPlayType(m.split(';')[0]) !== '' : true;
const codecOf = (m) => {
  const s = String(m || '').toLowerCase();
  if (s.includes('opus')) return 'OPUS';
  if (s.includes('mp4a') || s.includes('aac') || s.includes('mp4')) return 'AAC';
  if (s.includes('mpeg') || s.includes('mp3')) return 'MP3';
  if (s.includes('vorbis')) return 'VORBIS';
  return 'AUDIO';
};

function toast(msg, type = 'info') {
  const d = document.createElement('div');
  d.className = 'toast t-' + type;
  d.innerHTML = '<i></i>' + esc(msg);
  toastsEl.append(d);
  setTimeout(() => { d.classList.add('out'); setTimeout(() => d.remove(), 280); }, 3400);
}

async function fetchJSON(url, timeout = TIMEOUT, proxy = '') {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const fullUrl = proxy ? proxy + encodeURIComponent(url) : url;
    const r = await fetch(fullUrl, { signal: ctrl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

async function nodeFetch(pool, makePath) {
  const L = pool.list;
  let last;
  for (let k = 0; k < L.length; k++) {
    const base = L[(pool.good + k) % L.length];
    try {
      const data = await fetchJSON(base + makePath(base));
      pool.good = (pool.good + k) % L.length;
      return { data, base };
    } catch (e) { last = e; }
  }
  throw last || new Error('offline');
}

/* ============================================================
   PIPED / INVIDIOUS
   ============================================================ */
const idFromUrl = (u) => {
  const m = String(u).match(/watch\?v=([\w-]{6,})/);
  return m ? m[1] : String(u).replace(/[^A-Za-z0-9_-]/g, '');
};

async function searchPiped(q) {
  const { data } = await nodeFetch(PIPED, () => `/search?q=${encodeURIComponent(q)}&filter=music_songs`);
  const items = (data.items || []).filter((it) => it.url && it.type === 'stream').slice(0, 30);
  if (!items.length) throw new Error('empty');
  return items.map((it) => ({
    source: 'piped', id: idFromUrl(it.url),
    title: it.title || 'Без названия',
    artist: it.uploaderName || '—',
    thumb: it.thumbnail ? (it.thumbnail.startsWith('//') ? 'https:' + it.thumbnail : it.thumbnail) : '',
    duration: it.duration > 0 ? it.duration : 0,
  })).filter((t) => t.id);
}

async function searchInv(q) {
  const { data } = await nodeFetch(INVIDIOUS, () => `/api/v1/search?q=${encodeURIComponent(q)}&type=music`);
  const arr = Array.isArray(data) ? data.filter((v) => v.videoId).slice(0, 30) : [];
  if (!arr.length) throw new Error('empty');
  return arr.map((v) => ({
    source: 'invidious', id: v.videoId,
    title: v.title || 'Без названия',
    artist: v.author || '—',
    thumb: `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
    duration: v.lengthSeconds > 0 ? v.lengthSeconds : 0,
  }));
}

async function resolvePipedStream(t) {
  const { data } = await nodeFetch(PIPED, () => `/streams/${t.id}`);
  const streams = (data.audioStreams || [])
    .filter((s) => s.url && canPlay(s.mimeType))
    .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
  const top = streams.slice(0, 4);
  if (!top.length) throw new Error('no audio');
  return {
    candidates: top.map((s) => s.url),
    kbps: Math.round((top[0].bitrate || 130000) / 1000),
    codec: codecOf(top[0].mimeType || top[0].codec),
    thumb: data.thumbnail || t.thumb,
    duration: data.duration || t.duration,
    title: data.title || t.title,
    artist: data.uploader || data.uploaderName || t.artist,
  };
}

async function resolveInvStream(t) {
  const { data, base } = await nodeFetch(INVIDIOUS, () => `/api/v1/videos/${t.id}?local=true`);
  const af = (data.adaptiveFormats || [])
    .filter((f) => f.url && f.type && f.type.startsWith('audio') && canPlay(f.type))
    .sort((a, b) => (+b.bitrate || 0) - (+a.bitrate || 0));
  const top = af.slice(0, 4);
  if (top.length) {
    return {
      candidates: top.map((f) => f.url),
      kbps: Math.round((+top[0].bitrate || 130000) / 1000),
      codec: codecOf(top[0].type),
      thumb: t.thumb,
      duration: data.lengthSeconds > 0 ? data.lengthSeconds : t.duration,
      title: data.title || t.title,
      artist: data.author || t.artist,
    };
  }
  return {
    candidates: [`${base}/latest_version?id=${t.id}&itag=251`],
    kbps: 160, codec: 'OPUS',
    thumb: t.thumb, duration: t.duration, title: t.title, artist: t.artist,
  };
}

/* ============================================================
   SOUNDCLOUD
   ============================================================ */
async function scFetch(url) {
  if (!state.scClientId) {
    for (const cid of SC_CLIENT_IDS) {
      try {
        await fetchJSON(`${SC_PROXY}${encodeURIComponent(`https://api-v2.soundcloud.com/search/tracks?q=test&limit=1&client_id=${cid}`)}`);
        state.scClientId = cid;
        break;
      } catch (e) {}
    }
  }
  if (!state.scClientId) throw new Error('no sc client');
  const sep = url.includes('?') ? '&' : '?';
  const fullUrl = url + sep + 'client_id=' + state.scClientId;
  return fetchJSON(`${SC_PROXY}${encodeURIComponent(fullUrl)}`);
}

async function searchSoundCloud(q) {
  const d = await scFetch(`https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(q)}&limit=30`);
  const items = (d.collection || []).slice(0, 30);
  if (!items.length) throw new Error('empty');
  return items.map((t) => ({
    source: 'soundcloud',
    id: String(t.id),
    title: t.title || 'Без названия',
    artist: t.user?.username || '—',
    thumb: (t.artwork_url || '').replace('-large', '-t500x500') || (t.user?.avatar_url || '').replace('-large', '-t500x500'),
    duration: Math.round((t.duration || 0) / 1000),
    scMedia: t.media,
    scPermalink: t.permalink_url,
  })).filter((t) => t.id);
}

async function resolveSoundCloudStream(t) {
  // пробуем transcoding progressive (mp3)
  const transcodings = t.scMedia?.transcodings || [];
  const prog = transcodings.find((x) => x.format?.protocol === 'progressive' && x.format?.mime_type?.includes('mpeg'))
            || transcodings.find((x) => x.format?.protocol === 'progressive')
            || transcodings[0];
  if (!prog || !prog.url) throw new Error('no transcoding');
  const meta = await scFetch(prog.url);
  if (!meta || !meta.url) throw new Error('no stream url');
  return {
    candidates: [meta.url],
    kbps: 128, codec: 'MP3',
    thumb: t.thumb, duration: t.duration,
    title: t.title, artist: t.artist,
  };
}

/* ============================================================
   ORCHESTRATOR
   ============================================================ */
async function doSearch(raw) {
  const q = (raw || '').trim();
  if (!q) return;
  const token = ++state.searchToken;
  spin.hidden = false;
  showSkeleton();

  const source = state.source;
  const results = [];
  const errors = [];

  if (source === 'all' || source === 'piped') {
    const [p, i] = await Promise.allSettled([searchPiped(q), searchInv(q)]);
    if (p.status === 'fulfilled' && p.value.length) {
      results.push(...p.value);
      statPiped.textContent = `✓ ${p.value.length}`;
      statPiped.className = 'set-val green';
    } else {
      statPiped.textContent = '✗ упал';
      statPiped.className = 'set-val red';
      errors.push('Piped');
    }
    if (i.status === 'fulfilled' && i.value.length) {
      results.push(...i.value);
      statInv.textContent = `✓ ${i.value.length}`;
      statInv.className = 'set-val green';
    } else {
      statInv.textContent = '✗ упал';
      statInv.className = 'set-val red';
      errors.push('Invidious');
    }
  }

  if (source === 'all' || source === 'soundcloud') {
    try {
      const sc = await searchSoundCloud(q);
      if (sc.length) {
        results.push(...sc);
        statSc.textContent = `✓ ${sc.length}`;
        statSc.className = 'set-val green';
      } else {
        statSc.textContent = '✗ пусто';
        statSc.className = 'set-val red';
      }
    } catch (e) {
      statSc.textContent = '✗ упал';
      statSc.className = 'set-val red';
      errors.push('SoundCloud');
    }
  }

  if (token !== state.searchToken) return;
  spin.hidden = true;

  if (!results.length) {
    renderEmpty(q);
    toast(`Ничего не найдено. ${errors.length ? 'Упали: ' + errors.join(', ') : ''}`, 'warn');
    return;
  }

  // убираем дубли (по id+source)
  const seen = new Set();
  state.queue = results.filter((t) => {
    const k = t.source + ':' + t.id;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  state.current = -1;
  renderResults();
  toast(`Найдено ${state.queue.length} треков`, 'ok');
}

/* ============================================================
   RENDER
   ============================================================ */
function cardHTML(t, i, listId) {
  const art = t.thumb ? `<img loading="lazy" src="${esc(t.thumb)}" alt="">` : `<div class="ph">${NOTE_SVG}</div>`;
  return `<article class="track" data-list="${listId}" style="--i:${Math.min(i, 24)}" data-i="${i}">
    <div class="idx"><span class="num">${i + 1}</span><span class="eq"><i></i><i></i><i></i></span></div>
    <div class="art">${art}</div>
    <div class="tmeta">
      <div class="ttitle">${esc(t.title)}</div>
      <div class="tartist">${esc(t.artist)}</div>
    </div>
    <div class="tside">
      <span class="tsrc s-${t.source}">${t.source === 'piped' ? 'YT' : t.source === 'invidious' ? 'YT·INV' : t.source === 'soundcloud' ? 'SC' : t.source.toUpperCase()}</span>
      <span class="tdur">${t.duration ? fmtTime(t.duration) : '—'}</span>
    </div>
  </article>`;
}
function renderResults() { resultsEl.innerHTML = state.queue.map((t, i) => cardHTML(t, i, 'queue')).join(''); renderActive(); }
function renderActive() {
  $$('.track').forEach((el) => {
    const listId = el.dataset.list;
    const i = +el.dataset.i;
    let active = false;
    if (listId === 'queue' && i === state.current) active = true;
    if (listId === 'favs' && state.track && state.favorites[i]?.id === state.track.id && state.favorites[i]?.source === state.track.source) active = true;
    if (listId?.startsWith('pl-') && state.track && state.currentPlaylist?.name === listId.slice(3)) {
      const pl = state.playlists.find((p) => p.name === state.currentPlaylist.name);
      if (pl && pl.tracks[i]?.id === state.track.id && pl.tracks[i]?.source === state.track.source) active = true;
    }
    el.classList.toggle('active', active);
  });
}
function renderFavs() {
  if (!state.favorites.length) {
    favsList.innerHTML = `<div class="empty">${NOTE_SVG.replace(/width="\d+"/, 'width="40"').replace(/height="\d+"/, 'height="40"')}<b>Пока пусто</b><span>Нажмите ❤️ у плеера, чтобы добавить трек в избранное.</span></div>`;
    return;
  }
  favsList.innerHTML = state.favorites.map((t, i) => cardHTML(t, i, 'favs')).join('');
  renderActive();
}
function renderPlaylists() {
  if (!state.playlists.length) {
    playlistsEl.innerHTML = `<div class="empty"><b>Нет плейлистов</b><span>Создайте свой первый плейлист кнопкой сверху.</span></div>`;
    return;
  }
  playlistsEl.innerHTML = state.playlists.map((p, i) => `
    <div class="pl-card" data-pl="${esc(p.name)}">
      <div class="pl-icon">📁</div>
      <div class="pl-name">${esc(p.name)}</div>
      <div class="pl-count">${p.tracks.length} треков</div>
      <button class="pl-del" data-del="${i}" title="Удалить">✕</button>
    </div>`).join('');
}
function showSkeleton() {
  resultsEl.innerHTML = Array.from({ length: 7 }, (_, i) => `
    <div class="track skel" style="--i:${i}">
      <div class="idx"><span class="num">&nbsp;</span></div>
      <div class="sk sk-art"></div>
      <div class="tmeta"><div class="sk sk-a"></div><div class="sk sk-b"></div></div>
      <div class="tside"><span class="tdur">&nbsp;</span></div>
    </div>`).join('');
}
function renderEmpty(q) {
  resultsEl.innerHTML = `<div class="empty">${NOTE_SVG.replace(/width="\d+"/, 'width="42"').replace(/height="\d+"/, 'height="42"')}<b>По запросу «${esc(q)}» пусто</b><span>Все источники не нашли треков. Попробуйте другой запрос.</span></div>`;
}

/* ============================================================
   RESOLVE STREAM
   ============================================================ */
async function resolveStream(t) {
  if (t.source === 'piped') return resolvePipedStream(t);
  if (t.source === 'invidious') return resolveInvStream(t);
  if (t.source === 'soundcloud') return resolveSoundCloudStream(t);
  throw new Error('unknown source');
}

/* ============================================================
   PLAYBACK
   ============================================================ */
async function playIndex(i, listId = 'queue', playlistName = null) {
  let list;
  if (listId === 'favs') list = state.favorites;
  else if (listId?.startsWith('pl-')) {
    const pl = state.playlists.find((p) => p.name === playlistName);
    list = pl?.tracks || [];
  } else list = state.queue;

  const t = list[i];
  if (!t) return;

  if (listId === 'favs') {
    state.queue = state.favorites;
    state.current = i;
    state.currentPlaylist = null;
  } else if (listId?.startsWith('pl-')) {
    state.queue = list;
    state.current = i;
    state.currentPlaylist = { name: playlistName };
  } else {
    state.current = i;
    state.currentPlaylist = null;
  }

  const token = ++state.playToken;
  state.track = t;
  renderActive();
  btnPlay.classList.add('loading');
  pillQ.hidden = true;

  try {
    const r = await resolveStream(t);
    if (token !== state.playToken) return;

    npTitle.textContent = r.title;
    npArtist.textContent = r.artist;
    document.title = `${r.title} — ${r.artist} · AURA X`;
    pillSrc.textContent = t.source === 'soundcloud' ? 'SOUNDCLOUD' : (t.source === 'invidious' ? 'YT·INV' : t.source.toUpperCase());
    pillSrc.className = 'pill src-' + t.source;
    pillSrc.hidden = false;
    pillQ.textContent = r.kbps ? `${r.kbps} kbps · ${r.codec}` : r.codec;
    pillQ.hidden = false;
    if (r.duration) t.duration = r.duration;

    setCover(r, t);
    setMediaSession(r);
    updateFavButton();

    state.candidates = r.candidates;
    state.cand = 0;
    initAudioGraph();
    startStream(r.candidates[0]);
  } catch (e) {
    if (token !== state.playToken) return;
    btnPlay.classList.remove('loading');
    toast('Не удалось получить поток. Попробуйте другой трек.', 'err');
  }
}

function startStream(url) {
  audio.src = url;
  audio.play().catch((err) => {
    if (err?.name === 'NotAllowedError') btnPlay.classList.remove('loading');
    else tryNextCandidate();
  });
}
function tryNextCandidate() {
  if (state.cand < state.candidates.length - 1) {
    state.cand++;
    toast('Переключаюсь на резервный поток…', 'warn');
    startStream(state.candidates[state.cand]);
  } else {
    btnPlay.classList.remove('loading');
    toast('Все резервные потоки недоступны.', 'err');
  }
}
audio.addEventListener('error', () => {
  if (audio.src && state.candidates.length && !audio.paused) tryNextCandidate();
  else if (audio.src) btnPlay.classList.remove('loading');
});

function setCover(r, t) {
  const src = r.thumb || t.thumb;
  cover.onerror = () => {
    cover.onerror = null;
    if ((t.source === 'piped' || t.source === 'invidious') && t.id) cover.src = `https://i.ytimg.com/vi/${t.id}/hqdefault.jpg`;
    else { disc.classList.remove('hasart'); }
  };
  if (src) {
    disc.classList.add('hasart');
    cover.src = src;
    discGlass.innerHTML = `<img src="${esc(src)}" alt="">`;
    discNeon.innerHTML = `<img src="${esc(src)}" alt="">`;
  } else {
    disc.classList.remove('hasart');
    cover.removeAttribute('src');
    discGlass.innerHTML = '';
    discNeon.innerHTML = '';
  }
}

function togglePlay() {
  if (state.current < 0) {
    if (state.queue.length) { playIndex(0); return; }
    switchTab('search');
    qInput.focus();
    toast('Сначала найдите трек в поиске.', 'info');
    return;
  }
  if (audio.paused) audio.play().catch(() => {});
  else audio.pause();
}
function nextIndex(dir = 1) {
  const n = state.queue.length;
  if (!n) return -1;
  if (state.shuffle && n > 1) {
    let r;
    do { r = Math.floor(Math.random() * n); } while (r === state.current);
    return r;
  }
  let i = state.current + dir;
  if (i >= n) return state.repeat >= 1 ? 0 : -1;
  if (i < 0) i = n - 1;
  return i;
}
function playNext() { const i = nextIndex(1); if (i >= 0) playIndex(i); }
function playPrev() {
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  const i = nextIndex(-1);
  if (i >= 0) playIndex(i);
}
function getDuration() {
  const d = audio.duration;
  return (isFinite(d) && d > 0) ? d : (state.track?.duration || 0);
}

/* ============================================================
   WEB AUDIO
   ============================================================ */
let actx = null, srcNode, bassFilter, masterGain, analyser;

function initAudioGraph() {
  if (state.audioGraphReady) return;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    actx = new AC();
    srcNode = actx.createMediaElementSource(audio);
    bassFilter = actx.createBiquadFilter();
    bassFilter.type = 'lowshelf';
    bassFilter.frequency.value = 100;
    bassFilter.gain.value = 0;
    masterGain = actx.createGain();
    masterGain.gain.value = state.vol;
    analyser = actx.createAnalyser();
    analyser.fftSize = 128;
    analyser.smoothingTimeConstant = 0.82;

    srcNode.connect(bassFilter);
    bassFilter.connect(masterGain);
    masterGain.connect(analyser);
    masterGain.connect(actx.destination);
    applySettings();
    state.audioGraphReady = true;
    requestAnimationFrame(drawViz);
  } catch (e) { console.warn('Audio graph init failed', e); }
}

function applySettings() {
  const s = state.settings;
  audio.playbackRate = s.rate;
  audio.preservesPitch = s.preservePitch;
  try { audio.mozPreservesPitch = s.preservePitch; audio.webkitPreservesPitch = s.preservePitch; } catch (e) {}
  audio.volume = state.muted ? 0 : state.vol;
  if (bassFilter) bassFilter.gain.setTargetAtTime(s.bassOn ? s.bass : 0, actx.currentTime, 0.04);
  if (masterGain) masterGain.gain.setTargetAtTime(state.muted ? 0 : state.vol, actx?.currentTime || 0, 0.03);

  const hasFx = s.rate !== 1 || s.bassOn;
  pillFx.hidden = !hasFx;
  vizEl.classList.toggle('hidden', !s.vizOn);
}

/* ============================================================
   AUDIO EVENTS
   ============================================================ */
audio.addEventListener('play', () => {
  if (actx?.state === 'suspended') actx.resume();
  document.body.classList.add('playing');
  btnPlay.classList.remove('loading');
  icoPlay.hidden = true; icoPause.hidden = false;
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
});
audio.addEventListener('pause', () => {
  document.body.classList.remove('playing');
  icoPlay.hidden = false; icoPause.hidden = true;
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
});
audio.addEventListener('timeupdate', () => {
  const d = getDuration();
  tDur.textContent = fmtTime(d);
  if (!state.draggingSeek && d > 0) {
    const pct = (audio.currentTime / d) * 100;
    seekFill.style.width = pct + '%';
    seekThumb.style.left = pct + '%';
  }
  tCur.textContent = fmtTime(audio.currentTime);
});
audio.addEventListener('progress', () => {
  if (audio.buffered.length && audio.duration > 0) {
    const end = audio.buffered.end(audio.buffered.length - 1);
    seekBuffer.style.width = ((end / audio.duration) * 100) + '%';
  }
});
audio.addEventListener('ended', () => {
  if (state.repeat === 2) { audio.currentTime = 0; audio.play().catch(() => {}); return; }
  playNext();
});
audio.addEventListener('loadedmetadata', () => {
  if (state.track && !state.track.duration) {
    state.track.duration = audio.duration;
    tDur.textContent = fmtTime(audio.duration);
  }
});

function setMediaSession(r) {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: r.title, artist: r.artist, album: 'AURA X',
      artwork: (r.thumb || state.track?.thumb) ? [{ src: r.thumb || state.track.thumb, sizes: '480x480', type: 'image/jpeg' }] : []
    });
    navigator.mediaSession.setActionHandler('play', () => audio.play());
    navigator.mediaSession.setActionHandler('pause', () => audio.pause());
    navigator.mediaSession.setActionHandler('previoustrack', playPrev);
    navigator.mediaSession.setActionHandler('nexttrack', playNext);
  } catch (e) {}
}

/* ============================================================
   VISUALIZER
   ============================================================ */
const BARS = 48;
const smoothViz = new Float32Array(BARS);
let vizFreq = null;
function drawViz() {
  requestAnimationFrame(drawViz);
  if (!state.settings.vizOn) return;
  const w = vizEl.width, h = vizEl.height;
  vctx.clearRect(0, 0, w, h);

  let targets = new Float32Array(BARS);
  if (state.audioGraphReady && analyser && state.settings.vizOn) {
    if (!vizFreq) vizFreq = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(vizFreq);
    const usable = Math.floor(vizFreq.length * 0.75);
    for (let i = 0; i < BARS; i++) {
      const idx = Math.min(usable - 1, Math.floor(Math.pow(i / BARS, 1.6) * usable));
      targets[i] = vizFreq[idx] / 255;
    }
  }
  for (let i = 0; i < BARS; i++) smoothViz[i] += (targets[i] - smoothViz[i]) * 0.25;

  const gap = w / BARS;
  const bw = Math.max(2, gap * 0.55);
  const grad = vctx.createLinearGradient(0, h, 0, 0);
  grad.addColorStop(0, getComputedStyle(document.documentElement).getPropertyValue('--acc2').trim());
  grad.addColorStop(1, getComputedStyle(document.documentElement).getPropertyValue('--acc').trim());
  vctx.fillStyle = grad;
  vctx.shadowColor = getComputedStyle(document.documentElement).getPropertyValue('--acc').trim();
  vctx.shadowBlur = 8;
  for (let i = 0; i < BARS; i++) {
    const bh = Math.max(h * 0.05, smoothViz[i] * (h * 0.85));
    const x = i * gap + (gap - bw) / 2;
    vctx.beginPath();
    vctx.roundRect(x, h - bh, bw, bh, bw / 2);
    vctx.fill();
  }
  vctx.shadowBlur = 0;
}

/* ============================================================
   UI: ТРАНСПОРТ
   ============================================================ */
btnPlay.addEventListener('click', togglePlay);
btnNext.addEventListener('click', playNext);
btnPrev.addEventListener('click', playPrev);
btnShuffle.addEventListener('click', () => {
  state.shuffle = !state.shuffle;
  btnShuffle.classList.toggle('on', state.shuffle);
  toast(state.shuffle ? 'Перемешивание включено' : 'Перемешивание выключено', 'info');
});
btnRepeat.addEventListener('click', () => {
  state.repeat = (state.repeat + 1) % 3;
  btnRepeat.classList.toggle('on', state.repeat > 0);
  repBadge.textContent = state.repeat === 2 ? '1' : '';
  toast(['Повтор выключен', 'Повтор плейлиста', 'Повтор одного трека'][state.repeat], 'info');
});
muteBtn.addEventListener('click', () => {
  state.muted = !state.muted;
  applySettings();
  icoVol.hidden = state.muted;
  icoMute.hidden = !state.muted;
});

/* ============================================================
   CUSTOM SLIDERS
   ============================================================ */
function makeSlider(el, fillEl, thumbEl, opts) {
  let dragging = false;
  const update = (x) => {
    const rect = el.getBoundingClientRect();
    let pct = Math.max(0, Math.min(1, (x - rect.left) / rect.width));
    const v = (opts.min ?? 0) + pct * ((opts.max ?? 1) - (opts.min ?? 0));
    const pctVis = pct * 100;
    fillEl.style.width = pctVis + '%';
    thumbEl.style.left = pctVis + '%';
    opts.onChange(v);
  };
  const down = (e) => {
    dragging = true;
    el.classList.add('dragging');
    el.setPointerCapture(e.pointerId);
    update(e.clientX);
  };
  const move = (e) => { if (dragging) update(e.clientX); };
  const up = (e) => {
    if (!dragging) return;
    dragging = false;
    el.classList.remove('dragging');
    try { el.releasePointerCapture(e.pointerId); } catch (_) {}
    opts.onDone && opts.onDone();
  };
  el.addEventListener('pointerdown', down);
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  const v0 = ((opts.initial - (opts.min ?? 0)) / ((opts.max ?? 1) - (opts.min ?? 0)));
  fillEl.style.width = (v0 * 100) + '%';
  thumbEl.style.left = (v0 * 100) + '%';
}

makeSlider(seekbar, seekFill, seekThumb, {
  min: 0, max: 1, initial: 0,
  onChange: (p) => {
    state.draggingSeek = true;
    const d = getDuration();
    if (d > 0) {
      try { audio.currentTime = p * d; } catch (e) {}
      tCur.textContent = fmtTime(p * d);
    }
  },
  onDone: () => { state.draggingSeek = false; }
});

makeSlider(volbar, volFill, volThumb, {
  min: 0, max: 1, initial: state.vol,
  onChange: (p) => {
    state.vol = p;
    if (state.muted && p > 0) { state.muted = false; icoVol.hidden = false; icoMute.hidden = true; }
    applySettings();
    save();
  }
});

function paintNativeRange(el) {
  const min = +el.min || 0, max = +el.max || 100;
  el.style.setProperty('--p', (((+el.value - min) / (max - min)) * 100) + '%');
}

/* ============================================================
   ПОИСК UI
   ============================================================ */
const debouncedSearch = debounce(() => doSearch(qInput.value), 500);
qInput.addEventListener('input', () => {
  if (qInput.value.trim()) debouncedSearch();
  else spin.hidden = true;
});
qInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(qInput.value); });
$$('.chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    qInput.value = chip.dataset.mood;
    doSearch(qInput.value);
  });
});
$$('.src-btn').forEach((b) => {
  b.addEventListener('click', () => {
    $$('.src-btn').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    state.source = b.dataset.src;
  });
});

function trackClick(e) {
  const card = e.target.closest('.track');
  if (!card || card.classList.contains('skel')) return;
  const listId = card.dataset.list;
  const i = +card.dataset.i;
  if (listId === 'favs') playIndex(i, 'favs');
  else if (listId?.startsWith('pl-')) playIndex(i, listId, listId.slice(3));
  else {
    if (i === state.current) togglePlay();
    else playIndex(i, 'queue');
  }
}
resultsEl.addEventListener('click', trackClick);
favsList.addEventListener('click', trackClick);

/* ============================================================
   ПЛЕЙЛИСТЫ
   ============================================================ */
playlistsEl.addEventListener('click', (e) => {
  const del = e.target.closest('.pl-del');
  if (del) {
    const i = +del.dataset.del;
    const name = state.playlists[i].name;
    if (confirm(`Удалить плейлист «${name}»?`)) {
      state.playlists.splice(i, 1);
      renderPlaylists();
      save();
    }
    return;
  }
  const card = e.target.closest('.pl-card');
  if (!card) return;
  const name = card.dataset.pl;
  const pl = state.playlists.find((p) => p.name === name);
  if (pl && pl.tracks.length) {
    playIndex(0, 'pl-' + name, name);
  } else if (pl) {
    toast('Плейлист пуст', 'info');
  }
});

$('#btnNewPl').addEventListener('click', () => {
  const name = prompt('Название нового плейлиста:');
  if (!name) return;
  if (state.playlists.some((p) => p.name === name)) {
    toast('Плейлист с таким именем уже есть', 'warn');
    return;
  }
  state.playlists.push({ name: name.trim(), tracks: [] });
  renderPlaylists();
  save();
  toast(`Создан плейлист «${name}»`, 'ok');
});

function isFavorite(t) {
  return state.favorites.some((f) => f.id === t.id && f.source === t.source);
}
function updateFavButton() {
  if (!state.track) { btnFav.classList.remove('on'); return; }
  btnFav.classList.toggle('on', isFavorite(state.track));
}
btnFav.addEventListener('click', () => {
  if (!state.track) { toast('Сначала включите трек', 'info'); return; }
  if (isFavorite(state.track)) {
    state.favorites = state.favorites.filter((f) => !(f.id === state.track.id && f.source === state.track.source));
    toast('Удалено из избранного', 'info');
  } else {
    state.favorites.unshift({
      id: state.track.id, source: state.track.source,
      title: state.track.title, artist: state.track.artist,
      thumb: state.track.thumb, duration: state.track.duration,
      scMedia: state.track.scMedia, scPermalink: state.track.scPermalink,
    });
    toast('Добавлено в избранное ❤️', 'ok');
  }
  updateFavButton();
  renderFavs();
  save();
});

/* ============================================================
   TABS
   ============================================================ */
function switchTab(name) {
  state.screen = name;
  $$('.screen').forEach((s) => s.classList.toggle('active', s.dataset.screen === name));
  $$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.nav === name));
  if (name === 'library') { renderPlaylists(); renderFavs(); }
}
$$('.nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.nav));
});

/* ============================================================
   НАСТРОЙКИ
   ============================================================ */
function refreshSettingsUI() {
  const s = state.settings;
  rateSlider.value = s.rate; rateVal.textContent = '×' + s.rate.toFixed(2); paintNativeRange(rateSlider);
  bassSlider.value = s.bass; bassVal.textContent = (s.bassOn ? '+' : '') + s.bass.toFixed(1) + ' dB'; paintNativeRange(bassSlider);
  blurSlider.value = s.blur; blurVal.textContent = s.blur + ' px'; paintNativeRange(blurSlider);
  dimSlider.value = s.dim; dimVal.textContent = s.dim + '%'; paintNativeRange(dimSlider);
  $$('[data-theme]').forEach((b) => {
    if (b.classList.contains('theme')) b.classList.toggle('active', b.dataset.theme === s.theme);
  });
  document.documentElement.dataset.theme = s.theme;
  $$('[data-disc]').forEach((b) => b.classList.toggle('active', b.dataset.disc === s.discStyle));
  discWrap.dataset.style = s.discStyle;
  $$('[data-k]').forEach((t) => t.classList.toggle('on', !!s[t.dataset.k]));

  document.documentElement.style.setProperty('--blur-bg', s.blur + 'px');
  document.documentElement.style.setProperty('--dim-bg', (s.dim / 100).toFixed(2));
  if (s.wallpaper) {
    wallpaper.style.backgroundImage = `url(${s.wallpaper})`;
    btnResetWall.hidden = false;
  } else {
    wallpaper.style.backgroundImage = '';
    btnResetWall.hidden = true;
  }
}

rateSlider.addEventListener('input', () => {
  state.settings.rate = +rateSlider.value;
  rateVal.textContent = '×' + state.settings.rate.toFixed(2);
  paintNativeRange(rateSlider);
  applySettings(); save();
});
bassSlider.addEventListener('input', () => {
  state.settings.bass = +bassSlider.value;
  bassVal.textContent = (state.settings.bassOn ? '+' : '') + state.settings.bass.toFixed(1) + ' dB';
  paintNativeRange(bassSlider);
  applySettings(); save();
});
blurSlider.addEventListener('input', () => {
  state.settings.blur = +blurSlider.value;
  blurVal.textContent = state.settings.blur + ' px';
  paintNativeRange(blurSlider);
  document.documentElement.style.setProperty('--blur-bg', state.settings.blur + 'px');
  save();
});
dimSlider.addEventListener('input', () => {
  state.settings.dim = +dimSlider.value;
  dimVal.textContent = state.settings.dim + '%';
  paintNativeRange(dimSlider);
  document.documentElement.style.setProperty('--dim-bg', (state.settings.dim / 100).toFixed(2));
  save();
});

$$('.toggle').forEach((t) => {
  t.addEventListener('click', () => {
    const k = t.dataset.k;
    state.settings[k] = !state.settings[k];
    t.classList.toggle('on', state.settings[k]);
    applySettings(); save();
  });
});
$$('.theme').forEach((b) => {
  b.addEventListener('click', () => {
    state.settings.theme = b.dataset.theme;
    refreshSettingsUI(); save();
  });
});
$$('.style-btn').forEach((b) => {
  b.addEventListener('click', () => {
    state.settings.discStyle = b.dataset.disc;
    refreshSettingsUI(); save();
  });
});

btnUploadWall.addEventListener('click', () => wallInput.click());
wallInput.addEventListener('change', () => {
  const f = wallInput.files[0];
  if (!f) return;
  if (f.size > 5 * 1024 * 1024) { toast('Файл слишком большой (макс 5 MB)', 'warn'); return; }
  const reader = new FileReader();
  reader.onload = () => {
    state.settings.wallpaper = reader.result;
    refreshSettingsUI(); save();
    toast('Обои применены', 'ok');
  };
  reader.readAsDataURL(f);
  wallInput.value = '';
});
btnResetWall.addEventListener('click', () => {
  state.settings.wallpaper = null;
  refreshSettingsUI(); save();
  toast('Обои сброшены', 'info');
});

/* ============================================================
   СТАРТ
   ============================================================ */
(async function init() {
  load();
  audio.volume = state.vol;
  audio.muted = state.muted;
  refreshSettingsUI();

  resultsEl.innerHTML = `<div class="empty">${NOTE_SVG.replace(/width="\d+"/, 'width="42"').replace(/height="\d+"/, 'height="42"')}<b>Начните с поиска</b><span>Введите имя артиста (Alex G, cupsize, Скриптонит) или выберите чип настроения. Поиск идёт каскадом: YouTube → Invidious → SoundCloud.</span></div>`;
  favsList.innerHTML = '';
  playlistsEl.innerHTML = '';

  switchTab('search');
  qInput.focus();
})();