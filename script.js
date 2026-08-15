'use strict';
/* ============================================================
   AURA X · Lane Edition
   Источники: Piped + Invidious (YouTube), SoundCloud v2,
   Audius, Archive.org. Каскадный failover, прогрессивный поиск.
   ============================================================ */

const STORE = 'aura_x_lane_v1';
const TMO = 8000;

const PIPED = { good: 0, list: [
  'https://pipedapi.kavin.rocks','https://pipedapi.adminforge.de','https://pipedapi.reallyaweso.me',
  'https://api.piped.private.coffee','https://pipedapi.ducks.party','https://pipedapi.leptons.xyz',
  'https://pipedapi.drgns.space','https://pipedapi.pufe.org'
]};
const INVIDIOUS = { good: 0, list: [
  'https://invidious.nerdvpn.de','https://inv.nadeko.net','https://invidious.f5.si',
  'https://iv.melmac.space','https://yewtu.be','https://invidious.jing.rocks',
  'https://inv.tux.pizza','https://invidious.privacyredirect.com'
]};
const SC_IDS = ['iZIs9mchc0X5lhcv1KinOhPnku3MhWc9','2t9loNQH90kzJcsFCODdigxfp325aq4z82QEAfAq8YB53'];
const PROXIES = [
  (u) => 'https://corsproxy.io/?url=' + encodeURIComponent(u),
  (u) => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u)
];

const state = {
  source: 'all', queue: [], current: -1, track: null,
  candidates: [], cand: 0, currentUrl: null,
  shuffle: false, repeat: 0, vol: .9, muted: false, dragging: false,
  favorites: [], likes: {}, playlists: [],
  searchToken: 0, playToken: 0, usingMain: true,
  scPair: null, audiusHosts: [],
  settings: {
    rate: 1, preservePitch: true, reverb: 0,
    bassOn: false, bass: 8, vizOn: true,
    theme: 'coral', disc: 'card', blur: 16, dim: 55, wallpaper: null
  }
};

/* ---------- DOM ---------- */
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const aMain = $('#aMain'), aSafe = $('#aSafe');
const A = () => state.usingMain ? aMain : aSafe;
const cover = $('#cover'), artWrap = $('#artWrap'), vizEl = $('#viz'), vctx = vizEl.getContext('2d');
const npTitle = $('#npTitle'), npArtist = $('#npArtist'), pillSrc = $('#pillSrc'), pillQ = $('#pillQ');
const seekFill = $('#seekFill'), seekThumb = $('#seekThumb'), seekBuffer = $('#seekBuffer'), seekbar = $('#seekbar');
const tCur = $('#tCur'), tDur = $('#tDur');
const btnPlay = $('#btnPlay'), icoPlay = $('#icoPlay'), icoPause = $('#icoPause');
const btnPrev = $('#btnPrev'), btnNext = $('#btnNext'), btnShuffle = $('#btnShuffle'), btnRepeat = $('#btnRepeat'), repBadge = $('#repBadge');
const btnFav = $('#btnFav'), likeCount = $('#likeCount'), btnAddPl = $('#btnAddPl'), btnShare = $('#btnShare'), btnDl = $('#btnDl');
const muteBtn = $('#muteBtn'), icoVol = $('#icoVol'), icoMute = $('#icoMute'), volbar = $('#volbar'), volFill = $('#volFill'), volThumb = $('#volThumb');
const qInput = $('#q'), spin = $('#spin'), resultsEl = $('#results'), resMeta = $('#resMeta');
const favsList = $('#favsList'), playlistsEl = $('#playlists'), toastsEl = $('#toasts');
const rateSlider = $('#rateSlider'), rateVal = $('#rateVal');
const reverbSlider = $('#reverbSlider'), reverbVal = $('#reverbVal');
const bassSlider = $('#bassSlider'), bassVal = $('#bassVal');
const blurSlider = $('#blurSlider'), blurVal = $('#blurVal'), dimSlider = $('#dimSlider'), dimVal = $('#dimVal');
const btnUploadWall = $('#btnUploadWall'), wallInput = $('#wallInput'), btnResetWall = $('#btnResetWall'), wallpaper = $('#wallpaper');
const stPiped = $('#statPiped'), stInv = $('#statInv'), stSc = $('#statSc'), stAudius = $('#statAudius'), stArc = $('#statArc');

const NOTE = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg>';

/* ---------- utils ---------- */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = (s) => (!isFinite(s) || s <= 0) ? '0:00' : Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const canPlay = (m) => m ? aMain.canPlayType(m.split(';')[0]) !== '' : true;
const ytThumb = (id) => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
const codecOf = (m) => { const s = String(m || '').toLowerCase();
  if (s.includes('opus')) return 'OPUS'; if (s.includes('mp4a') || s.includes('aac')) return 'AAC';
  if (s.includes('mpeg') || s.includes('mp3')) return 'MP3'; if (s.includes('vorbis')) return 'VORBIS'; return 'AUDIO'; };

function save() { try { localStorage.setItem(STORE, JSON.stringify({ favorites: state.favorites, likes: state.likes, playlists: state.playlists, settings: state.settings, vol: state.vol })); } catch (e) {} }
function load() { try { const d = JSON.parse(localStorage.getItem(STORE) || 'null'); if (!d) return;
  if (Array.isArray(d.favorites)) state.favorites = d.favorites;
  if (d.likes) state.likes = d.likes;
  if (Array.isArray(d.playlists)) state.playlists = d.playlists;
  if (d.settings) Object.assign(state.settings, d.settings);
  if (typeof d.vol === 'number') state.vol = d.vol; } catch (e) {} }

