'use strict';
/**
 * K20 GT 歌词引擎 · 服务端 v2
 * - 更快轮询（250ms SMTC + 250ms lyric tick）
 * - SMTC 延迟补偿（offset -0.25s）
 * - 位置平滑（抗抖动 + 向前补偿）
 * - 加载后自动校验歌词 vs 播放进度（发现错位自动换源）
 * - 更密 tick，预取歌词行
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { K20Device } = require('./device');
const { SmtcMonitor } = require('./smtc');
const { fetchLyrics, computeScore } = require('./lyrics');

const PORT = Number(process.env.K20_PORT) || 8720;
const DATA_DIR = path.join(__dirname, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const LYRIC_TICK_MS = 250;        // 主歌词 tick 间隔（原来 700ms）
const SMTC_POLL_MS = 250;         // SMTC 轮询（原来 500ms）
const POSITION_OFFSET = -0.25;    // 歌词行触发提前量（负值=提前，补偿 SMTC 延迟）

const DEFAULT_CONFIG = {
  enabled: true,
  mode: 'extended',
  align: 1,
  animation: 9,
  font: 0,
  fontSize: 0,
  direction: 0,
  showTranslation: false,
  idleRestore: true,
  preferPlayer: '',
};

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
ensureDir(DATA_DIR);

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      return { ...DEFAULT_CONFIG, ...raw };
    }
  } catch (e) { /* ignore */ }
  return { ...DEFAULT_CONFIG };
}

const config = loadConfig();
function saveConfig() {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2)); } catch (e) { /* ignore */ }
}

const logs = [];
function log(level, message) {
  const entry = { at: Date.now(), level, message };
  logs.push(entry);
  if (logs.length > 300) logs.shift();
  const stamp = new Date(entry.at).toLocaleTimeString('zh-CN', { hour12: false });
  console.log(`[${stamp}] ${level.toUpperCase()} ${message}`);
}

const device = new K20Device();
const smtc = new SmtcMonitor({ interval: SMTC_POLL_MS });

const state = {
  selected: null,
  track: null,
  lyrics: null,
  lyricIndex: -1,
  position: 0,
  positionSmoothed: 0,
  positionHistory: [],       // 用于检测跳变
  lastSentText: '',
  lastSendAt: 0,
  savedScreen: null,
  idleSince: 0,
  manual: null,
  sendQueue: Promise.resolve(),
  // 新增：匹配/重取相关
  lastLyricFetch: 0,
  lastLyricFetchKey: '',    // 上次成功获取歌词的歌曲 key（用于硬去重）
  lyricMismatchCount: 0,    // 连续检测到错位次数
  positionAtLyricsReady: 0, // 歌词就绪时的播放位置（用于校验）
  lyricsVerified: false,    // 歌词是否经过首次校验
  mismatchForceReloads: 0,  // 本首歌已强制重拉次数（防无限循环）
  lastForceReloadAt: 0,     // 上次强制重拉时间
};

let fetchToken = 0;

function playerLabel(appId) {
  const s = String(appId || '');
  if (/汽水/i.test(s)) return '汽水音乐';
  if (/kugou|酷狗/i.test(s)) return '酷狗音乐';
  if (/kuwo|酷我|kwmusic/i.test(s)) return '酷我音乐';
  if (/lx|落雪|洛雪|music-desktop/i.test(s)) return '洛雪音乐';
  return s.replace(/\.exe$/i, '') || '未知播放器';
}

function estimatePosition(session, payloadT, now) {
  const dur = Number(session.duration) || 0;
  const base = Number(session.position) || 0;
  let pred;
  if (session.status === 'Playing') {
    const delta = Number(payloadT) - Number(session.lastUpdate);
    if (session.lastUpdate > 0 && delta > -60000 && delta < 6 * 3600 * 1000) {
      pred = base + Math.max(0, delta) / 1000;
    } else {
      pred = base + Math.max(0, now - (state.clockAt || now)) / 1000;
    }
  } else {
    pred = base;
  }
  if (dur > 0) pred = Math.min(pred, dur + 2);
  return Math.max(0, pred);
}

