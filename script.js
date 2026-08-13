'use strict';
/* ============================================================
   AURA X — движок плеера
   Источники: Piped (авто-фолбэк нод) → Invidious → iTunes
   Выбор потока с максимальным доступным битрейтом.
   ============================================================ */

/* ---------------- КОНФИГ НОД ----------------
   Списки можно дополнять: инстансы меняются, фолбэк сам
   переберёт список и запомнит первую живую ноду. */
const NODES = {
  piped: {
    good: 0,
    list: [
      'https://pipedapi.kavin.rocks',
      'https://pipedapi.adminforge.de',
      'https://pipedapi.reallyaweso.me',
      'https://api.piped.private.coffee',
      'https://pipedapi.ducks.party',
      'https://pipedapi.leptons.xyz',
      'https://pipedapi.drgns.space'
    ]
  },
  inv: {
    good: 0,
    list: [
      'https://invidious.nerdvpn.de',
      'https://inv.nadeko.net',
      'https://yewtu.be',
      'https://invidious.f5.si',
      'https://iv.melmac.space',
      'https://invidious.jing.rocks',
      'https://invidious.privacyredirect.com'
    ]
  }
};
const FETCH_TIMEOUT = 9000;
const SLOWED_RATE = 0.85;

/* ---------------- СОСТОЯНИЕ ---------------- */
const state = {
  queue: [],
  current: -1,
  activeTrack: null,
  currentUrl: null,
  playingAudio: false,
  usingMain: true,        // aMain (Web Audio) / aSafe (без CORS)
  shuffle: false,
  repeat: 0,              // 0 выкл · 1 все · 2 один
  volume: 0.8,
  muted: false,
  dragging: false,
  fx: { speedOn: false, speed: 1.25, slowOn: false, reverb: 0.45 },
  vizColors: ['#00f2fe', '#c46bff']
};

/* ---------------- DOM ---------------- */
const $ = (s) => document.querySelector(s);
const aMain = $('#aMain'), aSafe = $('#aSafe');
const A = () => state.usingMain ? aMain : aSafe;
const searchInput = $('#searchInput'), searchClear = $('#searchClear'), searchSpin = $('#searchSpin');
const resultsEl = $('#results'), resultsMeta = $('#resultsMeta'), chipsEl = $('#chips');
const cover = $('#cover'), disc = $('#disc');
const npTitle = $('#npTitle'), npArtist = $('#npArtist'), npSource = $('#npSource'), npQuality = $('#npQuality');
const viz = $('#viz'), vctx = viz.getContext('2d');
const seek = $('#seek'), tCur = $('#tCur'), tDur = $('#tDur');
const btnPlay = $('#btnPlay'), icoPlay = $('#icoPlay'), icoPause = $('#icoPause');
const btnPrev = $('#btnPrev'), btnNext = $('#btnNext'), btnShuffle = $('#btnShuffle'), btnRepeat = $('#btnRepeat'), repBadge = $('#repBadge');
const btnMute = $('#btnMute'), icoVol = $('#icoVol'), icoMute = $('#icoMute'), volume = $('#volume');
const fxSpeed = $('#fxSpeed'), fxSpeedVal = $('#fxSpeedVal'), fxSpeedOut = $('#fxSpeedOut');
const fxSlow = $('#fxSlow'), fxReverb = $('#fxReverb'), fxReverbOut = $('#fxReverbOut');
const rowSpeed = $('#rowSpeed'), rowSlow = $('#rowSlow'), fxReset = $('#fxReset');
const uploadBtn = $('#uploadBtn'), fileInput = $('#fileInput');
const toastsEl = $('#toasts');

const ICON_NOTE = '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg>';
const CHIPS = ['Фонк 2025', 'The Weeknd', 'Lo-Fi Beats', 'Скриптонит', 'Daft Punk', 'Synthwave', 'Дора'];

