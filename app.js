/* ================= 简约音乐 · 本地播放器 =================
   所有音频仅在浏览器本地处理，不上传任何服务器。
   元数据存 localStorage，音频 Blob 存 IndexedDB，刷新不丢失。 */

const $ = s => document.querySelector(s);

const audio = new Audio();
audio.preload = 'auto';

/* ---------- 全局状态 ---------- */
let songs = [];          // {id,title,artist,album,cover,duration,fileName}
let current = -1;        // 当前播放索引
let mode = 'list';       // list | one | shuffle
let objectURLs = {};     // id -> blob objectURL
let lyrics = [];         // [{time, text}]
let lyricIdx = -1;
let lyricOffset = 0;     // 歌词容器当前位移
let lyricTarget = 0;
let dragging = false;    // 是否正在拖进度条
let dragRatio = 0;

/* ---------- 默认灰色封面 ---------- */
const DEFAULT_COVER = 'data:image/svg+xml,' + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
     <rect width="200" height="200" fill="#374151"/>
     <path d="M80 140V70l60-10v62" stroke="#9ca3af" stroke-width="8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
     <circle cx="70" cy="140" r="14" fill="#9ca3af"/><circle cx="130" cy="122" r="14" fill="#9ca3af"/>
   </svg>`);

/* ================= IndexedDB（存音频 Blob） ================= */
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('local-music-db', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('files');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function dbPut(id, blob) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction('files', 'readwrite');
    tx.objectStore('files').put(blob, id);
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
}
async function dbGet(id) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const req = db.transaction('files').objectStore('files').get(id);
    req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error);
  });
}
async function dbDel(id) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction('files', 'readwrite');
    tx.objectStore('files').delete(id);
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
}

/* ================= 工具 ================= */
const fmt = t => {
  if (!isFinite(t)) return '0:00';
  const m = Math.floor(t / 60), s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
};
let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
}
const saveMeta = () => localStorage.setItem('lm-playlist', JSON.stringify(songs));
const saveState = () => localStorage.setItem('lm-state', JSON.stringify({ current, mode, volume: audio.volume }));

/* ================= ID3 解析（jsmediatags） ================= */
function readTags(file) {
  return new Promise(resolve => {
    jsmediatags.read(file, {
      onSuccess: tag => {
        const t = tag.tags || {};
        let cover = null;
        if (t.picture) {
          const { data, format } = t.picture;
          let bin = '';
          for (let i = 0; i < data.length; i++) bin += String.fromCharCode(data[i]);
          cover = `data:${format};base64,${btoa(bin)}`;
        }
        resolve({
          title: (t.title || '').trim(),
          artist: (t.artist || '').trim(),
          album: (t.album || '').trim(),
          cover
        });
      },
      onError: () => resolve({ title: '', artist: '', album: '', cover: null })
    });
  });
}

/* ================= 导入文件 ================= */
$('#btnImport').addEventListener('click', () => $('#fileInput').click());
$('#fileInput').addEventListener('change', async e => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;
  toast(`正在导入 ${files.length} 首歌曲…`);
  for (const f of files) {
    const id = 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const meta = await readTags(f);
    const song = {
      id,
      title: meta.title || f.name.replace(/\.[^.]+$/, ''),
      artist: meta.artist || '未知歌手',
      album: meta.album || '未知专辑',
      cover: meta.cover,
      duration: 0,
      fileName: f.name
    };
    try { await dbPut(id, f); } catch { toast('存储失败：空间可能不足'); continue; }
    objectURLs[id] = URL.createObjectURL(f);
    // 读取时长
    await new Promise(res => {
      const a = new Audio();
      a.preload = 'metadata';
      a.src = objectURLs[id];
      a.onloadedmetadata = () => { song.duration = a.duration || 0; res(); };
      a.onerror = () => res();
      setTimeout(res, 3000);
    });
    songs.push(song);
  }
  saveMeta();
  renderPlaylist();
  if (current === -1 && songs.length) loadSong(0, false);
  toast(`已导入，共 ${songs.length} 首`);
});

/* ================= 播放控制 ================= */
const playSVG = '<svg width="30" height="30" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
const pauseSVG = '<svg width="30" height="30" viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>';

const MODE_INFO = {
  list:    { tip: '列表循环', svg: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 2l4 4-4 4"/><path d="M3 11v-1a4 4 0 014-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v1a4 4 0 01-4 4H3"/></svg>' },
  one:     { tip: '单曲循环', svg: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 2l4 4-4 4"/><path d="M3 11v-1a4 4 0 014-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v1a4 4 0 01-4 4H3"/><text x="12" y="15" font-size="9" fill="currentColor" stroke="none" text-anchor="middle" font-weight="bold">1</text></svg>' },
  shuffle: { tip: '随机播放', svg: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 3h5v5"/><path d="M4 20L21 3"/><path d="M21 16v5h-5"/><path d="M15 15l6 6"/><path d="M4 4l5 5"/></svg>' }
};

function loadSong(i, autoplay = true) {
  if (i < 0 || i >= songs.length) return;
  current = i;
  const s = songs[i];
  const url = objectURLs[s.id];
  if (!url) { toast('音频数据缺失，请重新导入'); return; }
  audio.src = url;
  $('#songTitle').textContent = s.title;
  $('#songArtist').textContent = `${s.artist} · ${s.album}`;
  $('#coverImg').src = s.cover || DEFAULT_COVER;
  $('#durTime').textContent = fmt(s.duration);
  updateMediaSession(s);
  renderPlaylistActive();
  fetchLyrics(s);
  saveState();
  if (autoplay) audio.play().catch(() => {});
}

function togglePlay() {
  if (!songs.length) { toast('请先导入歌曲'); return; }
  if (current === -1) { loadSong(0); return; }
  audio.paused ? audio.play().catch(() => {}) : audio.pause();
}

function nextSong(auto = false) {
  if (!songs.length) return;
  let i;
  if (mode === 'shuffle' && songs.length > 1) {
    do { i = Math.floor(Math.random() * songs.length); } while (i === current);
  } else {
    i = current + 1;
    if (i >= songs.length) { if (auto && mode !== 'list') return; i = 0; }
  }
  loadSong(i);
}
function prevSong() {
  if (!songs.length) return;
  // 播放超过3秒回到开头，否则上一首
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  let i;
  if (mode === 'shuffle' && songs.length > 1) {
    do { i = Math.floor(Math.random() * songs.length); } while (i === current);
  } else {
    i = (current - 1 + songs.length) % songs.length;
  }
  loadSong(i);
}

audio.addEventListener('ended', () => {
  if (mode === 'one') { audio.currentTime = 0; audio.play().catch(() => {}); }
  else nextSong(true);
});
audio.addEventListener('play', () => {
  $('#btnPlay').innerHTML = pauseSVG;
  $('#coverDisc').classList.add('playing');
});
audio.addEventListener('pause', () => {
  $('#btnPlay').innerHTML = playSVG;
  $('#coverDisc').classList.remove('playing');
});
audio.addEventListener('loadedmetadata', () => {
  $('#durTime').textContent = fmt(audio.duration);
});

$('#btnPlay').addEventListener('click', togglePlay);
$('#btnNext').addEventListener('click', () => nextSong());
$('#btnPrev').addEventListener('click', prevSong);
$('#btnMode').addEventListener('click', () => {
  mode = mode === 'list' ? 'one' : mode === 'one' ? 'shuffle' : 'list';
  renderModeBtn();
  saveState();
});
function renderModeBtn() {
  const el = $('#btnMode');
  el.innerHTML = MODE_INFO[mode].svg;
  el.classList.toggle('text-indigo-400', mode !== 'list');
  toast(MODE_INFO[mode].tip);
}

/* ================= 进度条（拖动 + rAF 平滑） ================= */
const progressWrap = $('#progressWrap');
function seekByEvent(e) {
  const bar = progressWrap.firstElementChild;
  const rect = bar.getBoundingClientRect();
  dragRatio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  setProgressUI(dragRatio);
}
progressWrap.addEventListener('pointerdown', e => {
  if (!audio.duration) return;
  dragging = true;
  progressWrap.setPointerCapture(e.pointerId);
  seekByEvent(e);
});
progressWrap.addEventListener('pointermove', e => { if (dragging) seekByEvent(e); });
progressWrap.addEventListener('pointerup', e => {
  if (!dragging) return;
  dragging = false;
  audio.currentTime = dragRatio * audio.duration;
});
function setProgressUI(ratio) {
  const pct = (ratio * 100).toFixed(2) + '%';
  $('#progressFill').style.width = pct;
  $('#progressDot').style.left = pct;
}

/* ================= 音量 ================= */
$('#volume').addEventListener('input', e => {
  audio.volume = +e.target.value;
  e.target.style.setProperty('--val', (e.target.value * 100) + '%');
  saveState();
});

/* ================= 同步歌词（LRCLIB） ================= */
async function fetchLyrics(song) {
  lyrics = []; lyricIdx = -1;
  $('#lyricInner').innerHTML = '';
  const empty = $('#lyricEmpty');
  empty.classList.add('hidden');
  lyricOffset = lyricTarget = 0;
  $('#lyricInner').style.transform = 'translateY(0px)';

  const pick = data => data && data.syncedLyrics ? data.syncedLyrics : null;
  try {
    let res = await fetch(`https://lrclib.net/api/get?track_name=${encodeURIComponent(song.title)}&artist_name=${encodeURIComponent(song.artist === '未知歌手' ? '' : song.artist)}`);
    let lrc = null;
    if (res.ok) lrc = pick(await res.json());
    if (!lrc) {
      res = await fetch(`https://lrclib.net/api/search?track_name=${encodeURIComponent(song.title)}&artist_name=${encodeURIComponent(song.artist === '未知歌手' ? '' : song.artist)}`);
      if (res.ok) {
        const arr = await res.json();
        const hit = arr.find(x => x.syncedLyrics);
        if (hit) lrc = hit.syncedLyrics;
      }
    }
    if (!lrc) {
      empty.textContent = '♪ 未找到匹配的歌词，请纯享音乐 ♪';
      empty.classList.remove('hidden');
      return;
    }
    lyrics = parseLRC(lrc);
    renderLyrics();
  } catch {
    empty.textContent = '歌词加载失败，请检查网络';
    empty.classList.remove('hidden');
  }
}