function toast(msg, type = 'info') {
  const d = document.createElement('div');
  d.className = 'toast t-' + type;
  d.innerHTML = '<i></i>' + esc(msg);
  toastsEl.append(d);
  setTimeout(() => { d.classList.add('out'); setTimeout(() => d.remove(), 280); }, 3400);
}

async function fetchJSON(url, tmo = TMO) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), tmo);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}
async function nodeFetch(pool, path) {
  const L = pool.list; let last;
  for (let k = 0; k < L.length; k++) {
    const base = L[(pool.good + k) % L.length];
    try { const data = await fetchJSON(base + path(base)); pool.good = (pool.good + k) % L.length; return { data, base }; }
    catch (e) { last = e; }
  }
  throw last || new Error('offline');
}

/* ============================================================
   ПОИСК ПО ИСТОЧНИКАМ
   ============================================================ */
const idFromUrl = (u) => { const m = String(u).match(/watch\?v=([\w-]{6,})/); return m ? m[1] : ''; };

async function searchPiped(q) {
  let items = [];
  try {
    const { data } = await nodeFetch(PIPED, () => `/search?q=${encodeURIComponent(q)}&filter=music_songs`);
    items = (data.items || []).filter((it) => it.url && it.type === 'stream');
  } catch (e) {}
  if (!items.length) {
    const { data } = await nodeFetch(PIPED, () => `/search?q=${encodeURIComponent(q)}&filter=videos`);
    items = (data.items || []).filter((it) => it.url && it.type === 'stream');
  }
  items = items.slice(0, 25);
  if (!items.length) throw new Error('empty');
  return items.map((it) => ({ source: 'piped', id: idFromUrl(it.url), title: it.title || '—', artist: it.uploaderName || '—', thumb: ytThumb(idFromUrl(it.url)), duration: it.duration > 0 ? it.duration : 0 })).filter((t) => t.id);
}

async function searchInv(q) {
  let arr = [];
  try {
    const { data } = await nodeFetch(INVIDIOUS, () => `/api/v1/search?q=${encodeURIComponent(q)}&type=music`);
    arr = Array.isArray(data) ? data : [];
  } catch (e) {}
  if (!arr.length) {
    const { data } = await nodeFetch(INVIDIOUS, () => `/api/v1/search?q=${encodeURIComponent(q)}&type=video`);
    arr = Array.isArray(data) ? data : [];
  }
  arr = arr.filter((v) => v.videoId).slice(0, 25);
  if (!arr.length) throw new Error('empty');
  return arr.map((v) => ({ source: 'invidious', id: v.videoId, title: v.title || '—', artist: v.author || '—', thumb: ytThumb(v.videoId), duration: v.lengthSeconds > 0 ? v.lengthSeconds : 0 }));
}

async function scRequest(path) {
  if (state.scPair) {
    try { return await fetchJSON(state.scPair.px(state.scPair.url)); } catch (e) { state.scPair = null; }
  }
  for (const cid of SC_IDS) for (const px of PROXIES) {
    const url = `https://api-v2.soundcloud.com${path}${path.includes('?') ? '&' : '?'}client_id=${cid}`;
    try {
      const data = await fetchJSON(px(url));
      state.scPair = { px, url: `https://api-v2.soundcloud.com${path}${path.includes('?') ? '&' : '?'}client_id=${cid}`, cid };
      return data;
    } catch (e) {}
  }
  throw new Error('sc down');
}
async function searchSC(q) {
  const d = await scRequest(`/search/tracks?q=${encodeURIComponent(q)}&limit=25`);
  const items = (d.collection || []).slice(0, 25);
  if (!items.length) throw new Error('empty');
  return items.map((t) => ({ source: 'soundcloud', id: String(t.id), title: t.title || '—', artist: t.user?.username || '—', thumb: (t.artwork_url || '').replace('-large.', '-t500x500.'), duration: Math.round((t.duration || 0) / 1000), scMedia: t.media }));
}

async function searchAudius(q) {
  if (!state.audiusHosts.length) {
    const d = await fetchJSON('https://api.audius.co/');
    state.audiusHosts = (d.data || []).slice(0, 5);
  }
  let last;
  for (const h of state.audiusHosts) {
    try {
      const d = await fetchJSON(`${h}/v1/tracks/search?query=${encodeURIComponent(q)}&limit=25&app_name=AuraX`);
      const items = (d.data || []).slice(0, 25);
      if (!items.length) throw new Error('empty');
      return items.map((t) => ({ source: 'audius', id: t.id, host: h, title: t.title || '—', artist: t.user?.name || '—', thumb: t.artwork?.['480x480'] || '', duration: t.duration || 0 }));
    } catch (e) { last = e; }
  }
  throw last || new Error('audius down');
}

async function searchArc(q) {
  const d = await fetchJSON(`https://archive.org/advancedsearch.php?q=${encodeURIComponent(q)}+AND+mediatype:(audio)&fl[]=identifier&fl[]=title&fl[]=creator&rows=20&output=json`);
  const docs = (d.response?.docs || []).slice(0, 20);
  if (!docs.length) throw new Error('empty');
  return docs.map((x) => ({ source: 'archive', id: x.identifier, title: Array.isArray(x.title) ? x.title[0] : (x.title || x.identifier), artist: Array.isArray(x.creator) ? x.creator[0] : (x.creator || 'Archive.org'), thumb: `https://archive.org/services/img/${encodeURIComponent(x.identifier)}`, duration: 0 }));
}