function smoothPosition(raw) {
  // 位置历史最多保留 5 个
  state.positionHistory.push({ t: Date.now(), pos: raw });
  if (state.positionHistory.length > 5) state.positionHistory.shift();
  // 检测大幅跳变（可能是拖动进度条）
  if (state.positionHistory.length >= 3) {
    const first = state.positionHistory[0].pos;
    const last = state.positionHistory[state.positionHistory.length - 1].pos;
    const totalDelta = last - first;
    // 500ms 内跳变超过 5 秒 → 判定为 seek，重置平滑
    if (Math.abs(totalDelta) > 5) {
      state.positionHistory = [{ t: Date.now(), pos: raw }];
      state.positionSmoothed = raw;
      state.lyricIndex = -1;  // 强制从新位置找歌词
      return raw;
    }
  }
  // 简单 EMA（指数移动平均），alpha 0.6
  const alpha = 0.6;
  if (state.positionSmoothed <= 0) state.positionSmoothed = raw;
  else state.positionSmoothed = state.positionSmoothed * (1 - alpha) + raw * alpha;
  return state.positionSmoothed;
}

function pickSession(sessions) {
  if (!sessions || !sessions.length) return null;
  const withTitle = sessions.filter(s => s.title && s.title.trim());
  if (!withTitle.length) return null;

  if (config.preferPlayer) {
    const hit = withTitle.find(s => playerLabel(s.app) === config.preferPlayer || s.app.includes(config.preferPlayer));
    if (hit) return hit;
  }
  if (state.selected) {
    const same = withTitle.find(s => s.id === state.selected.id);
    if (same && same.status === 'Playing') return same;
  }
  const playing = withTitle.filter(s => s.status === 'Playing');
  if (playing.length) return playing[0];
  if (state.selected) {
    const same = withTitle.find(s => s.id === state.selected.id);
    if (same) return same;
  }
  return withTitle[0];
}

function normalizeTrack(session) {
  if (!session) return null;
  return {
    title: (session.title || '').trim(),
    artist: (session.artist || '').trim(),
    app: session.app,
    appLabel: playerLabel(session.app),
    duration: Number(session.duration) || 0,
    key: `${(session.title || '').trim()}|${(session.artist || '').trim()}`,
  };
}

function findLyricIndex(lines, position) {
  if (!lines || !lines.length) return -1;
  // 用 position + POSITION_OFFSET（负数=提前触发）
  const t = position + POSITION_OFFSET;
  let lo = 0, hi = lines.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].time <= t) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  return ans;
}

function buildLineText(line) {
  if (!line) return '';
  let text = line.text;
  if (config.showTranslation && line.trans) text = `${text} · ${line.trans}`;
  return text;
}

function deviceSend(fn) {
  state.sendQueue = state.sendQueue.then(fn).catch((err) => {
    log('warn', `上屏失败：${err.message}`);
  });
  return state.sendQueue;
}

async function pushLine(line) {
  if (!config.enabled) return;
  const text = buildLineText(line);
  if (!text) return;
  if (text === state.lastSentText) return;
  state.lastSentText = text;
  state.lastSendAt = Date.now();
  deviceSend(async () => {
    if (config.mode === 'simple') {
      device.setLyricLineSimple(text, 0);
      state.lastSent = { text, mode: 'simple', packets: 1 };
    } else {
      const res = await device.setLyricLineExtended(text, {
        align: Number(config.align) || 0,
        animation: Number(config.animation) || 0,
        font: Number(config.font) || 0,
        fontSize: Number(config.fontSize) || 0,
        direction: Number(config.direction) || 0,
      });
      state.lastSent = { text, mode: 'extended', packets: res.packets };
    }
  });
}

async function restoreScreen() {
  if (!state.savedScreen) {
    state.lastSentText = '';
    return;
  }
  deviceSend(async () => {
    device.setScreenText(state.savedScreen);
    log('info', '已恢复 K20 GT 原显示内容');
  });
  state.lastSentText = '';
}

