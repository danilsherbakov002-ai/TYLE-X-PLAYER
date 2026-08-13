'use strict';
/* ============================================================
   TYLE X — полные треки через Piped / Invidious.
   Каскад нод + резервные аудио-URL, без превью, без лагов.
   ============================================================ */

const PIPED = {
  good: 0,
  list: [
    'https://pipedapi.kavin.rocks',
    'https://api.piped.private.coffee',
    'https://pipedapi.adminforge.de',
    'https://pipedapi.reallyaweso.me',
    'https://pipedapi.ducks.party',
    'https://pipedapi.leptons.xyz',
    'https://api.piped.video'
  ]
};
const INVIDIOUS = {
  good: 0,
  list: [
    'https://invidious.nerdvpn.de',
    'https://inv.nadeko.net',
    'https://invidious.f5.si',
    'https://iv.melmac.space',
    'https://yewtu.be',
    'https://invidious.jing.rocks'
  ]
};
const TIMEOUT = 8000;

const state = {
  queue: [], current: -1, track: null,
  candidates: [], cand: 0,
  shuffle: false, repeat: 0,
  vol: 0.9, muted: false, dragging: false,
  searchToken: 0, playToken: 0
};

/* ---------------- DOM ---------------- */
const $ = (s) => document.querySelector(s);
const audio = $('#audio');
const qInput = $('#q'), clearBtn = $('#clearBtn'), spin = $('#spin');
const resultsEl = $('#results'), metaEl = $('#meta');
const cover = $('#cover'), disc = $('#disc');
const npTitle = $('#npTitle'), npArtist = $('#npArtist'), pillSrc = $('#pillSrc'), pillQ = $('#pillQ');
const seek = $('#seek'), tCur = $('#tCur'), tDur = $('#tDur');
const btnPlay = $('#btnPlay'), icoPlay = $('#icoPlay'), icoPause = $('#icoPause');
const btnPrev = $('#btnPrev'), btnNext = $('#btnNext'), btnShuffle = $('#btnShuffle'), btnRepeat = $('#btnRepeat'), repBadge = $('#repBadge');
const muteBtn = $('#muteBtn'), icoVol = $('#icoVol'), icoMute = $('#icoMute'), vol = $('#vol');
const uploadBtn = $('#uploadBtn'), fileInput = $('#fileInput');
const dropEl = $('#drop'), toastsEl = $('#toasts');

const NOTE_SVG = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg>';

/* ---------------- утилиты ---------------- */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = (s) => (!isFinite(s) || s <= 0) ? '0:00' : Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const fixUrl = (u) => !u ? '' : (u.startsWith('//') ? 'https:' + u : u);
const paintRange = (el) => {
  const min = +el.min || 0, max = +el.max || 100;
  el.style.setProperty('--p', (((+el.value - min) / (max - min)) * 100) + '%');
};
const canPlay = (m) => m ? audio.canPlayType(m.split(';')[0]) !== '' : true;
const codecOf = (m) => {
  const s = String(m || '').toLowerCase();
  if (s.includes('opus')) return 'OPUS';
  if (s.includes('mp4a') || s.includes('aac')) return 'AAC';
  if (s.includes('mpeg')) return 'MP3';
  if (s.includes('vorbis')) return 'VORBIS';
  return 'AUDIO';
};

function toast(msg, type = 'info') {
  const d = document.createElement('div');
  d.className = 'toast t-' + type;
  d.innerHTML = '<i></i>' + esc(msg);
  toastsEl.append(d);
  setTimeout(() => { d.classList.add('out'); setTimeout(() => d.remove(), 300); }, 3800);
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

/* ---------------- поиск (только полные треки) ---------------- */
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
    thumb: fixUrl(it.thumbnail), duration: it.duration > 0 ? it.duration : 0
  })).filter((t) => t.id);
}