function parseLRC(text) {
  const out = [];
  const re = /\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]/g;
  for (const line of text.split(/\r?\n/)) {
    const times = [];
    let m; re.lastIndex = 0;
    while ((m = re.exec(line))) {
      times.push(+m[1] * 60 + +m[2] + (m[3] ? +('0.' + m[3].padEnd(3, '0')) : 0));
    }
    const txt = line.replace(re, '').trim();
    if (txt && times.length) times.forEach(t => out.push({ time: t, text: txt }));
  }
  return out.sort((a, b) => a.time - b.time);
}

function renderLyrics() {
  const inner = $('#lyricInner');
  inner.innerHTML = lyrics.map((l, i) =>
    `<div class="lyric-line" data-i="${i}" data-t="${l.time}">${l.text.replace(/</g, '&lt;')}</div>`).join('');
  // 点击歌词行跳转
  inner.querySelectorAll('.lyric-line').forEach(el => {
    el.addEventListener('click', () => {
      audio.currentTime = +el.dataset.t;
      if (audio.paused) audio.play().catch(() => {});
    });
  });
}

/* 歌词滚动主循环：rAF + 线性插值，柔和高亮不闪烁 */
function lyricTick() {
  const box = $('#lyricBox'), inner = $('#lyricInner');
  if (lyrics.length && inner.children.length) {
    const t = audio.currentTime;
    let ni = -1;
    for (let i = 0; i < lyrics.length; i++) { if (lyrics[i].time <= t + 0.05) ni = i; else break; }
    if (ni !== lyricIdx) {
      lyricIdx = ni;
      inner.querySelectorAll('.lyric-line.active').forEach(el => el.classList.remove('active'));
      if (ni >= 0) inner.children[ni].classList.add('active');
    }
    if (lyricIdx >= 0) {
      const line = inner.children[lyricIdx];
      lyricTarget = box.clientHeight / 2 - (line.offsetTop + line.offsetHeight / 2);
    } else {
      lyricTarget = box.clientHeight / 2 - 20;
    }
  }
  // 平滑趋近目标位置
  lyricOffset += (lyricTarget - lyricOffset) * 0.14;
  $('#lyricInner').style.transform = `translateY(${lyricOffset}px)`;

  // 进度与时间（拖动时不覆盖）
  if (!dragging && audio.duration) {
    setProgressUI(audio.currentTime / audio.duration);
    $('#curTime').textContent = fmt(audio.currentTime);
  }
  requestAnimationFrame(lyricTick);
}