/* ---------------- УТИЛИТЫ ---------------- */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = (s) => {
  if (!isFinite(s) || s <= 0) return '0:00';
  const m = Math.floor(s / 60), ss = Math.floor(s % 60);
  return m + ':' + String(ss).padStart(2, '0');
};
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const hostOf = (base) => { try { return new URL(base).host; } catch { return base; } };
const fixUrl = (u) => !u ? '' : (u.startsWith('//') ? 'https:' + u : u);
const paintRange = (el) => {
  const min = +el.min || 0, max = +el.max || 100;
  el.style.setProperty('--p', (((+el.value - min) / (max - min)) * 100) + '%');
};

function toast(msg, type = 'info') {
  const d = document.createElement('div');
  d.className = 'toast t-' + type;
  d.innerHTML = '<i></i>' + esc(msg);
  toastsEl.append(d);
  setTimeout(() => { d.classList.add('out'); setTimeout(() => d.remove(), 320); }, 3800);
}

async function fetchJSON(url, timeout = FETCH_TIMEOUT) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

let jsonpN = 0;
function jsonp(url, timeout = FETCH_TIMEOUT) {
  return new Promise((res, rej) => {
    const cb = '__aura_cb' + (++jsonpN);
    const s = document.createElement('script');
    const timer = setTimeout(() => { cleanup(); rej(new Error('jsonp timeout')); }, timeout);
    function cleanup() { clearTimeout(timer); delete window[cb]; s.remove(); }
    window[cb] = (data) => { cleanup(); res(data); };
    s.src = url + '&callback=' + cb;
    s.onerror = () => { cleanup(); rej(new Error('jsonp error')); };
    document.head.append(s);
  });
}