/* ---------- прогрессивный оркестратор ---------- */
const seen = new Set();
function appendResults(items) {
  const fresh = items.filter((t) => {
    const key = (t.source === 'piped' || t.source === 'invidious') ? 'yt:' + t.id : t.source + ':' + t.id;
    if (seen.has(key)) return false;
    seen.add(key);
    if (key.startsWith('yt:')) t.source = 'piped';
    return true;
  });
  if (!fresh.length) return;
  state.queue.push(...fresh);
  renderResults();
}

async function doSearch(raw) {
  const q = (raw || '').trim();
  if (!q) return;
  const token = ++state.searchToken;
  seen.clear();
  state.queue = []; state.current = -1;
  spin.hidden = false;
  showSkeleton();
  resMeta.textContent = 'опрашиваем источники…';

  const jobs = [];
  const src = state.source;
  const mark = (el, ok, n) => { el.textContent = ok ? `✓ ${n}` : '✗'; el.className = 'set-val ' + (ok ? 'ok' : 'bad'); };

  if (src === 'all' || src === 'yt') {
    jobs.push(searchPiped(q).then((r) => { if (token === state.searchToken) { appendResults(r); mark(stPiped, true, r.length); } }).catch(() => mark(stPiped, false)));
    jobs.push(searchInv(q).then((r) => { if (token === state.searchToken) { appendResults(r); mark(stInv, true, r.length); } }).catch(() => mark(stInv, false)));
  }
  if (src === 'all' || src === 'sc') {
    jobs.push(searchSC(q).then((r) => { if (token === state.searchToken) { appendResults(r); mark(stSc, true, r.length); } }).catch(() => mark(stSc, false)));
  }
  if (src === 'all' || src === 'audius') {
    jobs.push(searchAudius(q).then((r) => { if (token === state.searchToken) { appendResults(r); mark(stAudius, true, r.length); } }).catch(() => mark(stAudius, false)));
  }
  if (src === 'all' || src === 'arc') {
    jobs.push(searchArc(q).then((r) => { if (token === state.searchToken) { appendResults(r); mark(stArc, true, r.length); } }).catch(() => mark(stArc, false)));
  }

  await Promise.allSettled(jobs);
  if (token !== state.searchToken) return;
  spin.hidden = true;
  if (!state.queue.length) {
    resMeta.textContent = 'ничего не найдено';
    resultsEl.innerHTML = `<div class="empty"><b>По запросу «${esc(q)}» пусто</b><span>Все источники молчат. Попробуйте другой запрос или переключите источник.</span></div>`;
    toast('Ничего не найдено ни в одном источнике', 'warn');
  } else {
    resMeta.textContent = `${state.queue.length} треков · источники отвечают по мере готовности`;
    toast(`Найдено ${state.queue.length} треков`, 'ok');
  }
}

/* ============================================================
   РЕНДЕР
   ============================================================ */
function cardHTML(t, i, listId) {
  const art = t.thumb ? `<img loading="lazy" src="${esc(t.thumb)}" alt="">` : `<div class="ph">${NOTE}</div>`;
  const srcLabel = { piped: 'YT', invidious: 'YT', soundcloud: 'SC', audius: 'AUD', archive: 'ARC' }[t.source] || t.source;
  return `<article class="track" data-list="${listId}" style="--i:${Math.min(i, 24)}" data-i="${i}">
    <div class="art">${art}</div>
    <div class="tmeta"><div class="ttitle">${esc(t.title)}</div><div class="tartist">${esc(t.artist)}</div></div>
    <div class="tside"><span class="tsrc s-${t.source}">${srcLabel}</span><span class="tdur">${t.duration ? fmtTime(t.duration) : '—'}</span></div>
  </article>`;
}
function renderResults() { resultsEl.innerHTML = state.queue.map((t, i) => cardHTML(t, i, 'queue')).join(''); renderActive(); }
function renderActive() {
  $$('.track').forEach((el) => {
    const i = +el.dataset.i, list = el.dataset.list;
    let on = false;
    if (list === 'queue' && i === state.current) on = true;
    if (list === 'favs' && state.track && state.favorites[i] && state.favorites[i].id === state.track.id) on = true;
    el.classList.toggle('active', on);
  });
}
function renderFavs() {
  favsList.innerHTML = state.favorites.length
    ? state.favorites.map((t, i) => cardHTML(t, i, 'favs')).join('')
    : `<div class="empty"><b>Пока пусто</b><span>Жмите ❤️ на плеере — треки сохранятся здесь навсегда.</span></div>`;
  renderActive();
}
function renderPlaylists() {
  playlistsEl.innerHTML = state.playlists.length
    ? state.playlists.map((p, i) => `<div class="pl-card" data-pl="${esc(p.name)}"><div class="pl-icon">🎧</div><div class="pl-name">${esc(p.name)}</div><div class="pl-count">${p.tracks.length} трек(ов)</div><button class="pl-del" data-del="${i}">✕</button></div>`).join('')
    : `<div class="empty"><b>Нет плейлистов</b><span>Создайте первый — кнопка «+ Плейлист».</span></div>`;
}
function showSkeleton() {
  resultsEl.innerHTML = Array.from({ length: 7 }, (_, i) => `<div class="track skel" style="--i:${i}"><div class="sk sk-art"></div><div class="tmeta"><div class="sk sk-a"></div><div class="sk sk-b"></div></div><div class="tside"><span class="tdur">&nbsp;</span></div></div>`).join('');
}

