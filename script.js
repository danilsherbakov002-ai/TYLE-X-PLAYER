'use strict';
/* ============================================================
   VK X Player — реальный онлайн-поиск полных треков
   Audius (primary) → Piped (fallback)
   Web Audio: Bass Boost + preserve-pitch speed
   ============================================================ */

/* ---------- состояние ---------- */
const STORE_KEY = 'vkx_player_v1';
const state = {
  screen: 'search',
  queue: [], current: -1, track: null,
  candidates: [], cand: 0,
  shuffle: false, repeat: 0,
  vol: 0.9, muted: false, draggingSeek: false,
  favorites: [],
  settings: { rate: 1, preservePitch: true, bassOn: false, bass: 8, theme: 'violet' },
  audiusHosts: [],
  searchToken: 0, playToken: 0,
  audioGraphReady: false,
};

const PIPED = {
  good: 0,
  list: [
    'https://pipedapi.kavin.rocks',
    'https://api.piped.private.coffee',
    'https://pipedapi.adminforge.de',
    'https://pipedapi.reallyaweso.me',
    'https://pipedapi.ducks.party',
    'https://pipedapi.leptons.xyz'
  ]
};
const TIMEOUT = 8000;

/* ---------- DOM ---------- */
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const audio = $('#audio');
const cover = $('#cover'), disc = $('#disc');
const npTitle = $('#npTitle'), npArtist = $('#npArtist'), pillSrc = $('#pillSrc'), pillQ = $('#pillQ'), pillFx = $('#pillFx');
const seekFill = $('#seekFill'), seekThumb = $('#seekThumb'), seekBuffer = $('#seekBuffer'), seekbar = $('#seekbar');
const tCur = $('#tCur'), tDur = $('#tDur');
const btnPlay = $('#btnPlay'), icoPlay = $('#icoPlay'), icoPause = $('#icoPause');
const btnPrev = $('#btnPrev'), btnNext = $('#btnNext'), btnShuffle = $('#btnShuffle'), btnRepeat = $('#btnRepeat'), repBadge = $('#repBadge');
const muteBtn = $('#muteBtn'), icoVol = $('#icoVol'), icoMute = $('#icoMute');
const volbar = $('#volbar'), volFill = $('#volFill'), volThumb = $('#volThumb');
const btnFav = $('#btnFav');
const qInput = $('#q'), spin = $('#spin');
const resultsEl = $('#results'), favsList = $('#favsList'), favsMeta = $('#favsMeta');
const toastsEl = $('#toasts');
const rateSlider = $('#rateSlider'), rateVal = $('#rateVal');
const bassSlider = $('#bassSlider'), bassVal = $('#bassVal');
const srcAudius = $('#srcAudius'), srcPiped = $('#srcPiped');

const NOTE_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg>';
const PLAY_SVG = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';

/* ---------- персистентность ---------- */
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify({
    favorites: state.favorites,
    settings: state.settings,
    vol: state.vol,
  })); } catch (e) {}
}
function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return;
    const d = JSON.parse(raw);
    if (Array.isArray(d.favorites)) state.favorites = d.favorites;
    if (d.settings) Object.assign(state.settings, d.settings);
    if (typeof d.vol === 'number') state.vol = d.vol;
  } catch (e) {}
}

/* ---------- утилиты ---------- */
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
  setTimeout(() => { d.classList.add('out'); setTimeout(() => d.remove(), 280); }, 3200);
}

async function fetchJSON(url, timeout = TIMEOUT) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
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

/* ================================================================
   AUDIUS — получение списка discovery nodes + поиск + стрим
   ================================================================ */
async function loadAudiusHosts() {
  try {
    const d = await fetchJSON('https://api.audius.co/');
    const hosts = (d.data || []).slice(0, 6).map((h) => h.replace(/\/$/, ''));
    if (!hosts.length) throw new Error('empty');
    state.audiusHosts = hosts;
    srcAudius.textContent = `${hosts.length} хостов`;
    srcAudius.className = 'set-val green';
    return hosts;
  } catch (e) {
    srcAudius.textContent = 'офлайн';
    srcAudius.className = 'set-val';
    return [];
  }
}

async function searchAudius(q) {
  const hosts = state.audiusHosts.length ? state.audiusHosts : await loadAudiusHosts();
  if (!hosts.length) throw new Error('no audius hosts');
  const appName = 'VKX_Player';
  let last;
  for (let k = 0; k < hosts.length; k++) {
    const host = hosts[k];
    try {
      const url = `${host}/v1/tracks/search?query=${encodeURIComponent(q)}&limit=30&app_name=${appName}`;
      const d = await fetchJSON(url);
      const items = (d.data || []).slice(0, 30);
      if (!items.length) throw new Error('empty');
      return items.map((t) => ({
        source: 'audius',
        id: t.id,
        host: host,
        title: t.title || 'Без названия',
        artist: t.user?.name || '—',
        thumb: t.artwork?.['480x480'] || t.artwork?.['150x150'] || '',
        duration: t.duration || 0,
      }));
    } catch (e) { last = e; }
  }
  throw last || new Error('audius fail');
}

