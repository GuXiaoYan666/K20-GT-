'use strict';

const $ = (id) => document.getElementById(id);

let state = null;
let receivedAt = 0;
let lastRenderedIndex = null;
let lastLyricSig = '';
let lastLogsSig = '';
let lastTrackKey = '';
let animTimer = null;
let toastTimer = null;

const encoder = new TextEncoder();

function fmtTime(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

function truncate(str, n) {
  const s = String(str || '');
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function connect() {
  const es = new EventSource('/api/events');
  es.onmessage = (event) => {
    try {
      state = JSON.parse(event.data);
      receivedAt = performance.now();
      render();
    } catch (e) { /* ignore */ }
  };
  es.onerror = () => {
    es.close();
    setTimeout(connect, 2000);
  };
}

function currentPosition() {
  if (!state || !state.playback) return 0;
  const p = state.playback;
  if (p.status === 'Playing') {
    return p.position + (performance.now() - receivedAt) / 1000;
  }
  return p.position;
}

/* ---------- 渲染 ---------- */
function render() {
  if (!state) return;
  renderHeader();
  renderScreen();
  renderPlayback();
  renderLyrics();
  renderSettings();
  renderStatus();
  renderLogs();
}

function renderHeader() {
  const device = $('deviceChip');
  const ok = state.device && state.device.connected;
  device.className = 'chip ' + (ok ? 'on' : 'warn');
  device.querySelector('span').textContent = ok ? 'K20 GT 已连接' : '设备未连接';

  const player = $('playerChip');
  const active = state.playback && state.playback.active;
  player.className = 'chip ' + (active ? 'on' : '');
  player.querySelector('span').textContent = active ? state.playback.app : '未播放';

  $('powerBtn').setAttribute('aria-pressed', state.enabled ? 'true' : 'false');
}

function screenText() {
  if (!state) return '';
  if (state.lyrics && state.lyrics.status === 'ready' && state.lyrics.current) return state.lyrics.current;
  if (state.sent && state.sent.text) return state.sent.text;
  if (state.playback && state.playback.active && state.lyrics && state.lyrics.status === 'loading') return '正在检索歌词…';
  if (state.playback && state.playback.active && state.lyrics && state.lyrics.status === 'none') return '暂无歌词 · 可手动匹配';
  return '等待播放';
}

function renderScreen() {
  const text = screenText();
  const line = $('screenLine');
  const bytes = encoder.encode(text).length;
  const badge = $('byteBadge');
  const mode = state.settings ? state.settings.mode : 'extended';
  $('modeBadge').textContent = mode === 'simple' ? '简洁模式' : '扩展模式';
  badge.textContent = mode === 'simple' ? `${bytes} / 51 B` : `${bytes} B`;
  badge.classList.toggle('warn', mode === 'simple' && bytes > 51);

  if (line.textContent !== text) {
    line.textContent = text;
    line.classList.remove('marquee');
    line.style.removeProperty('--dur');
    requestAnimationFrame(() => {
      const container = $('deviceScreen');
      const overflow = line.scrollWidth > container.clientWidth - 90;
      if (overflow && text.length > 0) {
        const dur = Math.max(6, text.length * 0.32);
        line.style.setProperty('--dur', dur + 's');
        line.classList.add('marquee');
      }
    });
  }
  line.classList.toggle('dim', !(state.lyrics && state.lyrics.status === 'ready' && state.lyrics.current));

  const pos = currentPosition();
  $('screenTime').textContent = fmtTime(pos);
  $('screenTrack').textContent = state.playback && state.playback.active
    ? `${state.playback.title} · ${state.playback.artist}` : 'K20 GT 歌词字幕';

  const hint = $('screenHint');
  if (!state.device || !state.device.connected) hint.textContent = '未检测到 K20 GT，请确认 USB 连接后点击「重连设备」';
  else if (!state.enabled) hint.textContent = '上屏已暂停，键盘屏幕保持原显示';
  else if (state.sent && state.sent.lastAt) hint.textContent = '歌词已实时同步至键盘屏幕';
  else hint.textContent = '检测到播放后，歌词会自动同步到键盘屏幕';
}

function renderPlayback() {
  const p = state.playback || {};
  $('npTitle').textContent = p.title || '未在播放';
  $('npArtist').textContent = p.title ? (p.artist || '未知歌手') : '打开任意播放器播放歌曲即可';
  $('npApp').textContent = p.app || '—';

  const st = $('npState');
  if (!p.active) { st.textContent = '空闲'; st.className = 'np-state'; }
  else if (p.status === 'Playing') { st.textContent = '播放中'; st.className = 'np-state playing'; }
  else { st.textContent = '已暂停'; st.className = 'np-state'; }

  const initial = p.title ? Array.from(p.title.trim())[0] : '♪';
  $('npInitial').textContent = initial || '♪';

  const dur = Number(p.duration) || 0;
  const pos = Math.min(currentPosition(), dur || currentPosition());
  $('npPos').textContent = fmtTime(pos);
  $('npDur').textContent = fmtTime(dur);
  $('progressFill').style.width = dur > 0 ? Math.min(100, (pos / dur) * 100) + '%' : '0%';
}

function renderLyrics() {
  const lyr = state.lyrics || {};
  const list = $('lyricList');
  const empty = $('lyricEmpty');
  $('lyricSource').textContent = lyr.status === 'ready'
    ? `${lyr.source}${lyr.matched ? ' · ' + lyr.matched : ''}`
    : (lyr.status === 'loading' ? '正在检索…' : (lyr.reason || '—'));

  const rows = lyr.list || [];
  if (lyr.status !== 'ready' || !rows.length) {
    list.style.display = 'none';
    empty.style.display = 'flex';
    const p = empty.querySelector('p');
    if (lyr.status === 'loading') p.textContent = '正在检索歌词…';
    else if (lyr.status === 'none') p.textContent = '暂未找到这首歌的歌词';
    else p.textContent = '等待播放器播放音乐';
    lastRenderedIndex = null;
    lastLyricSig = '';
    return;
  }

  list.style.display = 'block';
  empty.style.display = 'none';

  // 只在歌词行/当前索引变化时重建列表，避免 250ms 一次的全量重排
  const sig = String(lyr.index) + '|' + rows.map((r) => `${r.time}:${r.offset}:${r.text}`).join('\n');
  if (sig !== lastLyricSig) {
    lastLyricSig = sig;
    list.innerHTML = '';
    rows.forEach((row) => {
      const el = document.createElement('div');
      el.className = 'lyric-row' + (row.offset === 0 ? ' current' : '');
      const time = document.createElement('span');
      time.className = 'time';
      time.textContent = row.offset === 0 ? '▶' : (row.time != null ? fmtTime(row.time) : '');
      const text = document.createElement('span');
      text.className = 'text';
      text.textContent = row.text;
      el.appendChild(time);
      el.appendChild(text);
      list.appendChild(el);
    });
  }

  if (lyr.index !== lastRenderedIndex) {
    lastRenderedIndex = lyr.index;
    const cur = list.querySelector('.lyric-row.current');
    if (cur) cur.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

function renderSettings() {
  if (!state.settings) return;
  const s = state.settings;

  document.querySelectorAll('.segmented').forEach((seg) => {
    const key = seg.dataset.key;
    seg.querySelectorAll('button').forEach((btn) => {
      const v = btn.dataset.value;
      const active = key === 'mode' ? s.mode === v : String(s.align) === v;
      btn.classList.toggle('active', active);
    });
  });

  $('animRange').value = s.animation;
  $('animValue').textContent = s.animation;
  setSwitch('transSwitch', !!s.showTranslation);
  setSwitch('idleSwitch', !!s.idleRestore);
  if (document.activeElement !== $('playerSelect')) $('playerSelect').value = s.preferPlayer || '';
}

function setSwitch(id, on) {
  const el = $(id);
  el.setAttribute('aria-checked', on ? 'true' : 'false');
}

function renderStatus() {
  const d = state.device || {};
  const stDevice = $('stDevice');
  stDevice.textContent = d.connected ? '已连接' : '未连接';
  stDevice.className = d.connected ? 'ok' : 'bad';
  $('stChannel').textContent = d.connected ? 'HID · 0xBC' : '—';
  $('stSource').textContent = state.lyrics && state.lyrics.status === 'ready' ? state.lyrics.source : '—';
  $('stSent').textContent = state.sent && state.sent.text ? truncate(state.sent.text, 12) : '—';
  const smtc = $('stSmtc');
  smtc.textContent = state.smtc && state.smtc.error ? '异常' : '正常';
  smtc.className = state.smtc && state.smtc.error ? 'bad' : 'ok';
}

function renderLogs() {
  const box = $('logList');
  const entries = (state.logs || []).slice(-10).reverse();
  const sig = entries.length + '|' + (entries[0] ? entries[0].at + entries[0].message : '');
  if (sig === lastLogsSig) return;
  lastLogsSig = sig;
  box.innerHTML = '';
  entries.forEach((entry) => {
    const el = document.createElement('div');
    el.className = 'log-item ' + (entry.level || '');
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = new Date(entry.at).toLocaleTimeString('zh-CN', { hour12: false });
    const m = document.createElement('span');
    m.textContent = entry.message;
    el.appendChild(t);
    el.appendChild(m);
    box.appendChild(el);
  });
}

function renderProgress() {
  if (!state) return;
  renderPlayback();
  $('screenTime').textContent = fmtTime(currentPosition());
}

/* ---------- 交互 ---------- */
async function post(url, body) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    if (!res.ok) return { ok: false, error: `请求失败 (${res.status})` };
    return await res.json();
  } catch (e) {
    return { ok: false, error: '网络错误，请稍后重试' };
  }
}

function toast(message) {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

document.querySelectorAll('.segmented').forEach((seg) => {
  seg.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const key = seg.dataset.key;
    const value = key === 'mode' ? btn.dataset.value : Number(btn.dataset.value);
    post('/api/settings', { [key]: value }).then(() => toast('设置已应用'));
  });
});

$('animRange').addEventListener('input', (e) => {
  $('animValue').textContent = e.target.value;
  clearTimeout(animTimer);
  animTimer = setTimeout(() => {
    post('/api/settings', { animation: Number(e.target.value) });
  }, 350);
});

$('transSwitch').addEventListener('click', () => {
  const on = $('transSwitch').getAttribute('aria-checked') === 'true';
  post('/api/settings', { showTranslation: !on });
});

$('idleSwitch').addEventListener('click', () => {
  const on = $('idleSwitch').getAttribute('aria-checked') === 'true';
  post('/api/settings', { idleRestore: !on });
});

$('playerSelect').addEventListener('change', (e) => {
  post('/api/settings', { preferPlayer: e.target.value });
});

/* 内嵌到 M HUB 时：通知宿主已就绪，并支持 Esc 关闭 */
(function () {
  if (window.parent === window) return;
  try { window.parent.postMessage({ k20: 'ready' }, '*'); } catch (_) {}
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      try { window.parent.postMessage({ k20: 'close' }, '*'); } catch (_) {}
    }
  });
})();