/* ============================================================
   РЕЗОЛВ ПОТОКОВ (каскад)
   ============================================================ */
async function resolvePiped(t) {
  const { data } = await nodeFetch(PIPED, () => `/streams/${t.id}`);
  const top = (data.audioStreams || []).filter((s) => s.url && canPlay(s.mimeType)).sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0)).slice(0, 4);
  if (!top.length) throw new Error('no audio');
  return { candidates: top.map((s) => s.url), kbps: Math.round((top[0].bitrate || 130000) / 1000), codec: codecOf(top[0].mimeType), thumb: data.thumbnail || t.thumb, duration: data.duration || t.duration, title: data.title || t.title, artist: data.uploader || t.artist };
}
async function resolveInv(t) {
  const { data, base } = await nodeFetch(INVIDIOUS, () => `/api/v1/videos/${t.id}?local=true`);
  const top = (data.adaptiveFormats || []).filter((f) => f.url && (f.type || '').startsWith('audio') && canPlay(f.type)).sort((a, b) => (+b.bitrate || 0) - (+a.bitrate || 0)).slice(0, 4);
  if (top.length) return { candidates: top.map((f) => f.url), kbps: Math.round((+top[0].bitrate || 130000) / 1000), codec: codecOf(top[0].type), thumb: t.thumb, duration: data.lengthSeconds || t.duration, title: data.title || t.title, artist: data.author || t.artist };
  return { candidates: [`${base}/latest_version?id=${t.id}&itag=251`], kbps: 160, codec: 'OPUS', thumb: t.thumb, duration: t.duration, title: t.title, artist: t.artist };
}
async function resolveYouTube(t) {
  try { return await resolvePiped(t); } catch (e) {}
  try { return await resolveInv(t); } catch (e) {}
  return { candidates: INVIDIOUS.list.slice(0, 3).map((b) => `${b}/latest_version?id=${t.id}&itag=251`), kbps: 160, codec: 'OPUS', thumb: t.thumb, duration: t.duration, title: t.title, artist: t.artist };
}
async function resolveSC(t) {
  const tr = t.scMedia?.transcodings || [];
  const prog = tr.find((x) => x.format?.protocol === 'progressive') || tr[0];
  if (!prog) throw new Error('no transcoding');
  const sep = prog.url.includes('?') ? '&' : '?';
  const url = state.scPair ? state.scPair.px(prog.url + sep + 'client_id=' + state.scPair.cid) : PROXIES[0](prog.url + sep + 'client_id=' + SC_IDS[0]);
  const meta = await fetchJSON(url);
  if (!meta?.url) throw new Error('no stream');
  return { candidates: [meta.url], kbps: 128, codec: 'MP3', thumb: t.thumb, duration: t.duration, title: t.title, artist: t.artist };
}
async function resolveAudius(t) {
  const hosts = state.audiusHosts.length ? state.audiusHosts : [t.host];
  return { candidates: hosts.map((h) => `${h}/v1/tracks/${t.id}/stream?app_name=AuraX`), kbps: 320, codec: 'MP3', thumb: t.thumb, duration: t.duration, title: t.title, artist: t.artist };
}
async function resolveArc(t) {
  const d = await fetchJSON(`https://archive.org/metadata/${encodeURIComponent(t.id)}`);
  const mp3 = (d.files || []).find((f) => /\.mp3$/i.test(f.name));
  if (!mp3) throw new Error('no mp3');
  return { candidates: [`https://archive.org/download/${encodeURIComponent(t.id)}/${encodeURIComponent(mp3.name)}`], kbps: 192, codec: 'MP3', thumb: t.thumb, duration: t.duration, title: t.title, artist: t.artist };
}
const resolveStream = (t) =>
  t.source === 'soundcloud' ? resolveSC(t) :
  t.source === 'audius' ? resolveAudius(t) :
  t.source === 'archive' ? resolveArc(t) :
  resolveYouTube(t);

/* ============================================================
   ВОСПРОИЗВЕДЕНИЕ (двойной audio-элемент = анти-CORS-фолбэк)
   ============================================================ */
async function playIndex(i, listId = 'queue') {
  const list = listId === 'favs' ? state.favorites : state.queue;
  const t = list[i];
  if (!t) return;
  if (listId === 'favs') { state.queue = [...state.favorites]; }
  state.current = listId === 'favs' ? i : i;
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
    pillSrc.textContent = { piped: 'YOUTUBE · PIPED', invidious: 'YOUTUBE · INV', soundcloud: 'SOUNDCLOUD', audius: 'AUDIUS · 320', archive: 'ARCHIVE.ORG' }[t.source];
    pillSrc.hidden = false;
    pillQ.textContent = r.kbps ? `${r.kbps} kbps · ${r.codec}` : r.codec;
    pillQ.hidden = false;
    if (r.duration) t.duration = r.duration;
    setCover(r.thumb || t.thumb, t);
    setMediaSession(r);
    updateFav();
    state.candidates = r.candidates; state.cand = 0;
    initAudioGraph();
    startStream(r.candidates[0]);
  } catch (e) {
    if (token !== state.playToken) return;
    btnPlay.classList.remove('loading');
    toast('Не удалось получить поток. Попробуйте другой трек.', 'err');
  }
}