async function searchInv(q) {
  const { data } = await nodeFetch(INVIDIOUS, () => `/api/v1/search?q=${encodeURIComponent(q)}&type=music`);
  const arr = Array.isArray(data) ? data.filter((v) => v.videoId).slice(0, 30) : [];
  if (!arr.length) throw new Error('empty');
  return arr.map((v) => ({
    source: 'invidious', id: v.videoId,
    title: v.title || 'Без названия', artist: v.author || '—',
    thumb: `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
    duration: v.lengthSeconds > 0 ? v.lengthSeconds : 0
  }));
}

async function doSearch(raw) {
  const q = (raw || '').trim();
  if (!q) return;
  const token = ++state.searchToken;
  spin.hidden = false;
  metaEl.textContent = 'опрашиваем ноды Piped / Invidious…';
  showSkeleton();

  const [p, i] = await Promise.allSettled([searchPiped(q), searchInv(q)]);
  if (token !== state.searchToken) return;
  spin.hidden = false;

  let tracks = null, src = '';
  if (p.status === 'fulfilled' && p.value.length) { tracks = p.value; src = 'Piped'; }
  else if (i.status === 'fulfilled' && i.value.length) { tracks = i.value; src = 'Invidious'; }

  if (!tracks) {
    metaEl.textContent = 'ничего не найдено';
    renderEmpty(q);
    toast('Ноды не ответили или ничего не нашли. Попробуйте другой запрос.', 'warn');
    return;
  }
  state.queue = tracks;
  state.current = -1;
  metaEl.textContent = `${tracks.length} треков · ${src} · полные версии`;
  renderResults();
  toast(`Найдено ${tracks.length} полных треков (${src})`, 'ok');
}

/* ---------------- рендер списка ---------------- */
function cardHTML(t, i) {
  const art = t.thumb ? `<img loading="lazy" src="${esc(t.thumb)}" alt="">` : `<div class="ph">${NOTE_SVG}</div>`;
  return `<article class="track" style="--i:${Math.min(i, 24)}" data-i="${i}">
    <div class="idx"><span class="num">${i + 1}</span><span class="eq"><i></i><i></i><i></i></span></div>
    <div class="art">${art}</div>
    <div class="tmeta">
      <div class="ttitle">${esc(t.title)}</div>
      <div class="tartist">${esc(t.artist)}</div>
    </div>
    <div class="tside">
      <span class="pill p-${t.source}">${t.source === 'local' ? 'LOCAL' : 'STREAM'}</span>
      <span class="tdur">${t.duration ? fmtTime(t.duration) : '—'}</span>
    </div>
  </article>`;
}

function renderResults() {
  resultsEl.innerHTML = state.queue.map(cardHTML).join('');
  renderActive();
}

function renderActive() {
  resultsEl.querySelectorAll('.track').forEach((el) => {
    el.classList.toggle('active', +el.dataset.i === state.current);
  });
}

function showSkeleton() {
  resultsEl.innerHTML = Array.from({ length: 8 }, (_, i) => `
    <div class="track skel" style="--i:${i}">
      <div class="idx"><span class="num">&nbsp;</span></div>
      <div class="sk sk-art"></div>
      <div class="tmeta"><div class="sk sk-a"></div><div class="sk sk-b"></div></div>
      <div class="tside"><span class="tdur">&nbsp;</span></div>
    </div>`).join('');
}

function renderEmpty(q) {
  resultsEl.innerHTML = `<div class="empty">
    ${NOTE_SVG.replace('width="20" height="20"', 'width="42" height="42"')}
    <b>По запросу «${esc(q)}» пусто</b>
    <span>Все ноды не ответили или ничего не нашли. Попробуйте имя исполнителя на английском или загрузите свои MP3 (кнопка сверху / drag-and-drop).</span>
  </div>`;
}

/* ---------------- резолв потока: макс. битрейт + резервы ---------------- */
async function resolveStream(t) {
  if (t.source === 'local') {
    return { candidates: [t.url], kbps: 0, codec: 'ВАШ ФАЙЛ', thumb: null, duration: t.duration, title: t.title, artist: t.artist };
  }
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
      thumb: fixUrl(data.thumbnail) || t.thumb,
      duration: data.duration > 0 ? data.duration : t.duration,
      title: data.title || t.title,
      artist: data.uploader || data.uploaderName || t.artist
    };
  } catch (e) {
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
        thumb: t.thumb, duration: data.lengthSeconds > 0 ? data.lengthSeconds : t.duration,
        title: data.title || t.title, artist: data.author || t.artist
      };
    }
    return {
      candidates: [`${base}/latest_version?id=${t.id}&itag=251`],
      kbps: 160, codec: 'OPUS',
      thumb: t.thumb, duration: t.duration, title: t.title, artist: t.artist
    };
  }
}

/* ---------------- воспроизведение ---------------- */
async function playIndex(i) {
  const t = state.queue[i];
  if (!t) return;
  const token = ++state.playToken;
  state.current = i;
  state.track = t;
  renderActive();
  btnPlay.classList.add('loading');
  pillQ.hidden = true;

  try {
    const r = await resolveStream(t);
    if (token !== state.playToken) return;

    npTitle.textContent = r.title;
    npArtist.textContent = r.artist;
    document.title = `${r.title} — ${r.artist} · TYLE X`;
    pillSrc.textContent = t.source === 'local' ? 'Локальный файл' : (t.source === 'piped' ? 'Piped · стрим' : 'Invidious · стрим');
    pillSrc.className = 'pill p-' + t.source;
    pillSrc.hidden = false;
    pillQ.textContent = r.kbps ? `${r.kbps} kbps · ${r.codec}` : r.codec;
    pillQ.hidden = false;
    if (r.duration) t.duration = r.duration;

    setCover(r, t);
    setMediaSession(r);

    state.candidates = r.candidates;
    state.cand = 0;
    startStream(r.candidates[0]);
  } catch (e) {
    if (token !== state.playToken) return;
    btnPlay.classList.remove('loading');
    toast('Все ноды не ответили. Попробуйте другой трек.', 'err');
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
    toast('Поток оборван — переключаюсь на резервный URL…', 'warn');
    startStream(state.candidates[state.cand]);
  } else {
    btnPlay.classList.remove('loading');
    toast('Не удалось воспроизвести трек: нода отдала битую ссылку.', 'err');
  }
}

audio.addEventListener('error', () => {
  if (audio.src && state.candidates.length) tryNextCandidate();
});

function setCover(r, t) {
  const src = r.thumb || t.thumb;
  cover.onerror = () => {
    cover.onerror = null;
    if (t.source !== 'local' && t.id) cover.src = `https://i.ytimg.com/vi/${t.id}/hqdefault.jpg`;
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
    qInput.focus();
    toast('Сначала найдите трек или загрузите файлы.', 'info');
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

/* ---------------- события аудио ---------------- */
audio.addEventListener('play', () => {
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
  if (!state.dragging && d > 0) {
    seek.value = Math.min(1000, (audio.currentTime / d) * 1000);
    paintRange(seek);
  }
  tCur.textContent = fmtTime(audio.currentTime);
});
audio.addEventListener('ended', () => {
  if (state.repeat === 2) { audio.currentTime = 0; audio.play().catch(() => {}); return; }
  playNext();
});

/* ---------------- Media Session ---------------- */
function setMediaSession(r) {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: r.title, artist: r.artist, album: 'TYLE X',
      artwork: (r.thumb || state.track?.thumb) ? [{ src: r.thumb || state.track.thumb, sizes: '480x480', type: 'image/jpeg' }] : []
    });
    navigator.mediaSession.setActionHandler('play', () => audio.play());
    navigator.mediaSession.setActionHandler('pause', () => audio.pause());
    navigator.mediaSession.setActionHandler('previoustrack', playPrev);
    navigator.mediaSession.setActionHandler('nexttrack', playNext);
  } catch (e) {}
}

/* ---------------- UI: транспорт ---------------- */
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
  audio.muted = state.muted;
  icoVol.hidden = state.muted;
  icoMute.hidden = !state.muted;
});
vol.addEventListener('input', () => {
  state.vol = vol.value / 100;
  audio.volume = state.vol;
  if (state.muted && state.vol > 0) {
    state.muted = false; audio.muted = false;
    icoVol.hidden = false; icoMute.hidden = true;
  }
  paintRange(vol);
});