/* ---------------- ФОЛБЭК ПО НОДАМ ---------------- */
async function nodeFetch(pool, pathFn) {
  const L = pool.list, order = [];
  for (let k = 0; k < L.length; k++) order.push(L[(pool.good + k) % L.length]);
  let lastErr;
  for (const base of order) {
    try {
      const data = await fetchJSON(base + pathFn(base));
      pool.good = L.indexOf(base);
      return { data, base };
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('нет доступных нод');
}

function setSrc(name, ok, host) {
  const map = { piped: ['dotPiped', 'hostPiped'], inv: ['dotInv', 'hostInv'], itunes: ['dotItunes', 'hostItunes'] };
  const [d, h] = map[name];
  const dot = $('#' + d), el = $('#' + h);
  dot.className = 'dot ' + (ok ? 'ok' : 'err');
  if (host) el.textContent = host;
  else if (!ok) el.textContent = 'недоступно';
}

/* ---------------- ПРОВАЙДЕРЫ ПОИСКА ---------------- */
const canPlay = (mime) => {
  if (!mime) return false;
  return aMain.canPlayType(mime.split(';')[0]) !== '';
};

async function searchPiped(q) {
  const { data, base } = await nodeFetch(NODES.piped, (b) => `/search?q=${encodeURIComponent(q)}&filter=music_songs`);
  const items = (data.items || []).filter((it) => it.url && it.type === 'stream').slice(0, 24);
  if (!items.length) throw new Error('пусто');
  setSrc('piped', true, hostOf(base));
  return items.map((it) => ({
    source: 'piped',
    id: idFromUrl(it.url),
    title: it.title || 'Без названия',
    artist: it.uploaderName || '—',
    thumb: fixUrl(it.thumbnail),
    duration: it.duration > 0 ? it.duration : 0
  })).filter((t) => t.id);
}

async function searchInv(q) {
  const { data, base } = await nodeFetch(NODES.inv, (b) => `/api/v1/search?q=${encodeURIComponent(q)}&type=music`);
  const arr = Array.isArray(data) ? data.filter((v) => v.videoId).slice(0, 24) : [];
  if (!arr.length) throw new Error('пусто');
  setSrc('inv', true, hostOf(base));
  return arr.map((v) => ({
    source: 'invidious',
    id: v.videoId,
    title: v.title || 'Без названия',
    artist: v.author || '—',
    thumb: `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
    duration: v.lengthSeconds > 0 ? v.lengthSeconds : 0
  }));
}

async function searchItunes(q) {
  const d = await jsonp(`https://itunes.apple.com/search?media=music&entity=song&limit=24&term=${encodeURIComponent(q)}`);
  const rs = (d.results || []).filter((r) => r.previewUrl);
  if (!rs.length) throw new Error('пусто');
  setSrc('itunes', true, 'itunes.apple.com');
  return rs.map((r) => ({
    source: 'itunes',
    id: String(r.trackId),
    title: r.trackName || 'Без названия',
    artist: r.artistName || '—',
    thumb: (r.artworkUrl100 || '').replace('100x100', '600x600'),
    duration: Math.round((r.trackTimeMillis || 0) / 1000),
    preview: r.previewUrl
  }));
}

const idFromUrl = (u) => {
  const m = String(u).match(/watch\?v=([\w-]{6,})/);
  return m ? m[1] : String(u).replace(/[^A-Za-z0-9_-]/g, '');
};

/* ---------------- ОРКЕСТРАЦИЯ ПОИСКА ---------------- */
async function doSearch(q) {
  q = (q || '').trim();
  if (!q) return;
  showSkeleton();
  searchSpin.hidden = false;
  resultsMeta.textContent = 'опрашиваем ноды Piped / Invidious / iTunes…';

  const settled = await Promise.allSettled([searchPiped(q), searchInv(q), searchItunes(q)]);
  const names = ['piped', 'inv', 'itunes'];
  settled.forEach((s, i) => { if (s.status === 'rejected') setSrc(names[i], false); });

  let tracks = null, srcName = '';
  const labels = ['Piped', 'Invidious', 'iTunes'];
  for (let i = 0; i < settled.length; i++) {
    const s = settled[i];
    if (s.status === 'fulfilled' && s.value.length) { tracks = s.value; srcName = labels[i]; break; }
  }

  searchSpin.hidden = true;
  if (!tracks) { renderEmpty(q); return; }
  state.queue = tracks;
  state.current = -1;
  renderResults(tracks, srcName);
  toast(`Найдено ${tracks.length} треков · источник: ${srcName}`, 'ok');
}

/* ---------------- РЕНДЕР СПИСКА ---------------- */
function cardHTML(t, i) {
  const pill = t.source === 'itunes' ? 'PREVIEW' : t.source === 'local' ? 'LOCAL' : 'STREAM';
  const art = t.thumb
    ? `<img loading="lazy" src="${esc(t.thumb)}" alt="">`
    : `<div class="t-art-fallback">${ICON_NOTE}</div>`;
  return `<article class="track" style="--i:${Math.min(i, 20)}" data-i="${i}">
    <div class="t-idx"><span class="n">${i + 1}</span><span class="eq"><i></i><i></i><i></i></span></div>
    <div class="t-art">${art}</div>
    <div class="t-meta">
      <div class="t-title">${esc(t.title)}</div>
      <div class="t-artist">${esc(t.artist)}</div>
    </div>
    <div class="t-side">
      <span class="pill pill-${t.source}">${pill}</span>
      <span class="t-dur">${t.duration ? fmtTime(t.duration) : '—'}</span>
    </div>
  </article>`;
}

function renderResults(tracks, srcName) {
  resultsMeta.textContent = `${tracks.length} треков · ${srcName} · авто-макс. битрейт`;
  resultsEl.innerHTML = tracks.map(cardHTML).join('');
  renderActive();
}

function showSkeleton() {
  resultsMeta.textContent = 'загрузка…';
  resultsEl.innerHTML = Array.from({ length: 8 }, (_, i) => `
    <div class="track skel" style="--i:${i}">
      <div class="t-idx"><span class="n">&nbsp;</span></div>
      <div class="sk sk-art"></div>
      <div class="t-meta"><div class="sk sk-l1"></div><div class="sk sk-l2"></div></div>
      <div class="t-side"><span class="t-dur">&nbsp;</span></div>
    </div>`).join('');
}

function renderEmpty(q) {
  resultsMeta.textContent = 'ничего не найдено';
  resultsEl.innerHTML = `<div class="empty-state">
    <svg viewBox="0 0 24 24" width="44" height="44" fill="currentColor"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg>
    <b>По запросу «${esc(q)}» пусто</b>
    <span>Все ноды не ответили или ничего не нашли. Попробуйте другой запрос — например, имя исполнителя на английском, или загрузите свой .mp3.</span>
  </div>`;
}

function renderActive() {
  resultsEl.querySelectorAll('.track').forEach((el) => {
    el.classList.toggle('active', +el.dataset.i === state.current);
  });
}

/* ---------------- РЕЗОЛВ ПОТОКА (МАКС. БИТРЕЙТ) ---------------- */
const codecOf = (mime) => {
  const m = String(mime || '').toLowerCase();
  if (m.includes('opus')) return 'OPUS';
  if (m.includes('mp4a') || m.includes('aac')) return 'AAC';
  if (m.includes('mpeg')) return 'MP3';
  if (m.includes('vorbis') || m.includes('ogg')) return 'VORBIS';
  return 'AUDIO';
};

async function resolveStream(t) {
  if (t.source === 'local') return { url: t.url, kbps: 0, codec: 'LOCAL FILE' };
  if (t.source === 'itunes') return { url: t.preview, kbps: 128, codec: 'AAC · превью 30 c' };

  try {
    const { data } = await nodeFetch(NODES.piped, () => `/streams/${t.id}`);
    const streams = (data.audioStreams || []).filter((s) => s.url).sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
    const pick = streams.find((s) => canPlay(s.mimeType)) || streams[0];
    if (!pick) {
      if (data.hls && aMain.canPlayType('application/vnd.apple.mpegurl')) {
        return { url: data.hls, kbps: 160, codec: 'HLS' };
      }
      throw new Error('нет аудиопотока');
    }
    return { url: pick.url, kbps: Math.round((pick.bitrate || 130000) / 1000), codec: codecOf(pick.mimeType || pick.codec) };
  } catch (e) {
    const { data, base } = await nodeFetch(NODES.inv, () => `/api/v1/videos/${t.id}?local=true`);
    const af = (data.adaptiveFormats || [])
      .filter((f) => f.type && f.type.startsWith('audio') && f.url)
      .sort((a, b) => (+b.bitrate || 0) - (+a.bitrate || 0));
    const pick = af.find((f) => canPlay(f.type)) || af[0];
    if (pick) return { url: pick.url, kbps: Math.round((+pick.bitrate || 130000) / 1000), codec: codecOf(pick.type) };
    return { url: `${base}/latest_version?id=${t.id}&itag=251`, kbps: 160, codec: 'OPUS' };
  }
}

/* ---------------- WEB AUDIO / ЭФФЕКТЫ ---------------- */
let ctx = null, srcNode, inputGain, dryGain, wetGain, convolver, masterGain, analyser;

function initAudioGraph() {
  if (ctx) return;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC();
    srcNode = ctx.createMediaElementSource(aMain);
    inputGain = ctx.createGain();
    dryGain = ctx.createGain();
    wetGain = ctx.createGain();
    convolver = ctx.createConvolver();
    masterGain = ctx.createGain();
    analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.82;

    srcNode.connect(inputGain);
    inputGain.connect(dryGain).connect(masterGain);
    inputGain.connect(convolver).connect(wetGain).connect(masterGain);
    masterGain.connect(analyser).connect(ctx.destination);

    buildImpulse();
    applyFX();
  } catch (e) { ctx = null; }
}

function buildImpulse() {
  const dur = 2.8, decay = 3.4, rate = ctx.sampleRate, len = Math.floor(rate * dur);
  const buf = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
  }
  convolver.buffer = buf;
}

const currentRate = () => state.fx.slowOn ? SLOWED_RATE : (state.fx.speedOn ? state.fx.speed : 1);
const currentPreserve = () => !state.fx.slowOn; // slowed → pitch вниз вместе с темпом

function setPreserves(el, on) {
  el.preservesPitch = on;
  el.mozPreservesPitch = on;
  el.webkitPreservesPitch = on;
}

function syncProps() {
  const r = currentRate(), p = currentPreserve();
  [aMain, aSafe].forEach((el) => {
    el.volume = state.volume;
    el.muted = state.muted;
    el.playbackRate = r;
    setPreserves(el, p);
  });
}

function applyFX() {
  syncProps();
  if (!ctx) return;
  const now = ctx.currentTime;
  const wet = state.fx.slowOn ? 0.15 + 0.85 * state.fx.reverb : 0;
  wetGain.gain.setTargetAtTime(wet, now, 0.06);
  dryGain.gain.setTargetAtTime(state.fx.slowOn ? 0.9 : 1, now, 0.06);
}

/* ---------------- ВОСПРОИЗВЕДЕНИЕ ---------------- */
function loadAndPlay(url) {
  state.usingMain = true;
  aSafe.pause(); aSafe.removeAttribute('src'); aSafe.load();
  aMain.src = url; aMain.load();
  syncProps();
  if (ctx && ctx.state === 'suspended') ctx.resume();
  aMain.play().catch(() => fallbackSafe(url));
}

function fallbackSafe(url) {
  if (!state.usingMain) return;
  state.usingMain = false;
  toast('Поток без CORS: включён совместимый режим (визуализатор отключён)', 'warn');
  aMain.pause();
  aSafe.src = url; aSafe.load();
  syncProps();
  aSafe.play().catch(() => toast('Не удалось запустить поток', 'err'));
}

async function playIndex(i) {
  const t = state.queue[i];
  if (!t) return;
  state.current = i;
  state.activeTrack = t;
  renderNow(t);
  renderActive();
  btnPlay.classList.add('buffering');
  npQuality.hidden = true;
  try {
    const st = await resolveStream(t);
    if (state.current !== i) return; // уже переключили
    state.currentUrl = st.url;
    npQuality.textContent = st.kbps ? `${st.kbps} kbps · ${st.codec}` : st.codec;
    npQuality.hidden = false;
    loadAndPlay(st.url);
    setMediaSession(t);
  } catch (e) {
    btnPlay.classList.remove('buffering');
    toast('Не удалось получить поток — попробуйте другой трек', 'err');
  }
}

function togglePlay() {
  if (state.current < 0) {
    if (state.queue.length) { playIndex(0); return; }
    searchInput.focus();
    toast('Сначала найдите трек или загрузите файл', 'info');
    return;
  }
  const el = A();
  if (state.playingAudio) el.pause();
  else { initAudioGraph(); if (ctx && ctx.state === 'suspended') ctx.resume(); el.play().catch(() => {}); }
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

function playNext() { const i = nextIndex(1); if (i >= 0) playIndex(i); else stopUI(); }
function playPrev() {
  if (A().currentTime > 3) { A().currentTime = 0; return; }
  const i = nextIndex(-1);
  if (i >= 0) playIndex(i);
}
function stopUI() {
  state.playingAudio = false;
  document.body.classList.remove('playing');
  updatePlayIcon();
}

function getDuration() {
  const d = A().duration;
  return (isFinite(d) && d > 0) ? d : (state.activeTrack?.duration || 0);
}

/* ---------------- NOW PLAYING / ТЕМА ---------------- */
function renderNow(t) {
  npTitle.textContent = t.title;
  npArtist.textContent = t.artist;
  const labels = { piped: 'Piped · стрим', invidious: 'Invidious · стрим', itunes: 'iTunes · превью', local: 'Локальный файл' };
  npSource.textContent = labels[t.source] || t.source;
  npSource.className = 'pill pill-' + t.source;
  npSource.hidden = false;
  document.title = `${t.title} — ${t.artist} · AURA X`;

  if (t.thumb) {
    disc.classList.add('hasart');
    disc.classList.remove('noart');
    if (cover.src !== t.thumb) cover.src = t.thumb;
    else if (cover.complete && cover.naturalWidth) extractColors(cover);
  } else {
    disc.classList.remove('hasart');
    disc.classList.add('noart');
    cover.removeAttribute('src');
    applyTheme([0, 242, 254], [196, 107, 255]);
  }
}

cover.addEventListener('load', () => { if (cover.naturalWidth) extractColors(cover); });

function extractColors(img) {
  try {
    const c = document.createElement('canvas');
    c.width = c.height = 32;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0, 32, 32);
    const d = g.getImageData(0, 0, 32, 32).data;
    let best = null, bestScore = -1;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 200) continue;
      const r = d[i], gg = d[i + 1], b = d[i + 2];
      const max = Math.max(r, gg, b), min = Math.min(r, gg, b);
      const sat = (max - min) / 255, val = max / 255;
      const score = sat * 1.4 + val * 0.6 - Math.abs(val - 0.55);
      if (score > bestScore) { bestScore = score; best = [r, gg, b]; }
    }
    if (!best) return;
    const shifted = hueShift(best, 48);
    applyTheme(best, shifted);
  } catch (e) { /* CORS-запрет — оставляем текущую тему */ }
}

function rgbToHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0; const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  return [h * 360, s, l];
}
function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360 / 360;
  if (s === 0) { const v = Math.round(l * 255); return [v, v, v]; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = (t) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [Math.round(f(h + 1 / 3) * 255), Math.round(f(h) * 255), Math.round(f(h - 1 / 3) * 255)];
}
const hueShift = (rgb, deg) => { const [h, s, l] = rgbToHsl(rgb); return hslToRgb(h + deg, Math.min(1, s + 0.15), Math.max(0.4, Math.min(0.68, l))); };
const hex = ([r, g, b]) => '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');