async function loadLyricsFor(track, opts = {}) {
  const token = ++fetchToken;

  // HARD dedup: same title+artist within 15 seconds → skip
  const nowKey = (track.title || '') + '|' + (track.artist || '');
  if (!opts.force && nowKey && state.lastLyricFetchKey === nowKey && Date.now() - state.lastLyricFetch < 15000) {
    log('debug', `skip loadLyricsFor: same track fetched ${Math.round((Date.now() - state.lastLyricFetch)/1000)}s ago`);
    return;
  }

  state.lyrics = { status: 'loading', lines: [], source: '', matched: '' };
  state.lyricIndex = -1;
  state.lastSentText = '';
  state.lyricsVerified = false;
  state.positionAtLyricsReady = 0;
  log('info', `检索歌词：${track.title}${track.artist ? ' - ' + track.artist : ''}${opts.force ? ' [强制重新获取]' : ''}`);
  const t0 = Date.now();
  const res = await fetchLyrics(track.title, track.artist, track.duration, opts);
  const dt = Date.now() - t0;
  if (token !== fetchToken) return;

  if (res.ok) {
    state.lyrics = {
      status: 'ready', lines: res.lines, source: res.source,
      matched: res.matched, cached: !!res.cached,
      score: res.score || { confidence: 0 },
      fetchedAt: res.fetchedAt,
      alternatives: res.alternatives || [],
    };
    state.lastLyricFetch = Date.now();
    state.lastLyricFetchKey = nowKey;
    log('info', `歌词就绪：${res.source} · ${res.matched} · ${res.lines.length} 行 · 置信度 ${res.score ? res.score.confidence : '?'}% · ${dt}ms · ${res.cached ? '缓存' : '网络'}`);
    // 立即记录当前播放位置，用于后续校验
    state.positionAtLyricsReady = state.position;
  } else {
    state.lyrics = { status: 'none', lines: [], source: '', matched: '', reason: res.reason || '未找到歌词' };
    log('warn', `未找到歌词：${track.title} - ${track.artist} (${res.reason})`);
  }
}

/* === 歌词 vs 播放进度 自动校验 ===
 * 当歌词就绪后，等待播放位置前进 >= 5 秒，然后看：
 *  - 当前 position 对应的歌词行 time 与歌词文件的实际行 time 差不超过 8秒
 *  - 且歌词行文本不是离谱的（例如 歌名/歌手名/纯括号内容）
 * 如果连续 3 次检测到错位，强制换源重取
 */