/* ================= 播放列表 UI ================= */
function renderPlaylist() {
  $('#songCount').textContent = `(${songs.length})`;
  const el = $('#playlistEl');
  if (!songs.length) {
    el.innerHTML = '<div class="text-center text-slate-500 py-16 text-sm">列表为空，点击右上角 + 导入歌曲</div>';
    return;
  }
  el.innerHTML = songs.map((s, i) => `
    <div class="list-item flex items-center gap-3 px-4 py-3 border-b border-slate-800/60" data-i="${i}">
      <img src="${s.cover || DEFAULT_COVER}" class="w-11 h-11 rounded-lg object-cover shrink-0 bg-slate-700" draggable="false">
      <div class="flex-1 min-w-0">
        <div class="truncate text-sm ${i === current ? 'text-indigo-400 font-semibold' : 'text-slate-200'}">${escapeHTML(s.title)}</div>
        <div class="truncate text-xs text-slate-500">${escapeHTML(s.artist)} · ${fmt(s.duration)}</div>
      </div>
      <button class="del-btn w-10 h-10 flex items-center justify-center text-slate-500 active:text-red-400" data-id="${s.id}" aria-label="删除">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>
      </button>
    </div>`).join('');
}
const escapeHTML = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function renderPlaylistActive() { renderPlaylist(); }