function applyTheme(c1, c2) {
  const root = document.documentElement.style;
  root.setProperty('--acc1', hex(c1));
  root.setProperty('--acc2', hex(c2));
  root.setProperty('--acc1-rgb', c1.join(','));
  root.setProperty('--acc2-rgb', c2.join(','));
  state.vizColors = [hex(c1), hex(c2)];
}

/* ---------------- MEDIA SESSION ---------------- */
function setMediaSession(t) {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title, artist: t.artist, album: 'AURA X',
      artwork: t.thumb ? [{ src: t.thumb, sizes: '600x600', type: 'image/jpeg' }] : []
    });
    navigator.mediaSession.setActionHandler('play', () => A().play());
    navigator.mediaSession.setActionHandler('pause', () => A().pause());
    navigator.mediaSession.setActionHandler('previoustrack', playPrev);
    navigator.mediaSession.setActionHandler('nexttrack', playNext);
  } catch (e) {}
}

/* ---------------- СОБЫТИЯ АУДИО ---------------- */
function updatePlayIcon() {
  icoPlay.hidden = state.playingAudio;
  icoPause.hidden = !state.playingAudio;
}

[aMain, aSafe].forEach((el) => {
  el.addEventListener('play', () => {
    state.playingAudio = true;
    document.body.classList.add('playing');
    btnPlay.classList.remove('buffering');
    updatePlayIcon();
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
  });
  el.addEventListener('pause', () => {
    if (el !== A()) return;
    state.playingAudio = false;
    document.body.classList.remove('playing');
    updatePlayIcon();
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
  });
  el.addEventListener('waiting', () => { if (el === A()) btnPlay.classList.add('buffering'); });
  el.addEventListener('playing', () => { if (el === A()) btnPlay.classList.remove('buffering'); });
  el.addEventListener('timeupdate', () => {
    if (el !== A()) return;
    const d = getDuration();
    tDur.textContent = fmtTime(d);
    if (!state.dragging && d > 0) {
      seek.value = Math.min(1000, (el.currentTime / d) * 1000);
      paintRange(seek);
    }
    tCur.textContent = fmtTime(el.currentTime);
  });
  el.addEventListener('ended', () => {
    if (el !== A()) return;
    if (state.repeat === 2) { el.currentTime = 0; el.play().catch(() => {}); return; }
    playNext();
  });
});