function checkLyricMismatch() {
  const s = state.selected;
  if (!s || s.status !== 'Playing') return;
  if (!state.lyrics || state.lyrics.status !== 'ready') return;
  const lines = state.lyrics.lines;
  if (!lines || !lines.length) return;
  if (state.lyricsVerified) return;  // 已经验证过了就不再查
  if (Date.now() - state.lastLyricFetch < 3000) return;  // 刚取的，等一下

  // 歌词就绪后播放进度前进 >= 5 秒才开始校验
  const playDelta = state.position - state.positionAtLyricsReady;
  if (playDelta < 5) return;

  // 当前 position（实际播放到哪里了）
  const realPos = state.position;
  const lyricIdx = findLyricIndex(lines, realPos);
  if (lyricIdx < 0 || lyricIdx >= lines.length - 1) {
    // 找不到或已经到末尾，跳过校验
    state.lyricsVerified = true;
    return;
  }

  // 当前歌词行 time 和 下一行 time
  const curLine = lines[lyricIdx];
  const nextLine = lines[lyricIdx + 1];

  // 基本检查：歌词行 time 应该在当前播放位置 ± 8 秒范围内
  const curTimeOk = Math.abs(curLine.time - realPos) < 12;
  const nextTimeOk = nextLine && Math.abs(nextLine.time - realPos) < 15;

  // 文本检查：歌词行不应该就是歌名/歌手名
  const cleanTitle = (state.track.title || '').toLowerCase().replace(/\s+/g, '');
  const cleanArtist = (state.track.artist || '').toLowerCase().replace(/\s+/g, '');
  const cleanLine = curLine.text.toLowerCase().replace(/[^\u4e00-\u9fa5\w]/g, '').trim();
  // 只把“整行几乎就是歌名/歌手名”判为错行；
  // 正常歌词行里包含歌名（如《当你》的「当你说今天的烦恼」）不算错位
  const lineIsTitle = cleanTitle.length > 2 && cleanLine.length > 2
    && (cleanLine === cleanTitle || (cleanLine.length <= cleanTitle.length + 2 && cleanLine.includes(cleanTitle)));
  const lineIsArtist = cleanArtist.length > 2 && cleanLine.length > 2
    && (cleanLine === cleanArtist || (cleanLine.length <= cleanArtist.length + 2 && cleanLine.includes(cleanArtist)));

  log('debug', `歌词校验：pos=${realPos.toFixed(1)}s curLineTime=${curLine.time.toFixed(1)}s line="${curLine.text.slice(0, 20)}" timeOk=${curTimeOk}`);

  if (!curTimeOk || lineIsTitle || lineIsArtist) {
    state.lyricMismatchCount++;
    log('warn', `歌词可能不匹配！检测到错位 #${state.lyricMismatchCount}：${!curTimeOk ? '时间差过大' : ''}${lineIsTitle ? '行=歌名' : ''}${lineIsArtist ? '行=歌手名' : ''}`);

    if (state.lyricMismatchCount >= 2) {
      // 每首歌最多强制重拉 1 次，且 2 分钟冷却
      if (state.mismatchForceReloads >= 1) {
        log('info', '已强制重拉过仍不匹配，放弃自动重试（继续播放）');
        state.lyricsVerified = true;
        state.lyricMismatchCount = 0;
        return;
      }
      if (Date.now() - state.lastForceReloadAt < 120000) {
        log('info', '强制重拉冷却中，跳过');
        state.lyricsVerified = true;
        state.lyricMismatchCount = 0;
        return;
      }
      // 执行强制重拉
      state.mismatchForceReloads++;
      state.lastForceReloadAt = Date.now();
      state.lyricMismatchCount = 0;
      log('warn', `强制重新获取歌词 (${state.mismatchForceReloads}/1)...`);
      if (state.track && state.track.title) {
        setTimeout(() => loadLyricsFor(state.track, { force: true }), 50);
      }
      state.lyricsVerified = true;
    }
  } else {
    // 通过校验
    state.lyricsVerified = true;
    state.lyricMismatchCount = 0;
    log('info', '歌词匹配验证通过 ✓');
  }
}

function onSessions(payload) {
  const session = pickSession(payload.sessions || []);
  if (!session) {
    state.selected = null;
    if (state.track && state.idleSince === 0) state.idleSince = Date.now();
    maybeIdle();
    return;
  }
  const track = normalizeTrack(session);
  state.selected = session;

  if (state.manual && state.manual.forKey === track.key) {
    state.track = { ...state.manual.track, duration: track.duration };
    if (session.status === 'Playing') state.idleSince = 0;
    tick(payload.t);
    return;
  }
  if (state.manual) state.manual = null;

  const changed = !state.track || state.track.key !== track.key;
  if (changed) {
    state.positionSmoothed = 0;
    state.positionHistory = [];
    state.lyricMismatchCount = 0;
    state.lyricsVerified = false;
    state.mismatchForceReloads = 0;  // 换歌重置强制重拉计数
    state.lastForceReloadAt = 0;
  }
  state.track = track;

  if (changed) {
    state.idleSince = 0;
    state.clockAt = payload.t;
    state.lastSentText = '';
    state.lyricIndex = -1;
    if (track.title) loadLyricsFor(track);
  }
  if (session.status === 'Playing') {
    state.idleSince = 0;
  } else if (!state.idleSince) {
    state.idleSince = Date.now();
  }
  tick(payload.t);
}

function maybeIdle() {
  if (!state.idleSince || !config.idleRestore) return;
  if (Date.now() - state.idleSince < 6000) return;
  if (state.lastSentText) {
    state.lyricIndex = -1;
    restoreScreen();
  }
}