$('#playlistEl').addEventListener('click', async e => {
  const del = e.target.closest('.del-btn');
  if (del) { // 删除单条
    e.stopPropagation();
    const id = del.dataset.id;
    const idx = songs.findIndex(s => s.id === id);
    if (idx === -1) return;
    if (objectURLs[id]) { URL.revokeObjectURL(objectURLs[id]); delete objectURLs[id]; }
    await dbDel(id).catch(() => {});
    songs.splice(idx, 1);
    if (idx === current) {
      audio.pause(); audio.removeAttribute('src');
      current = -1;
      $('#songTitle').textContent = '未在播放';
      $('#songArtist').textContent = '点击右上角 + 导入本地音乐';
      $('#coverImg').src = DEFAULT_COVER;
      lyrics = []; $('#lyricInner').innerHTML = '';
      if (songs.length) loadSong(Math.min(idx, songs.length - 1), false);
    } else if (idx < current) current--;
    saveMeta(); saveState(); renderPlaylist();
    toast('已删除');
    return;
  }
  const item = e.target.closest('.list-item');
  if (item) {
    const i = +item.dataset.i;
    if (i === current) { togglePlay(); }
    else loadSong(i);
    closeDrawer();
  }
});

/* 抽屉开关 */
const drawer = $('#drawer'), mask = $('#mask');
$('#btnList').addEventListener('click', () => { drawer.classList.add('open'); mask.classList.add('show'); });
const closeDrawer = () => { drawer.classList.remove('open'); mask.classList.remove('show'); };
$('#btnCloseDrawer').addEventListener('click', closeDrawer);
mask.addEventListener('click', closeDrawer);

/* ================= 媒体会话（通知栏控件） ================= */
function updateMediaSession(s) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: s.title, artist: s.artist, album: s.album,
    artwork: s.cover ? [{ src: s.cover, sizes: '512x512' }] : []
  });
}
if ('mediaSession' in navigator) {
  navigator.mediaSession.setActionHandler('play', () => audio.play());
  navigator.mediaSession.setActionHandler('pause', () => audio.pause());
  navigator.mediaSession.setActionHandler('previoustrack', prevSong);
  navigator.mediaSession.setActionHandler('nexttrack', () => nextSong());
  navigator.mediaSession.setActionHandler('seekto', d => { if (d.seekTime != null) audio.currentTime = d.seekTime; });
}

/* ================= 初始化 ================= */
async function init() {
  renderModeBtn();
  $('#btnPlay').innerHTML = playSVG;
  $('#coverImg').src = DEFAULT_COVER;
  $('#volume').style.setProperty('--val', '100%');

  // 恢复状态
  try {
    const st = JSON.parse(localStorage.getItem('lm-state') || '{}');
    if (st.mode && MODE_INFO[st.mode]) mode = st.mode;
    if (typeof st.volume === 'number') { audio.volume = st.volume; $('#volume').value = st.volume; $('#volume').style.setProperty('--val', (st.volume * 100) + '%'); }
    current = typeof st.current === 'number' ? st.current : -1;
  } catch { }
  renderModeBtn();

  // 恢复播放列表元数据 + 音频 Blob
  try {
    songs = JSON.parse(localStorage.getItem('lm-playlist') || '[]');
  } catch { songs = []; }
  const missing = [];
  for (const s of songs) {
    try {
      const blob = await dbGet(s.id);
      if (blob) objectURLs[s.id] = URL.createObjectURL(blob);
      else missing.push(s.id);
    } catch { missing.push(s.id); }
  }
  if (missing.length) { // 清除已丢失音频的记录
    songs = songs.filter(s => !missing.includes(s.id));
    saveMeta();
  }
  renderPlaylist();
  if (songs.length) loadSong(current >= 0 && current < songs.length ? current : 0, false);

  requestAnimationFrame(lyricTick);

  // 注册 Service Worker（PWA 离线支持）
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}
init();