function startStream(url) {
  state.currentUrl = url;
  state.usingMain = true;
  aSafe.pause(); aSafe.removeAttribute('src'); aSafe.load();
  aMain.src = url; aMain.load();
  syncProps();
  if (actx?.state === 'suspended') actx.resume();
  aMain.play().catch((e) => { if (e?.name !== 'NotAllowedError') fallbackSafe(url); });
}
function fallbackSafe(url) {
  if (!state.usingMain) return;
  state.usingMain = false;
  aMain.pause();
  aSafe.src = url; aSafe.load();
  syncProps();
  aSafe.play().catch(() => { tryNext(); });
  toast('Поток без CORS — включён совместимый режим', 'warn');
}
function tryNext() {
  if (state.cand < state.candidates.length - 1) {
    state.cand++;
    toast('Поток оборван — резервный сервер…', 'warn');
    startStream(state.candidates[state.cand]);
  } else {
    btnPlay.classList.remove('loading');
    toast('Все резервные потоки недоступны.', 'err');
  }
}
[aMain, aSafe].forEach((el) => {
  el.addEventListener('error', () => {
    if (el === aMain && state.usingMain && state.currentUrl) fallbackSafe(state.currentUrl);
    else if (el === aSafe && !state.usingMain) tryNext();
  });
});

function setCover(src, t) {
  if (src) {
    artWrap.classList.remove('noart');
    cover.onerror = () => { cover.onerror = null; if (t.id && (t.source === 'piped' || t.source === 'invidious')) cover.src = ytThumb(t.id); };
    if ((t.source === 'piped' || t.source === 'invidious') && t.id) {
      cover.src = `https://i.ytimg.com/vi/${t.id}/maxresdefault.jpg`;
      cover.onerror = () => { cover.onerror = null; cover.src = ytThumb(t.id); };
    } else cover.src = src;
    tintFrom(cover);
  } else {
    artWrap.classList.add('noart');
    cover.removeAttribute('src');
  }
}

/* динамический фон под обложку */
function tintFrom(img) {
  const apply = () => {
    try {
      const c = document.createElement('canvas'); c.width = c.height = 24;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(img, 0, 0, 24, 24);
      const d = g.getImageData(0, 0, 24, 24).data;
      let best = null, bs = -1;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] < 200) continue;
        const r = d[i], gg = d[i + 1], b = d[i + 2];
        const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b);
        const score = ((mx - mn) / 255) * 1.4 + (mx / 255) * .6;
        if (score > bs) { bs = score; best = [r, gg, b]; }
      }
      if (best) document.documentElement.style.setProperty('--dyn-rgb', best.join(','));
    } catch (e) {}
  };
  if (img.complete && img.naturalWidth) apply();
  else img.addEventListener('load', apply, { once: true });
}

function togglePlay() {
  if (state.current < 0) {
    if (state.queue.length) return playIndex(0);
    switchTab('search'); qInput.focus();
    toast('Сначала найдите трек.', 'info');
    return;
  }
  if (A().paused) A().play().catch(() => {});
  else A().pause();
}
function nextIndex(dir = 1) {
  const n = state.queue.length;
  if (!n) return -1;
  if (state.shuffle && n > 1) { let r; do { r = Math.floor(Math.random() * n); } while (r === state.current); return r; }
  let i = state.current + dir;
  if (i >= n) return state.repeat >= 1 ? 0 : -1;
  if (i < 0) i = n - 1;
  return i;
}
const playNext = () => { const i = nextIndex(1); if (i >= 0) playIndex(i); };
const playPrev = () => { if (A().currentTime > 3) { A().currentTime = 0; return; } const i = nextIndex(-1); if (i >= 0) playIndex(i); };
const getDuration = () => { const d = A().duration; return (isFinite(d) && d > 0) ? d : (state.track?.duration || 0); };

/* ============================================================
   WEB AUDIO: bass + reverb + analyser
   ============================================================ */
let actx = null, srcNode, bassFilter, dryGain, wetGain, convolver, masterGain, analyser, graphReady = false;

function buildImpulse() {
  const dur = 2.4, rate = actx.sampleRate, len = Math.floor(rate * dur);
  const buf = actx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2);
  }
  convolver.buffer = buf;
}
function initAudioGraph() {
  if (graphReady) return;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    actx = new AC();
    srcNode = actx.createMediaElementSource(aMain);
    bassFilter = actx.createBiquadFilter(); bassFilter.type = 'lowshelf'; bassFilter.frequency.value = 100;
    dryGain = actx.createGain(); wetGain = actx.createGain(); wetGain.gain.value = 0;
    convolver = actx.createConvolver(); buildImpulse();
    masterGain = actx.createGain();
    analyser = actx.createAnalyser(); analyser.fftSize = 128; analyser.smoothingTimeConstant = .82;
    srcNode.connect(bassFilter);
    bassFilter.connect(dryGain).connect(masterGain);
    bassFilter.connect(convolver).connect(wetGain).connect(masterGain);
    masterGain.connect(analyser).connect(actx.destination);
    graphReady = true;
    applySettings();
    requestAnimationFrame(drawViz);
  } catch (e) {}
}
function applySettings() {
  const s = state.settings;
  [aMain, aSafe].forEach((el) => {
    el.playbackRate = s.rate;
    el.preservesPitch = s.preservePitch;
    try { el.mozPreservesPitch = s.preservePitch; el.webkitPreservesPitch = s.preservePitch; } catch (e) {}
    el.volume = state.muted ? 0 : state.vol;
  });
  if (graphReady) {
    bassFilter.gain.setTargetAtTime(s.bassOn ? s.bass : 0, actx.currentTime, .05);
    wetGain.gain.setTargetAtTime(s.reverb, actx.currentTime, .05);
    dryGain.gain.setTargetAtTime(1 - s.reverb * .3, actx.currentTime, .05);
    masterGain.gain.setTargetAtTime(state.muted ? 0 : state.vol, actx.currentTime, .03);
  }
  vizEl.classList.toggle('hidden', !s.vizOn);
}