function tick(payloadT) {
  const s = state.selected;
  if (!s) { maybeIdle(); return; }
  const now = Date.now();
  const rawPos = estimatePosition(s, payloadT || now, now);
  state.position = smoothPosition(rawPos);

  if (!config.enabled) return;
  if (s.status !== 'Playing') return;

  const lines = state.lyrics && state.lyrics.lines;
  if (!lines || !lines.length) return;

  const idx = findLyricIndex(lines, state.position);
  if (idx !== state.lyricIndex) {
    state.lyricIndex = idx;
    const line = lines[idx];
    if (line) pushLine(line);
  }

  // 每次 tick 都试试校验歌词（不频繁）
  if (Math.random() < 0.15) checkLyricMismatch();

  maybeIdle();
}

device.on('status', (st) => {
  log(st.connected ? 'info' : 'warn', st.connected ? 'K20 GT 已连接' : `K20 GT 未连接：${st.lastError || '设备未发现'}`);
});
device.on('notify', () => { /* ignore */ });

smtc.on('sessions', onSessions);
smtc.on('error', (msg) => log('warn', msg));

async function initDevice() {
  if (!device.open()) return;
  try {
    const st = await device.readLyricSettings();
    if (!config.fromDevice) {
      config.align = st.align;
      config.animation = st.animation;
      config.font = st.font;
      config.fontSize = st.fontSize;
      config.direction = st.direction;
      config.fromDevice = true;
      saveConfig();
      log('info', `已读取设备歌词样式：对齐 ${st.align} · 动画 ${st.animation}`);
    }
  } catch (e) { log('debug', `读取歌词样式失败：${e.message}`); }
  try {
    const txt = await device.readScreenText();
    // 即使原文字为空也要记录，退出时可把屏幕清空，避免歌词残留在键盘上
    state.savedScreen = { type: txt.type, align: txt.align, scroll: txt.scroll, text: txt.text || '' };
    log('info', txt.text ? '已备份屏幕原文字，空闲时可自动恢复' : '屏幕原文字为空，退出时将清空屏幕');
  } catch (e) { log('debug', `读取屏幕文字失败：${e.message}`); }
}

function publicState() {
  const s = state.selected;
  const lines = (state.lyrics && state.lyrics.lines) || [];
  const idx = state.lyricIndex;
  return {
    device: device.status(),
    smtc: { error: smtc.error },
    enabled: config.enabled,
    settings: {
      mode: config.mode, align: config.align, animation: config.animation,
      showTranslation: config.showTranslation, idleRestore: config.idleRestore,
      preferPlayer: config.preferPlayer,
    },
    playback: {
      active: !!s,
      status: s ? s.status : 'None',
      title: state.track ? state.track.title : '',
      artist: state.track ? state.track.artist : '',
      app: state.track ? state.track.appLabel : '',
      position: Math.round(state.position * 10) / 10,
      duration: state.track ? state.track.duration : 0,
    },
    lyrics: {
      status: state.lyrics ? state.lyrics.status : 'idle',
      source: state.lyrics ? state.lyrics.source : '',
      matched: state.lyrics ? state.lyrics.matched : '',
      reason: state.lyrics ? state.lyrics.reason || '' : '',
      score: state.lyrics ? state.lyrics.score || null : null,
      verified: state.lyricsVerified,
      index: idx,
      total: lines.length,
      current: idx >= 0 ? buildLineText(lines[idx]) : '',
      next: idx + 1 < lines.length ? lines[idx + 1].text : '',
      prev: idx > 0 ? lines[idx - 1].text : '',
      list: lines.slice(Math.max(0, idx - 3), idx + 6).map((l, i) => ({
        text: l.text,
        time: l.time,
        offset: Math.max(0, idx - 3) + i - idx,
      })),
    },
    sent: { text: state.lastSentText, lastAt: state.lastSendAt, info: state.lastSent || null },
    screen: { saved: state.savedScreen ? state.savedScreen.text : '', canRestore: !!(state.savedScreen && state.savedScreen.text) },
    logs: logs.slice(-40),
    now: Date.now(),
  };
}