seek.addEventListener('input', () => {
  state.dragging = true;
  paintRange(seek);
  const d = getDuration();
  if (d > 0) {
    try { audio.currentTime = (seek.value / 1000) * d; } catch (e) {}
    tCur.textContent = fmtTime((seek.value / 1000) * d);
  }
});
seek.addEventListener('change', () => { state.dragging = false; });

/* ---------------- UI: поиск ---------------- */
const debouncedSearch = debounce(() => doSearch(qInput.value), 600);
qInput.addEventListener('input', () => {
  clearBtn.hidden = !qInput.value;
  if (qInput.value.trim()) debouncedSearch();
});
qInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(qInput.value); });
clearBtn.addEventListener('click', () => { qInput.value = ''; clearBtn.hidden = true; qInput.focus(); });

resultsEl.addEventListener('click', (e) => {
  const card = e.target.closest('.track');
  if (!card || card.classList.contains('skel')) return;
  const i = +card.dataset.i;
  if (i === state.current) togglePlay();
  else playIndex(i);
});

/* ---------------- локальные файлы ---------------- */
uploadBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => { addFiles(fileInput.files); fileInput.value = ''; });

function addFiles(list) {
  const files = [...list].filter((f) => (f.type && f.type.startsWith('audio')) || /\.(mp3|ogg|m4a|flac|wav)$/i.test(f.name));
  if (!files.length) { toast('Это не аудиофайлы.', 'warn'); return; }
  const first = state.queue.length;
  files.forEach((f) => {
    state.queue.push({
      source: 'local',
      id: 'local-' + Math.random().toString(36).slice(2),
      title: f.name.replace(/\.[^.]+$/, ''),
      artist: 'Локальный файл',
      thumb: null, duration: 0,
      url: URL.createObjectURL(f)
    });
  });
  renderResults();
  metaEl.textContent = `${state.queue.length} треков · стрим + локальные файлы`;
  if (state.current < 0) playIndex(first);
  toast(`Добавлено файлов: ${files.length}`, 'ok');
}