aMain.addEventListener('error', () => {
  if (state.usingMain && state.currentUrl && aMain.error) fallbackSafe(state.currentUrl);
});
aSafe.addEventListener('error', () => {
  if (!state.usingMain && aSafe.error) toast('Ошибка воспроизведения потока', 'err');
});

/* ---------------- ВИЗУАЛИЗАТОР ---------------- */
const BARS = 52;
const smooth = new Float32Array(BARS);
let freqData = null;

function resizeViz() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  viz.width = viz.clientWidth * dpr;
  viz.height = viz.clientHeight * dpr;
}
window.addEventListener('resize', resizeViz);
resizeViz();

function draw(t) {
  requestAnimationFrame(draw);
  const w = viz.width, h = viz.height;
  vctx.clearRect(0, 0, w, h);

  let targets;
  if (state.playingAudio && state.usingMain && analyser) {
    if (!freqData) freqData = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(freqData);
    const usable = Math.floor(freqData.length * 0.72);
    targets = new Float32Array(BARS);
    for (let i = 0; i < BARS; i++) {
      const idx = Math.min(usable - 1, Math.floor(Math.pow(i / BARS, 1.55) * usable));
      targets[i] = freqData[idx] / 255;
    }
  } else if (state.playingAudio) {
    targets = new Float32Array(BARS);
    for (let i = 0; i < BARS; i++) {
      targets[i] = 0.28 + 0.22 * Math.abs(Math.sin(t / 420 + i * 0.55)) * (0.6 + 0.4 * Math.sin(t / 130 + i));
    }
  } else {
    targets = new Float32Array(BARS); // тишина
  }

  for (let i = 0; i < BARS; i++) smooth[i] += (targets[i] - smooth[i]) * 0.22;

  const gap = w / BARS;
  const bw = Math.max(2, gap * 0.55);
  const grad = vctx.createLinearGradient(0, h, 0, 0);
  grad.addColorStop(0, state.vizColors[1]);
  grad.addColorStop(1, state.vizColors[0]);
  vctx.fillStyle = grad;
  vctx.shadowColor = state.vizColors[0];
  vctx.shadowBlur = 10;

  for (let i = 0; i < BARS; i++) {
    const bh = Math.max(h * 0.04, smooth[i] * (h * 0.86));
    const x = i * gap + (gap - bw) / 2;
    const y = h - bh;
    vctx.beginPath();
    vctx.roundRect(x, y, bw, bh, bw / 2);
    vctx.fill();
  }
  vctx.shadowBlur = 0;
  vctx.fillStyle = 'rgba(255,255,255,.10)';
  vctx.fillRect(0, h - 2, w, 2);
}
requestAnimationFrame(draw);