function audiusStreamUrl(t) {
  return `${t.host}/v1/tracks/${t.id}/stream?app_name=VKX_Player`;
}
function audiusArtwork(t, size = '1000x1000') {
  if (!t.host) return t.thumb || '';
  return `${t.host}/v1/tracks/${t.id}/artwork/${size}?app_name=VKX_Player`;
}

/* ================================================================
   PIPED — резервный источник
   ================================================================ */
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
    title: it.title || 'Без названия', artist: it.uploaderName || '—',
    thumb: it.thumbnail ? (it.thumbnail.startsWith('//') ? 'https:' + it.thumbnail : it.thumbnail) : '',
    duration: it.duration > 0 ? it.duration : 0,
  })).filter((t) => t.id);
}

async function resolvePipedStream(t) {
  try {
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
  } catch (e) {
    throw e;
  }
}

/* ================================================================
   ОРКЕСТРАЦИЯ ПОИСКА: Audius → Piped
   ================================================================ */
async function doSearch(raw) {
  const q = (raw || '').trim();
  if (!q) return;
  const token = ++state.searchToken;
  spin.hidden = false;
  showSkeleton();

  let audius = null, piped = null;
  try { audius = await searchAudius(q); } catch (e) { audius = null; }
  if (token !== state.searchToken) return;

  if (!audius || audius.length < 5) {
    try { piped = await searchPiped(q); } catch (e) { piped = null; }
    if (token !== state.searchToken) return;
  }

  let tracks = [];
  if (audius?.length) tracks = tracks.concat(audius);
  if (piped?.length) tracks = tracks.concat(piped);

  spin.hidden = true;
  if (!tracks.length) {
    renderEmpty(q);
    toast('Ничего не найдено. Попробуйте другой запрос.', 'warn');
    return;
  }
  state.queue = tracks;
  state.current = -1;
  renderResults();
  const srcText = [];
  if (audius?.length) srcText.push(`Audius: ${audius.length}`);
  if (piped?.length) srcText.push(`Piped: ${piped.length}`);
  toast(`Найдено ${tracks.length} треков · ${srcText.join(' + ')}`, 'ok');
}