let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', (e) => { if (hasFiles(e)) { dragDepth++; dropEl.classList.add('show'); } });
window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('dragleave', (e) => { if (hasFiles(e)) { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) dropEl.classList.remove('show'); } });
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  dropEl.classList.remove('show');
  addFiles(e.dataTransfer.files);
});

/* ---------------- клавиатура ---------------- */
document.addEventListener('keydown', (e) => {
  const tag = document.activeElement?.tagName || '';
  if (/INPUT|TEXTAREA/.test(tag)) return;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  else if (e.code === 'KeyM') muteBtn.click();
  else if (e.code === 'ArrowRight') { try { audio.currentTime = Math.min(getDuration(), audio.currentTime + 5); } catch (err) {} }
  else if (e.code === 'ArrowLeft') { try { audio.currentTime = Math.max(0, audio.currentTime - 5); } catch (err) {} }
});

/* ---------------- старт ---------------- */
(function init() {
  audio.volume = state.vol;
  paintRange(vol); paintRange(seek);
  resultsEl.innerHTML = `<div class="empty">
    ${NOTE_SVG.replace('width="20" height="20"', 'width="42" height="42"')}
    <b>TYLE X готов к работе</b>
    <span>Введите запрос — плеер ищет только полные треки на нодах Piped и Invidious (упавшие серверы переключаются автоматически, выбирается поток максимального битрейта). Или перетащите свои MP3 прямо в окно.</span>
  </div>`;
})();