/* ---------------- ПРИВЯЗКИ UI ---------------- */
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

btnMute.addEventListener('click', () => {
  state.muted = !state.muted;
  syncProps();
  icoVol.hidden = state.muted;
  icoMute.hidden = !state.muted;
});

volume.addEventListener('input', () => {
  state.volume = volume.value / 100;
  if (state.muted && state.volume > 0) { state.muted = false; icoVol.hidden = false; icoMute.hidden = true; }
  syncProps();
  paintRange(volume);
});

seek.addEventListener('input', () => {
  state.dragging = true;
  paintRange(seek);
  const d = getDuration();
  if (d > 0) {
    try { A().currentTime = (seek.value / 1000) * d; } catch (e) {}
    tCur.textContent = fmtTime((seek.value / 1000) * d);
  }
});
seek.addEventListener('change', () => { state.dragging = false; });

/* --- поиск --- */
const debouncedSearch = debounce(() => doSearch(searchInput.value), 650);
searchInput.addEventListener('input', () => {
  searchClear.hidden = !searchInput.value;
  if (searchInput.value.trim()) debouncedSearch();
});
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doSearch(searchInput.value);
});
searchClear.addEventListener('click', () => {
  searchInput.value = '';
  searchClear.hidden = true;
  searchInput.focus();
});