/* ================================================================
   РЕНДЕР
   ================================================================ */
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
      <span class="tsrc s-${t.source}">${t.source.toUpperCase()}</span>
      <span class="tdur">${t.duration ? fmtTime(t.duration) : '—'}</span>
    </div>
  </article>`;
}
function renderResults() { resultsEl.innerHTML = state.queue.map((t, i) => cardHTML(t, i, 'queue')).join(''); renderActive(); }
function renderActive() {
  $$('.track').forEach((el) => {
    const listId = el.dataset.list;
    const i = +el.dataset.i;
    const isQ = listId === 'queue' && i === state.current;
    const isFav = listId === 'favs' && state.track && state.favorites[i] && state.favorites[i].id === state.track.id;
    el.classList.toggle('active', isQ || isFav);
  });
}
function renderFavs() {
  if (!state.favorites.length) {
    favsMeta.textContent = 'пусто';
    favsList.innerHTML = `<div class="empty">
      ${NOTE_SVG.replace(/width="\d+"/, 'width="40"').replace(/height="\d+"/, 'height="40"')}
      <b>Пока ничего не сохранено</b>
      <span>Нажмите на сердечко рядом с плеером, чтобы добавить текущий трек в избранное.</span>
    </div>`;
    return;
  }
  favsMeta.textContent = `${state.favorites.length} треков · ваш плейлист`;
  favsList.innerHTML = state.favorites.map((t, i) => cardHTML(t, i, 'favs')).join('');
  renderActive();
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
  resultsEl.innerHTML = `<div class="empty">
    ${NOTE_SVG.replace(/width="\d+"/, 'width="42"').replace(/height="\d+"/, 'height="42"')}
    <b>По запросу «${esc(q)}» пусто</b>
    <span>Audius и Piped не нашли ничего. Попробуйте имя исполнителя на английском.</span>
  </div>`;
}

/* ================================================================
   РЕЗОЛВ ПОТОКА (Audius → Piped)
   ================================================================ */
async function resolveStream(t) {
  if (t.source === 'audius') {
    // пробую несколько discovery nodes
    const hosts = state.audiusHosts.length ? state.audiusHosts : [t.host];
    const candidates = hosts.map((h) => `${h}/v1/tracks/${t.id}/stream?app_name=VKX_Player`);
    return {
      candidates,
      kbps: 320, codec: 'MP3',
      thumb: audiusArtwork(t, '1000x1000') || t.thumb,
      duration: t.duration, title: t.title, artist: t.artist,
    };
  }
  return resolvePipedStream(t);
}

/* ================================================================
   ВОСПРОИЗВЕДЕНИЕ
   ================================================================ */
async function playIndex(i, listId = 'queue') {
  const list = listId === 'favs' ? state.favorites : state.queue;
  const t = list[i];
  if (!t) return;
  if (listId === 'favs') {
    state.queue = state.favorites;
    state.current = i;
  } else {
    state.current = i;
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
    document.title = `${r.title} — ${r.artist} · VK X`;
    pillSrc.textContent = t.source === 'audius' ? 'AUDIUS · MP3' : 'PIPED';
    pillSrc.setAttribute('src', t.source);
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
    if (err && err.name === 'NotAllowedError') btnPlay.classList.remove('loading');
    else tryNextCandidate();
  });
}

function tryNextCandidate() {
  if (state.cand < state.candidates.length - 1) {
    state.cand++;
    toast('Поток оборван — переключаюсь на резервный хост…', 'warn');
    startStream(state.candidates[state.cand]);
  } else {
    // если это был Audius и все хосты упали — пробую Piped для того же трека? Нет, id разный.
    // просто ошибка
    btnPlay.classList.remove('loading');
    toast('Все резервные хосты недоступны. Попробуйте другой трек.', 'err');
  }
}

audio.addEventListener('error', () => {
  if (audio.src && state.candidates.length && !audio.paused) {
    tryNextCandidate();
  } else if (!audio.src) {
    // ignore
  } else {
    btnPlay.classList.remove('loading');
  }
});

function setCover(r, t) {
  const src = r.thumb || t.thumb;
  cover.onerror = () => {
    cover.onerror = null;
    if (t.source === 'piped' && t.id) cover.src = `https://i.ytimg.com/vi/${t.id}/hqdefault.jpg`;
    else { disc.classList.remove('hasart'); disc.classList.add('noart'); }
  };
  if (src) {
    disc.classList.add('hasart');
    disc.classList.remove('noart');
    cover.src = src;
  } else {
    disc.classList.remove('hasart');
    disc.classList.add('noart');
    cover.removeAttribute('src');
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

/* ================================================================
   WEB AUDIO — Bass Boost + playbackRate/preservePitch
   ================================================================ */
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

    srcNode.connect(bassFilter).connect(masterGain).connect(actx.destination);
    applySettings();
    state.audioGraphReady = true;
  } catch (e) { /* не критично */ }
}

function applySettings() {
  const s = state.settings;
  audio.playbackRate = s.rate;
  audio.preservesPitch = s.preservePitch;
  try {
    audio.mozPreservesPitch = s.preservePitch;
    audio.webkitPreservesPitch = s.preservePitch;
  } catch (e) {}
  audio.volume = state.muted ? 0 : state.vol;

  if (bassFilter) {
    bassFilter.gain.setTargetAtTime(s.bassOn ? s.bass : 0, actx.currentTime, 0.04);
  }
  if (masterGain) {
    masterGain.gain.setTargetAtTime(state.muted ? 0 : state.vol, actx?.currentTime || 0, 0.03);
  }

  const hasFx = s.rate !== 1 || s.bassOn;
  pillFx.hidden = !hasFx;
  pillFx.textContent = hasFx ? 'FX' : '';
}

/* ================================================================
   AUDIO EVENTS
   ================================================================ */
audio.addEventListener('play', () => {
  if (actx && actx.state === 'suspended') actx.resume();
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

/* Media Session */
function setMediaSession(r) {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: r.title, artist: r.artist, album: 'VK X',
      artwork: (r.thumb || state.track?.thumb) ? [{ src: r.thumb || state.track.thumb, sizes: '480x480', type: 'image/jpeg' }] : []
    });
    navigator.mediaSession.setActionHandler('play', () => audio.play());
    navigator.mediaSession.setActionHandler('pause', () => audio.pause());
    navigator.mediaSession.setActionHandler('previoustrack', playPrev);
    navigator.mediaSession.setActionHandler('nexttrack', playNext);
  } catch (e) {}
}

/* ================================================================
   UI: ТРАНСПОРТ
   ================================================================ */
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

/* ================================================================
   CUSTOM SLIDERS (pointer events, 60 fps)
   ================================================================ */