/* ---------- визуализатор ---------- */
const BARS = 44, smooth = new Float32Array(BARS);
let freq = null;
function drawViz() {
  requestAnimationFrame(drawViz);
  if (!state.settings.vizOn) return;
  const w = vizEl.width, h = vizEl.height;
  vctx.clearRect(0, 0, w, h);
  const targets = new Float32Array(BARS);
  if (graphReady && analyser && state.usingMain && !A().paused) {
    if (!freq) freq = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(freq);
    const usable = Math.floor(freq.length * .75);
    for (let i = 0; i < BARS; i++) targets[i] = freq[Math.min(usable - 1, Math.floor(Math.pow(i / BARS, 1.6) * usable))] / 255;
  }
  for (let i = 0; i < BARS; i++) smooth[i] += (targets[i] - smooth[i]) * .25;
  const cs = getComputedStyle(document.documentElement);
  const grad = vctx.createLinearGradient(0, h, 0, 0);
  grad.addColorStop(0, cs.getPropertyValue('--acc2').trim());
  grad.addColorStop(1, cs.getPropertyValue('--acc').trim());
  vctx.fillStyle = grad;
  const gap = w / BARS, bw = Math.max(2, gap * .5);
  for (let i = 0; i < BARS; i++) {
    const bh = Math.max(2, smooth[i] * h * .9);
    vctx.beginPath();
    vctx.roundRect(i * gap + (gap - bw) / 2, h - bh, bw, bh, bw / 2);
    vctx.fill();
  }
}

/* ---------- события аудио ---------- */
[aMain, aSafe].forEach((el) => {
  el.addEventListener('play', () => {
    if (el !== A()) return;
    document.body.classList.add('playing');
    btnPlay.classList.remove('loading');
    icoPlay.hidden = true; icoPause.hidden = false;
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
  });
  el.addEventListener('pause', () => {
    if (el !== A()) return;
    document.body.classList.remove('playing');
    icoPlay.hidden = false; icoPause.hidden = true;
  });
  el.addEventListener('timeupdate', () => {
    if (el !== A()) return;
    const d = getDuration();
    tDur.textContent = fmtTime(d);
    if (!state.dragging && d > 0) {
      const p = (el.currentTime / d) * 100;
      seekFill.style.width = p + '%'; seekThumb.style.left = p + '%';
    }
    tCur.textContent = fmtTime(el.currentTime);
  });
  el.addEventListener('progress', () => {
    if (el !== A() || !el.buffered.length || !el.duration) return;
    seekBuffer.style.width = ((el.buffered.end(el.buffered.length - 1) / el.duration) * 100) + '%';
  });
  el.addEventListener('ended', () => {
    if (el !== A()) return;
    if (state.repeat === 2) { el.currentTime = 0; el.play().catch(() => {}); return; }
    playNext();
  });
});

function setMediaSession(r) {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({ title: r.title, artist: r.artist, album: 'AURA X', artwork: r.thumb ? [{ src: r.thumb, sizes: '480x480' }] : [] });
    navigator.mediaSession.setActionHandler('play', () => A().play());
    navigator.mediaSession.setActionHandler('pause', () => A().pause());
    navigator.mediaSession.setActionHandler('previoustrack', playPrev);
    navigator.mediaSession.setActionHandler('nexttrack', playNext);
  } catch (e) {}
}

/* ============================================================
   UI
   ============================================================ */
btnPlay.addEventListener('click', togglePlay);
btnNext.addEventListener('click', playNext);
btnPrev.addEventListener('click', playPrev);
btnShuffle.addEventListener('click', () => { state.shuffle = !state.shuffle; btnShuffle.classList.toggle('on', state.shuffle); });
btnRepeat.addEventListener('click', () => {
  state.repeat = (state.repeat + 1) % 3;
  btnRepeat.classList.toggle('on', state.repeat > 0);
  repBadge.textContent = state.repeat === 2 ? '1' : '';
  toast(['Повтор выкл', 'Повтор всех', 'Повтор одного'][state.repeat], 'info');
});
muteBtn.addEventListener('click', () => {
  state.muted = !state.muted;
  applySettings();
  icoVol.hidden = state.muted; icoMute.hidden = !state.muted;
});

/* сегменты FX (Lane) */
$$('.seg-btn').forEach((b) => b.addEventListener('click', () => {
  $$('.seg-btn').forEach((x) => x.classList.remove('active'));
  b.classList.add('active');
  const s = state.settings;
  if (b.dataset.fx === 'orig') { s.rate = 1; s.preservePitch = true; s.reverb = 0; }
  if (b.dataset.fx === 'speed') { s.rate = 1.25; s.preservePitch = true; s.reverb = 0; }
  if (b.dataset.fx === 'slowed') { s.rate = .85; s.preservePitch = false; s.reverb = .35; }
  refreshSoundUI(); applySettings(); save();
}));