CHIPS.forEach((c) => {
  const b = document.createElement('button');
  b.className = 'chip';
  b.textContent = c;
  b.addEventListener('click', () => {
    chipsEl.querySelectorAll('.chip').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    searchInput.value = c;
    searchClear.hidden = false;
    doSearch(c);
  });
  chipsEl.append(b);
});

resultsEl.addEventListener('click', (e) => {
  const card = e.target.closest('.track');
  if (!card || card.classList.contains('skel')) return;
  const i = +card.dataset.i;
  if (i === state.current) togglePlay();
  else playIndex(i);
});

/* --- локальные файлы --- */
uploadBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  const files = [...fileInput.files];
  if (!files.length) return;
  const first = state.queue.length;
  files.forEach((f) => {
    state.queue.push({
      source: 'local',
      id: 'local-' + Math.random().toString(36).slice(2),
      title: f.name.replace(/\.[^.]+$/, ''),
      artist: 'Локальный файл · нативный битрейт',
      thumb: null,
      duration: 0,
      url: URL.createObjectURL(f)
    });
  });
  renderResults(state.queue, 'Микс: поиск + файлы');
  fileInput.value = '';
  playIndex(first);
  toast(`Добавлено файлов: ${files.length}`, 'ok');
});

/* --- эффекты --- */
fxSpeed.addEventListener('change', () => {
  state.fx.speedOn = fxSpeed.checked;
  if (fxSpeed.checked && fxSlow.checked) { fxSlow.checked = false; state.fx.slowOn = false; }
  refreshFxUI(); applyFX();
});
fxSlow.addEventListener('change', () => {
  state.fx.slowOn = fxSlow.checked;
  if (fxSlow.checked && fxSpeed.checked) { fxSpeed.checked = false; state.fx.speedOn = false; }
  refreshFxUI(); applyFX();
  if (fxSlow.checked && !state.usingMain) toast('В совместимом режиме реверб недоступен', 'warn');
});
fxSpeedVal.addEventListener('input', () => {
  state.fx.speed = +fxSpeedVal.value;
  fxSpeedOut.textContent = '×' + state.fx.speed.toFixed(2);
  paintRange(fxSpeedVal);
  applyFX();
});
fxReverb.addEventListener('input', () => {
  state.fx.reverb = +fxReverb.value;
  fxReverbOut.textContent = Math.round(state.fx.reverb * 100) + '%';
  paintRange(fxReverb);
  applyFX();
});
fxReset.addEventListener('click', () => {
  fxSpeed.checked = fxSlow.checked = false;
  state.fx = { speedOn: false, speed: 1.25, slowOn: false, reverb: 0.45 };
  fxSpeedVal.value = 1.25; fxSpeedOut.textContent = '×1.25';
  fxReverb.value = 0.45; fxReverbOut.textContent = '45%';
  refreshFxUI(); applyFX();
  toast('Эффекты сброшены', 'info');
});
function refreshFxUI() {
  rowSpeed.classList.toggle('off', !state.fx.speedOn);
  rowSlow.classList.toggle('off', !state.fx.slowOn);
}