const clients = new Set();
function broadcast() {
  const payload = 'data: ' + JSON.stringify(publicState()) + '\n\n';
  for (const res of clients) {
    try { res.write(payload); } catch (e) { clients.delete(res); }
  }
}
// SSE 心跳：防止长时间无歌时连接被中间层判定为空闲而断开
setInterval(() => {
  for (const res of clients) {
    try { res.write(': ping\n\n'); } catch (e) { clients.delete(res); }
  }
}, 15000).unref();

// 主歌词 tick（原来 700ms，现在 250ms）
setInterval(() => {
  if (state.selected) tick(Date.now());
  broadcast();
}, LYRIC_TICK_MS);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let done = false;
    req.on('data', (c) => {
      if (done) return;
      data += c;
      if (data.length > 1e6) {
        done = true;
        reject(new Error('请求体过大'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
    });
    req.on('error', (e) => { if (!done) { done = true; reject(e); } });
  });
}

const server = http.createServer(async (req, res) => {
  let url;
  let pathname;
  try {
    url = new URL(req.url, 'http://localhost');
    pathname = decodeURIComponent(url.pathname);
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('bad request');
    return;
  }

  if (pathname === '/api/state') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(publicState()));
    return;
  }

  if (pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('retry: 3000\n\n');
    res.write('data: ' + JSON.stringify(publicState()) + '\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (pathname.startsWith('/api/')) {
    let body = {};
    if (req.method === 'POST') {
      try { body = await readBody(req); } catch (e) { body = {}; }
    }
    try {
      if (pathname === '/api/settings') {
        const allow = ['enabled', 'mode', 'align', 'animation', 'showTranslation', 'idleRestore', 'preferPlayer'];
        for (const k of allow) {
          if (body[k] !== undefined) config[k] = body[k];
        }
        config.enabled = !!config.enabled;
        config.showTranslation = !!config.showTranslation;
        config.idleRestore = !!config.idleRestore;
        config.mode = config.mode === 'simple' ? 'simple' : 'extended';
        config.align = Math.max(0, Math.min(2, Number(config.align) || 0));
        config.animation = Math.max(0, Math.min(9, Number(config.animation) || 0));
        saveConfig();
        state.lastSentText = '';
        if (!config.enabled) restoreScreen(); else if (state.lyrics && state.lyrics.lines) state.lyricIndex = -1;
        log('info', `设置已更新：${config.mode === 'extended' ? '扩展' : '简洁'}模式 · 对齐 ${config.align} · 动画 ${config.animation}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, state: publicState() }));
        return;
      }

      if (pathname === '/api/test') {
        const text = String(body.text || 'K20 GT 歌词引擎');
        state.lastSentText = '';
        deviceSend(async () => {
          if (config.mode === 'simple') device.setLyricLineSimple(text, 0);
          else await device.setLyricLineExtended(text, { align: config.align, animation: config.animation });
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (pathname === '/api/restore') {
        await restoreScreen();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (pathname === '/api/reconnect') {
        device.open();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: device.status().connected }));
        return;
      }

      if (pathname === '/api/manual') {
        const title = String(body.title || '').trim();
        const artist = String(body.artist || '').trim();
        if (!title) throw new Error('请填写歌曲名');
        const base = state.selected;
        const forKey = base ? `${(base.title || '').trim()}|${(base.artist || '').trim()}|${base.app}` : '';
        const duration = base ? Number(base.duration) || 0 : 0;
        const manualTrack = { title, artist, app: 'manual', appLabel: '手动匹配', duration, key: `manual|${title}|${artist}` };
        state.manual = { forKey, track: manualTrack };
        state.track = manualTrack;
        state.lyricIndex = -1;
        state.lastSentText = '';
        await loadLyricsFor(manualTrack);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, lyrics: publicState().lyrics }));
        return;
      }

      if (pathname === '/api/push') {
        const text = String(body.text || '').trim();
        if (!text) throw new Error('text 不能为空');
        const source = String(body.source || 'plugin').trim();
        state.lastSentText = '';
        log('info', `插件推送歌词 [${source}]: ${text.slice(0, 30)}`);
        // pushLine 接收歌词行对象（{ text, trans }），不能直接传字符串
        await pushLine({ text });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, sent: state.lastSentText }));
        return;
      }

      if (pathname === '/api/sync') {
        const title = String(body.title || '').trim();
        const artist = String(body.artist || '').trim();
        const status = String(body.status || 'Stopped').trim();
        const app = String(body.app || 'plugin').trim();
        const position = Number(body.position) || 0;
        const duration = Number(body.duration) || 0;
        const key = `${title}|${artist}`;
        if (!state.track || state.track.key !== key) {
          state.track = { title, artist, app, key, duration, status, position };
          state.lyricIndex = -1;
          state.lastSentText = '';
          state.positionSmoothed = 0;
          state.positionHistory = [];
          if (title) {
            await loadLyricsFor({ title, artist, app, duration, status });
          }
        } else {
          state.track = { ...state.track, status, position };
        }
        // 插件模式：直接用插件给的 position，加上 offset
        if (status === 'Playing' && state.lyrics && state.lyrics.lines && state.lyrics.lines.length) {
          const idx = findLyricIndex(state.lyrics.lines, position + POSITION_OFFSET + 0.1);
          if (idx !== state.lyricIndex) {
            state.lyricIndex = idx;
            const line = state.lyrics.lines[idx];
            if (line && line.text && line.text !== state.lastSentText) await pushLine({ text: line.text });
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, lyricIndex: state.lyricIndex, total: state.lyrics ? state.lyrics.lines.length : 0 }));
        return;
      }

      if (pathname === '/api/refresh') {
        if (state.track && state.track.title) {
          state.lastSentText = '';
          state.lyricIndex = -1;
          state.lyricsVerified = false;
          state.lyricMismatchCount = 0;
          await loadLyricsFor(state.track, { force: true });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, lyrics: publicState().lyrics }));
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: '没有正在播放的歌曲' }));
        }
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'not found' }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  const publicRoot = path.join(__dirname, 'public');
  const filePath = path.join(publicRoot, pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, ''));
  const rel = path.relative(publicRoot, filePath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    res.writeHead(403); res.end('forbidden'); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('页面不存在'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用，歌词引擎可能已在运行。`);
    console.error(`打开 http://127.0.0.1:${PORT} 试试；如无法访问，请先关闭所有歌词引擎窗口再重试。`);
    process.exit(0);
  }
  console.error('[FATAL] server error:', err);
  throw err;
});

process.on('uncaughtException', (err, origin) => {
  console.error('[uncaughtException]', origin, err?.message || err);
  console.error(err?.stack || '');
  try { log('error', `进程异常：${err?.message || err}`); } catch (_) {}
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('[unhandledRejection]', reason?.message || reason);
  try { log('error', `Promise 异常：${reason?.message || reason}`); } catch (_) {}
});

server.listen(PORT, '127.0.0.1', () => {
  log('info', `控制台已启动：http://127.0.0.1:${PORT}`);
  log('info', '提示：如同时开启 M HUB 的歌词字幕，可能与本工具交替显示，建议只保留一个');
  initDevice().then(() => {
    smtc.start();
    log('info', `媒体监听已启动（${SMTC_POLL_MS}ms 轮询），等待播放器播放`);
  });
  setInterval(() => log('debug', 'heartbeat'), 30000).unref();
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  smtc.stop();
  // 退出前尽量把屏幕恢复成原来的文字，避免歌词残留在设备上
  try {
    if (state.savedScreen) device.setScreenText(state.savedScreen);
  } catch (e) { /* ignore */ }
  setTimeout(() => process.exit(0), 300);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGHUP', shutdown);

// 仅在由插件作为子进程启动时监听 stdin：父进程退出会关闭管道，借此恢复屏幕并退出
if (process.env.K20_PARENT_STDIN === '1') {
  try {
    process.stdin.resume();
    process.stdin.on('end', shutdown);
    process.stdin.on('close', shutdown);
    process.stdin.on('error', () => {});
  } catch (e) { /* ignore */ }
}