/* слайдеры-полоски (pointer) */
function makeSlider(el, fillEl, thumbEl, onChange, onDone) {
  let drag = false;
  const upd = (x) => {
    const r = el.getBoundingClientRect();
    const p = Math.max(0, Math.min(1, (x - r.left) / r.width));
    fillEl.style.width = (p * 100) + '%'; thumbEl.style.left = (p * 100) + '%';
    onChange(p);
  };
  el.addEventListener('pointerdown', (e) => { drag = true; el.setPointerCapture(e.pointerId); upd(e.clientX); });
  el.addEventListener('pointermove', (e) => { if (drag) upd(e.clientX); });
  const up = () => { if (drag) { drag = false; onDone && onDone(); } };
  el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
}
makeSlider(seekbar, seekFill, seekThumb, (p) => {
  state.dragging = true;
  const d = getDuration();
  if (d > 0) { try { A().currentTime = p * d; } catch (e) {} tCur.textContent = fmtTime(p * d); }
}, () => { state.dragging = false; });
makeSlider(volbar, volFill, volThumb, (p) => {
  state.vol = p;
  if (state.muted && p > 0) { state.muted = false; icoVol.hidden = false; icoMute.hidden = true; }
  applySettings(); save();
});

/* лайки */
function updateFav() {
  const t = state.track;
  const liked = t && state.favorites.some((f) => f.id === t.id && f.source === t.source);
  btnFav.classList.toggle('on', !!liked);
  likeCount.textContent = t ? (state.likes[t.id] || 0) : 0;
}
btnFav.addEventListener('click', () => {
  const t = state.track;
  if (!t) return toast('Сначала включите трек', 'info');
  const idx = state.favorites.findIndex((f) => f.id === t.id && f.source === t.source);
  if (idx >= 0) {
    state.favorites.splice(idx, 1);
    state.likes[t.id] = Math.max(0, (state.likes[t.id] || 1) - 1);
    toast('Убрано из избранного', 'info');
  } else {
    state.favorites.unshift({ ...t });
    state.likes[t.id] = (state.likes[t.id] || 0) + 1;
    toast('Добавлено в избранное ❤️', 'ok');
  }
  updateFav(); renderFavs(); save();
});
btnAddPl.addEventListener('click', () => {
  const t = state.track;
  if (!t) return toast('Сначала включите трек', 'info');
  if (!state.playlists.length) return toast('Создайте плейлист в Медиатеке', 'info');
  const name = prompt('В какой плейлист? (' + state.playlists.map((p) => p.name).join(', ') + ')');
  const pl = state.playlists.find((p) => p.name.toLowerCase() === (name || '').toLowerCase());
  if (!pl) return toast('Плейлист не найден', 'warn');
  if (pl.tracks.some((x) => x.id === t.id)) return toast('Уже в плейлисте', 'info');
  pl.tracks.push({ ...t });
  renderPlaylists(); save();
  toast(`Добавлено в «${pl.name}»`, 'ok');
});
btnShare.addEventListener('click', async () => {
  const t = state.track;
  if (!t) return;
  const text = `${t.title} — ${t.artist} · AURA X`;
  try { await navigator.share({ title: text, url: state.currentUrl || location.href }); }
  catch (e) { try { await navigator.clipboard.writeText(text); toast('Скопировано в буфер', 'ok'); } catch (e2) {} }
});
btnDl.addEventListener('click', () => {
  if (!state.currentUrl) return toast('Сначала включите трек', 'info');
  const a = document.createElement('a');
  a.href = state.currentUrl; a.target = '_blank'; a.rel = 'noopener';
  document.body.append(a); a.click(); a.remove();
  toast('Открываю прямой поток для скачивания', 'info');
});

/* поиск */
const debSearch = debounce(() => doSearch(qInput.value), 550);
qInput.addEventListener('input', () => { if (qInput.value.trim()) debSearch(); });
qInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(qInput.value); });
$$('.chip').forEach((c) => c.addEventListener('click', () => {
  $$('.chip').forEach((x) => x.classList.remove('active'));
  c.classList.add('active');
  qInput.value = c.dataset.mood;
  doSearch(qInput.value);
}));
$$('.src-btn').forEach((b) => b.addEventListener('click', () => {
  $$('.src-btn').forEach((x) => x.classList.remove('active'));
  b.classList.add('active');
  state.source = b.dataset.src;
}));
function trackClick(e) {
  const card = e.target.closest('.track');
  if (!card || card.classList.contains('skel')) return;
  const i = +card.dataset.i, list = card.dataset.list;
  if (list === 'favs') playIndex(i, 'favs');
  else { if (i === state.current) togglePlay(); else playIndex(i, 'queue'); }
}
resultsEl.addEventListener('click', trackClick);
favsList.addEventListener('click', trackClick);

/* медиатека */
$('#btnNewPl').addEventListener('click', () => {
  const name = (prompt('Название плейлиста:') || '').trim();
  if (!name) return;
  if (state.playlists.some((p) => p.name === name)) return toast('Такой уже есть', 'warn');
  state.playlists.push({ name, tracks: [] });
  renderPlaylists(); save();
  toast(`Плейлист «${name}» создан`, 'ok');
});
playlistsEl.addEventListener('click', (e) => {
  const del = e.target.closest('.pl-del');
  if (del) {
    const i = +del.dataset.del;
    state.playlists.splice(i, 1);
    renderPlaylists(); save();
    return;
  }
  const card = e.target.closest('.pl-card');
  if (!card) return;
  const pl = state.playlists.find((p) => p.name === card.dataset.pl);
  if (!pl || !pl.tracks.length) return toast('Плейлист пуст', 'info');
  state.queue = [...pl.tracks];
  state.current = -1;
  renderResults();
  switchTab('player');
  playIndex(0);
});