/* --- клавиатура --- */
document.addEventListener('keydown', (e) => {
  const tag = document.activeElement?.tagName || '';
  if (/INPUT|TEXTAREA/.test(tag)) return;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  else if (e.code === 'KeyM') btnMute.click();
  else if (e.code === 'ArrowRight') { try { A().currentTime = Math.min(getDuration(), A().currentTime + 5); } catch (err) {} }
  else if (e.code === 'ArrowLeft') { try { A().currentTime = Math.max(0, A().currentTime - 5); } catch (err) {} }
});

/* ---------------- ИНИЦИАЛИЗАЦИЯ ---------------- */
(function init() {
  volume.value = state.volume * 100;
  paintRange(volume); paintRange(seek); paintRange(fxSpeedVal); paintRange(fxReverb);
  fxSpeedVal.value = state.fx.speed; fxSpeedOut.textContent = '×' + state.fx.speed.toFixed(2);
  refreshFxUI();
  updatePlayIcon();
  renderEmpty(''); // приветственное состояние заменится первым поиском
  resultsEl.innerHTML = `<div class="empty-state">
    <svg viewBox="0 0 24 24" width="44" height="44" fill="currentColor"><path d="M11 21h-1l1-7H7.5c-.58 0-.57-.32-.38-.66l.19-.34L13 3h1l-1 7h3.5c.49 0 .56.33.47.51l-.07.15L11 21z"/></svg>
    <b>AURA X готова к работе</b>
    <span>Введите запрос или нажмите на подсказку выше. Поиск идёт сразу по всем нодам Piped, Invidious и iTunes — упавшие серверы переключаются автоматически, выбирается поток с максимальным битрейтом.</span>
  </div>`;
  resultsMeta.textContent = 'введите запрос — поиск идёт по всем нодам сразу';
  toast('AURA X готова — ищите треки или загрузите свой MP3', 'ok');
})();