function makeSlider(el, fillEl, thumbEl, opts) {
  let dragging = false;
  const update = (x) => {
    const rect = el.getBoundingClientRect();
    let pct = Math.max(0, Math.min(1, (x - rect.left) / rect.width));
    if (opts.discrete) pct = Math.round(pct * 1000) / 1000;
    pct = Math.max(opts.min ?? 0, Math.min(opts.max ?? 1, opts.min + pct * ((opts.max ?? 1) - (opts.min ?? 0))));
    const pctVis = ((pct - (opts.min ?? 0)) / ((opts.max ?? 1) - (opts.min ?? 0))) * 100;
    fillEl.style.width = pctVis + '%';
    thumbEl.style.left = pctVis + '%';
    opts.onChange(pct);
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

  // initial
  const v0 = (opts.initial - (opts.min ?? 0)) / ((opts.max ?? 1) - (opts.min ?? 0));
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

/* Range sliders в настройках */
function paintNativeRange(el) {
  const min = +el.min || 0, max = +el.max || 100;
  el.style.setProperty('--p', (((+el.value - min) / (max - min)) * 100) + '%');
}

/* ================================================================
   UI: ПОИСК
   ================================================================ */
const debouncedSearch = debounce(() => doSearch(qInput.value), 500);
qInput.addEventListener('input', () => {
  if (qInput.value.trim()) debouncedSearch();
  else { spin.hidden = true; }
});
qInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(qInput.value); });

$$('.chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    qInput.value = chip.textContent;
    doSearch(qInput.value);
  });
});

/* делегирование кликов по трекам */
function trackClick(e) {
  const card = e.target.closest('.track');
  if (!card || card.classList.contains('skel')) return;
  const listId = card.dataset.list;
  const i = +card.dataset.i;
  if (listId === 'favs') {
    playIndex(i, 'favs');
  } else {
    if (i === state.current) togglePlay();
    else playIndex(i, 'queue');
  }
}
resultsEl.addEventListener('click', trackClick);
favsList.addEventListener('click', trackClick);

/* ================================================================
   ИЗБРАННОЕ
   ================================================================ */
function isFavorite(t) {
  return state.favorites.some((f) => f.id === t.id && f.source === t.source);
}
function updateFavButton() {
  if (!state.track) { btnFav.classList.remove('on'); return; }
  btnFav.classList.toggle('on', isFavorite(state.track));
}
btnFav.addEventListener('click', () => {
  if (!state.track) return;
  if (isFavorite(state.track)) {
    state.favorites = state.favorites.filter((f) => !(f.id === state.track.id && f.source === state.track.source));
    toast('Удалено из избранного', 'info');
  } else {
    state.favorites.unshift({
      id: state.track.id, source: state.track.source,
      host: state.track.host,
      title: state.track.title, artist: state.track.artist,
      thumb: state.track.thumb, duration: state.track.duration,
    });
    toast('Добавлено в избранное', 'ok');
  }
  updateFavButton();
  renderFavs();
  save();
});

/* ================================================================
   TABS
   ================================================================ */
function switchTab(name) {
  state.screen = name;
  $$('.screen').forEach((s) => s.classList.toggle('active', s.dataset.screen === name));
  $$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.nav === name));
  if (name === 'favs') renderFavs();
}
$$('.nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.nav));
});

/* ================================================================
   НАСТРОЙКИ
   ================================================================ */
function refreshSettingsUI() {
  const s = state.settings;
  rateSlider.value = s.rate; rateVal.textContent = '×' + s.rate.toFixed(2); paintNativeRange(rateSlider);
  bassSlider.value = s.bass; bassVal.textContent = (s.bassOn ? '+' : '') + s.bass.toFixed(1) + ' dB'; paintNativeRange(bassSlider);
  $$('[data-theme]').forEach((b) => {
    if (b.classList.contains('theme')) b.classList.toggle('active', b.dataset.theme === s.theme);
  });
  document.documentElement.dataset.theme = s.theme;
  $$('[data-k]').forEach((t) => {
    t.classList.toggle('on', !!s[t.dataset.k]);
  });
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

/* ================================================================
   СТАРТ
   ================================================================ */
(async function init() {
  load();
  audio.volume = state.vol;
  refreshSettingsUI();

  resultsEl.innerHTML = `<div class="empty">
    ${NOTE_SVG.replace(/width="\d+"/, 'width="42"').replace(/height="\d+"/, 'height="42"')}
    <b>Начните с поиска</b>
    <span>Введите имя исполнителя или жанр — плеер найдёт полные треки в Audius (первично, MP3 320) и автоматически переключится на Piped, если Audius не ответит.</span>
  </div>`;
  favsList.innerHTML = '';
  renderFavs();

  await loadAudiusHosts();
  switchTab('search');
  qInput.focus();
})();