/* табы */
function switchTab(name) {
  $$('.screen').forEach((s) => s.classList.toggle('active', s.dataset.screen === name));
  $$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.nav === name));
  if (name === 'library') { renderPlaylists(); renderFavs(); }
}
$$('.nav-btn').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.nav)));

/* ---------- настройки ---------- */
function paintRange(el) {
  const min = +el.min || 0, max = +el.max || 100;
  el.style.setProperty('--p', (((+el.value - min) / (max - min)) * 100) + '%');
}
function refreshSoundUI() {
  const s = state.settings;
  rateSlider.value = s.rate; rateVal.textContent = '×' + s.rate.toFixed(2); paintRange(rateSlider);
  reverbSlider.value = s.reverb; reverbVal.textContent = Math.round(s.reverb * 100) + '%'; paintRange(reverbSlider);
  bassSlider.value = s.bass; bassVal.textContent = '+' + s.bass.toFixed(1) + ' dB'; paintRange(bassSlider);
  $$('[data-k]').forEach((t) => t.classList.toggle('on', !!s[t.dataset.k]));
}
rateSlider.addEventListener('input', () => { state.settings.rate = +rateSlider.value; rateVal.textContent = '×' + state.settings.rate.toFixed(2); paintRange(rateSlider); applySettings(); save(); });
reverbSlider.addEventListener('input', () => { state.settings.reverb = +reverbSlider.value; reverbVal.textContent = Math.round(state.settings.reverb * 100) + '%'; paintRange(reverbSlider); applySettings(); save(); });
bassSlider.addEventListener('input', () => { state.settings.bass = +bassSlider.value; bassVal.textContent = '+' + state.settings.bass.toFixed(1) + ' dB'; paintRange(bassSlider); applySettings(); save(); });
$$('.toggle').forEach((t) => t.addEventListener('click', () => {
  const k = t.dataset.k;
  state.settings[k] = !state.settings[k];
  t.classList.toggle('on', state.settings[k]);
  applySettings(); save();
}));
$$('.theme').forEach((b) => b.addEventListener('click', () => {
  state.settings.theme = b.dataset.theme;
  refreshStyleUI(); save();
}));
$$('.style-btn').forEach((b) => b.addEventListener('click', () => {
  state.settings.disc = b.dataset.disc;
  refreshStyleUI(); save();
}));
blurSlider.addEventListener('input', () => { state.settings.blur = +blurSlider.value; blurVal.textContent = state.settings.blur + ' px'; paintRange(blurSlider); document.documentElement.style.setProperty('--blur-bg', state.settings.blur + 'px'); save(); });
dimSlider.addEventListener('input', () => { state.settings.dim = +dimSlider.value; dimVal.textContent = state.settings.dim + '%'; paintRange(dimSlider); document.documentElement.style.setProperty('--dim-bg', (state.settings.dim / 100).toFixed(2)); save(); });
btnUploadWall.addEventListener('click', () => wallInput.click());
wallInput.addEventListener('change', () => {
  const f = wallInput.files[0];
  if (!f) return;
  if (f.size > 5 * 1024 * 1024) return toast('Максимум 5 MB', 'warn');
  const r = new FileReader();
  r.onload = () => { state.settings.wallpaper = r.result; refreshStyleUI(); save(); toast('Обои применены', 'ok'); };
  r.readAsDataURL(f);
  wallInput.value = '';
});
btnResetWall.addEventListener('click', () => { state.settings.wallpaper = null; refreshStyleUI(); save(); });

function refreshStyleUI() {
  const s = state.settings;
  document.documentElement.dataset.theme = s.theme;
  $$('.theme').forEach((b) => b.classList.toggle('active', b.dataset.theme === s.theme));
  $$('.style-btn').forEach((b) => b.classList.toggle('active', b.dataset.disc === s.disc));
  artWrap.className = 'art-wrap ' + s.disc + (artWrap.classList.contains('noart') ? ' noart' : '');
  document.documentElement.style.setProperty('--blur-bg', s.blur + 'px');
  document.documentElement.style.setProperty('--dim-bg', (s.dim / 100).toFixed(2));
  if (s.wallpaper) { wallpaper.style.backgroundImage = `url(${s.wallpaper})`; btnResetWall.hidden = false; }
  else { wallpaper.style.backgroundImage = ''; btnResetWall.hidden = true; }
}

/* ---------- клавиатура ---------- */
document.addEventListener('keydown', (e) => {
  if (/INPUT|TEXTAREA/.test(document.activeElement?.tagName || '')) return;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  else if (e.code === 'KeyM') muteBtn.click();
});

/* ---------- старт ---------- */
(function init() {
  load();
  refreshSoundUI();
  refreshStyleUI();
  renderFavs(); renderPlaylists();
  resultsEl.innerHTML = `<div class="empty"><b>Поиск по 5 источникам</b><span>YouTube (Piped+Invidious), SoundCloud, Audius и Archive.org работают каскадом. Результаты появляются по мере ответа — быстро и без VPN.</span></div>`;
  toast('AURA X готов. Ищите и включайте!', 'ok');
})();