$('powerBtn').addEventListener('click', () => {
  if (!state) return;
  post('/api/settings', { enabled: !state.enabled });
});

$('testBtn').addEventListener('click', async () => {
  const text = (state && state.lyrics && state.lyrics.current) || 'K20 GT 歌词引擎';
  await post('/api/test', { text });
  toast('已发送到 K20 GT 屏幕');
});

$('restoreBtn').addEventListener('click', async () => {
  await post('/api/restore');
  toast('已恢复原屏内容');
});

$('reconnectBtn').addEventListener('click', async () => {
  const r = await post('/api/reconnect');
  toast(r.ok ? '设备已连接' : '未发现 K20 GT');
});

$('manualBtn').addEventListener('click', async () => {
  const title = $('manualTitle').value.trim();
  const artist = $('manualArtist').value.trim();
  if (!title) { toast('请填写歌曲名'); return; }
  const btn = $('manualBtn');
  btn.disabled = true;
  btn.textContent = '检索中';
  try {
    const r = await post('/api/manual', { title, artist });
    if (r.ok) toast(r.lyrics && r.lyrics.status === 'ready' ? '歌词已匹配' : '仍未找到歌词');
    else toast(r.error || '检索失败');
  } catch (e) {
    toast('检索失败');
  } finally {
    btn.disabled = false;
    btn.textContent = '检索';
  }
});

connect();
setInterval(renderProgress, 300);
