'use strict';

const PLUGIN_VERSION = '1.0.0';
const DEBUG = !!process.env.K20_LYRIC_DEBUG;

/* 只记录、不拦截：避免把宿主 M HUB 的未捕获异常一并吞掉 */
try {
  process.on('uncaughtExceptionMonitor', function (e) {
    try {
      require('fs').appendFileSync(
        require('path').join(process.env.TEMP || '', 'k20_lyric_plugin.log'),
        new Date().toISOString() + ' [uncaught] ' + (e && e.stack || e) + '\n'
      );
    } catch (_) {}
  });
} catch (_) {}

/**
 * lyric-hub · K20 GT 歌词引擎 · M HUB 插件
 *
 * 点击链路：渲染端只设置 window.__K20_LYRICS_WANT_OPEN__ 标志 → 主进程轮询 → 打开内嵌页
 * 显示方式：自定义协议 + iframe 覆盖 M HUB 主窗口 header 以下区域
 */

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const BACKEND_PORT = 8720;
const BACKEND_DIR = path.join(__dirname, 'backend');
const TAB_SCRIPT_PATH = path.join(__dirname, 'renderer', 'tab-inject.js');

let backendProc = null;
let panelWin = null;
let tray = null;

let logStream = null;
function log() {
  try {
    if (!logStream) {
      const logPath = path.join(process.env.TEMP || '', 'k20_lyric_plugin.log');
      try {
        // 简单轮转：超过 512KB 就归档，避免日志无限增长
        const st = fs.statSync(logPath);
        if (st.size > 512 * 1024) fs.renameSync(logPath, logPath + '.old');
      } catch (_) {}
      logStream = fs.createWriteStream(logPath, { flags: 'a', encoding: 'utf8' });
    }
    const ts = new Date().toISOString().slice(11, 19);
    const msg = Array.prototype.map.call(arguments, a => {
      try { return typeof a === 'object' ? JSON.stringify(a) : String(a); } catch (_) { return String(a); }
    }).join(' ');
    logStream.write(ts + ' [lyric-hub] ' + msg + '\n');
  } catch (_) {}
}

/* ---------------- backend ---------------- */
function checkBackend(timeout = 1200) {
  return new Promise((resolve) => {
    let http;
    try { http = require('http'); } catch (_) { return resolve(false); }
    const req = http.request({ hostname: '127.0.0.1', port: BACKEND_PORT, path: '/api/state', timeout }, (res) => {
      res.resume(); resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

function startBackend() {
  const serverJs = path.join(BACKEND_DIR, 'server.js');
  if (!fs.existsSync(serverJs)) { log('FAIL backend/server.js missing'); return null; }
  let node = 'node';
  const portable = path.join(process.env.TEMP || '', 'lyric-hub-portable-node', 'node.exe');
  if (fs.existsSync(portable)) node = portable;
  log('spawn backend with', node);
  const proc = spawn(node, [serverJs], {
    cwd: BACKEND_DIR,
    windowsHide: true,
    env: Object.assign({}, process.env, { K20_PORT: String(BACKEND_PORT), K20_PARENT_STDIN: '1' }),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  // 父进程退出时 stdin 管道会关闭，后端据此恢复设备屏幕并自行退出（K20_PARENT_STDIN=1）
  proc.stdin.on('error', () => {});
  proc.stdout.on('data', c => { try { log('backend out: ' + String(c).trim().slice(0, 200)); } catch (_) {} });
  proc.stderr.on('data', c => { try { log('backend err: ' + String(c).trim().slice(0, 200)); } catch (_) {} });
  proc.on('exit', code => { log('backend exited ' + code); backendProc = null; });
  proc.on('error', e => log('backend spawn error ' + e.message));
  return proc;
}

/* ---------------- frame targeting ---------------- */
const REMOTE_HOSTS = ['mchose.com.cn', 'maicong.cn'];
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1'];

function parseUrl(u) { try { return new URL(u); } catch (_) { return null; } }
function isLocalHost(h) { return LOCAL_HOSTS.indexOf(h) >= 0; }
function isRemoteHost(h) {
  return REMOTE_HOSTS.some(r => h === r || h.endsWith('.' + r));
}
function isFrameTargetUrl(u) {
  const p = parseUrl(u); if (!p) return false;
  const proto = String(p.protocol || '').toLowerCase();
  if (proto !== 'http:' && proto !== 'https:') return false;
  const host = String(p.hostname || '').toLowerCase();
  return isLocalHost(host) || isRemoteHost(host);
}
function isAppShellUrl(u) {
  const p = parseUrl(u); if (!p) return false;
  return String(p.protocol || '').toLowerCase() === 'mchose-renderer:';
}
function frameTree(root) {
  const out = [];
  if (!root) return out;
  let subtree = null;
  try { subtree = root.framesInSubtree; } catch (_) {}
  if (Array.isArray(subtree) && subtree.length) {
    for (const f of subtree) if (f && out.indexOf(f) < 0) out.push(f);
    return out;
  }
  const stack = [root];
  while (stack.length) {
    const f = stack.pop();
    if (!f || out.indexOf(f) >= 0) continue;
    out.push(f);
    let kids = null;
    try { kids = f.frames; } catch (_) {}
    if (Array.isArray(kids)) for (const k of kids) stack.push(k);
  }
  return out;
}
function frameUrl(f) {
  try { return typeof f.url === 'string' ? f.url : ''; } catch (_) { return ''; }
}
function targetFrames(contents) {
  let mainFrame = null;
  try { mainFrame = contents.mainFrame; } catch (_) {}
  const frames = frameTree(mainFrame);
  if (!frames.length) return [];
  const hasRemote = frames.some(f => isFrameTargetUrl(frameUrl(f)));
  const out = [];
  for (const f of frames) {
    const u = frameUrl(f);
    if (!u) continue;
    if (isFrameTargetUrl(u)) { out.push(f); continue; }
    if (!hasRemote && isAppShellUrl(u)) out.push(f);
  }
  return out;
}

/* ---------------- tab injection ---------------- */
let tabScript = '';
try { tabScript = fs.readFileSync(TAB_SCRIPT_PATH, 'utf8'); }
catch (e) { log('FAIL read tab-inject.js: ' + e.message); }

const PROBE = `(function(){
  try {
    var n = document.querySelector('[data-k20-lyric-entry]');
    return JSON.stringify({
      injected: !!window.__lyricHubTabInjected,
      entry: !!n,
      bound: n ? !!n.__k20LyricBound : false,
      text: n ? (n.textContent||'').trim().slice(0,20) : '',
      parentCls: n && n.parentNode ? (n.parentNode.className||'') : '',
      wantOpen: window.__K20_LYRICS_WANT_OPEN__ || 0
    });
  } catch(e) { return 'probe err ' + e.message; }
})();`;

function injectTab(contents) {
  if (!contents || contents.isDestroyed() || !tabScript) return;
  const frames = targetFrames(contents);
  for (const f of frames) {
    const u = frameUrl(f);
    if (DEBUG) log('inject into ' + u.slice(0, 100));
    try {
      const p = f.executeJavaScript(tabScript, true);
      if (p && typeof p.catch === 'function') p.catch(() => {});
      if (DEBUG) {
        setTimeout(() => {
          try {
            const q = f.executeJavaScript(PROBE, true);
            if (q && typeof q.then === 'function') q.then(r => log('PROBE ' + u.slice(0, 60) + ' => ' + r)).catch(() => {});
          } catch (_) {}
        }, 600);
      }
    } catch (_) {}
  }
}

/* ---------------- panel (child window over driver UI) ---------------- */
/* ============================================================
 *  原生内嵌页（参考 pet-hub inline-page.js）
 *  自定义协议 mchose-lyric:// 提供 UI，iframe 盖住 header 以下区域
 * ============================================================ */
const UI_SCHEME = 'mchose-lyric';
const UI_ORIGIN = UI_SCHEME + '://ui/';
let inlineOpen = false;

function publicDir() {
  const cands = [
    path.join(__dirname, 'backend', 'public'),
    path.join(__dirname, 'public'),
    path.join(__dirname, '..', 'public'),
  ];
  for (const c of cands) if (fs.existsSync(c)) return c;
  return cands[0];
}

function registerUiScheme() {
  try {
    const { protocol } = require('electron');
    protocol.registerSchemesAsPrivileged([{
      scheme: UI_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
    }]);
    log('scheme registered');
  } catch (e) { log('registerUiScheme fail: ' + e.message); }
}

const MIME_MAP = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

function installUiProtocol() {
  try {
    const { protocol, net } = require('electron');
    const ROOT = publicDir();
    log('ui protocol root=' + ROOT);
    protocol.handle(UI_SCHEME, async (request) => {
      try {
        const u = new URL(request.url);
        if (u.hostname !== 'ui') return new Response('', { status: 403 });
        let p = decodeURIComponent(u.pathname || '/');
        if (!p || p === '/') p = '/index.html';

        // /api/* → 反向代理到本地后端（同源，无需 CORS）
        if (p.startsWith('/api/')) {
          const target = 'http://127.0.0.1:' + BACKEND_PORT + p + (u.search || '');
          try {
            const init = { method: request.method };
            if (request.method && request.method !== 'GET' && request.method !== 'HEAD') {
              init.body = Buffer.from(await request.arrayBuffer());
              init.headers = { 'Content-Type': request.headers.get('content-type') || 'application/json' };
            }
            return await net.fetch(target, init);
          } catch (e) { return new Response('', { status: 502 }); }
        }

        const segs = p.split('/').filter(Boolean);
        if (segs.some(s => s === '..' || s === '.')) return new Response('', { status: 403 });
        const file = path.resolve(ROOT, segs.join(path.sep));
        const rel = path.relative(ROOT, file);
        if (rel.startsWith('..') || path.isAbsolute(rel)) return new Response('', { status: 403 });
        const data = await fs.promises.readFile(file);
        return new Response(data, {
          headers: {
            'Content-Type': MIME_MAP[path.extname(file).toLowerCase()] || 'application/octet-stream',
            'Cache-Control': 'no-store',
          },
        });
      } catch (_) { return new Response('', { status: 404 }); }
    });
  } catch (e) { log('installUiProtocol fail: ' + e.message); }
}

/* ---- 注入到宿主页面的函数（必须自包含，不能引用外部变量） ---- */
function lyricMountBody(origin) {
  try { document.documentElement.classList.add('k20-lyric-open'); } catch (_) {}
  var headers = Array.prototype.slice.call(document.querySelectorAll('.app-header')).filter(function (e) {
    try { return e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden'; } catch (_) { return false; }
  });
  var top = headers.length ? Math.round(headers[0].getBoundingClientRect().bottom) : 80;

  var frame = document.getElementById('mchose-lyric-page');
  if (!frame) {
    frame = document.createElement('iframe');
    frame.id = 'mchose-lyric-page';
    frame.title = '歌词';
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
    frame.style.cssText = 'position:fixed;left:0;right:0;bottom:0;width:100%;border:0;background:#0c0e10;z-index:2147480000;display:block;color-scheme:dark;';
    frame.src = origin + 'index.html';
    document.body.appendChild(frame);
  }

  // 隐藏 header 的兄弟节点，避免底层页面透出/抢焦点
  if (headers[0] && !window.__k20HiddenSiblings) {
    window.__k20HiddenSiblings = [];
    var parent = headers[0].parentElement;
    for (var i = 0; i < parent.children.length; i++) {
      var el = parent.children[i];
      if (el === headers[0] || el.tagName === 'STYLE' || el.tagName === 'SCRIPT') continue;
      if (/background|wallpaper/i.test(el.className || '')) continue;
      window.__k20HiddenSiblings.push({
        el: el, inert: el.inert,
        v: el.style.getPropertyValue('visibility'),
        p: el.style.getPropertyPriority('visibility'),
      });
      el.style.setProperty('visibility', 'hidden', 'important');
      el.inert = true;
    }
  }

  frame.style.top = top + 'px';
  frame.style.height = 'calc(100% - ' + top + 'px)';
  frame.hidden = false;
  frame.style.display = 'block';

  if (!window.__k20LyricKeys) {
    window.__k20LyricKeys = true;
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') {
        window.__K20_LYRICS_WANT_CLOSE__ = (window.__K20_LYRICS_WANT_CLOSE__ || 0) + 1;
      }
    }, true);
    window.addEventListener('message', function (ev) {
      if (!ev || !ev.data) return;
      if (ev.data.k20 === 'close') {
        window.__K20_LYRICS_WANT_CLOSE__ = (window.__K20_LYRICS_WANT_CLOSE__ || 0) + 1;
      } else if (ev.data.k20 === 'ready') {
        window.__K20_IFRAME_READY__ = 1;
      }
    });
  }

  return top;
}

function lyricCloseBody() {
  try { document.documentElement.classList.remove('k20-lyric-open'); } catch (_) {}
  var hidden = window.__k20HiddenSiblings || [];
  for (var i = 0; i < hidden.length; i++) {
    var h = hidden[i];
    try {
      h.el.style.setProperty('visibility', h.v, h.p);
      h.el.inert = h.inert;
    } catch (_) {}
  }
  window.__k20HiddenSiblings = null;
  var f = document.getElementById('mchose-lyric-page');
  if (f) { try { f.style.display = 'none'; } catch (_) {} }
  return true;
}

function runInPage(win, code) {
  if (!win || win.isDestroyed()) return Promise.resolve(null);
  try {
    const p = win.webContents.executeJavaScript(code, true);
    return p && typeof p.then === 'function' ? p : Promise.resolve(p);
  } catch (_) { return Promise.resolve(null); }
}

async function openLyric() {
  const win = mainWindow();
  if (!win) { log('openLyric: no main window -> standalone'); openWindowFallback(); return; }
  const code = '(' + lyricMountBody.toString() + ')(' + JSON.stringify(UI_ORIGIN) + ');';
  const r = await runInPage(win, code);
  if (typeof r === 'number') {
    inlineOpen = true;
    log('inline open, header bottom=' + r);
  } else {
    inlineOpen = false;
    log('inline mount failed, fallback window');
    openWindowFallback();
  }
}

async function closeLyric() {
  const win = mainWindow();
  if (win) await runInPage(win, '(' + lyricCloseBody.toString() + ')();');
  inlineOpen = false;
  if (panelWin && !panelWin.isDestroyed()) {
    try { panelWin.destroy(); } catch (_) {}
  }
  panelWin = null;
  log('closed');
}

function toggleLyric() {
  if (inlineOpen) closeLyric();
  else openLyric();
}

/* ---- 兜底：独立子窗口（内嵌失败时） ---- */
const HEADER_OFFSET = 64;

function panelBounds(win) {
  let b;
  try { b = win.getContentBounds ? win.getContentBounds() : win.getBounds(); } catch (_) { b = win.getBounds(); }
  return { x: b.x, y: b.y + HEADER_OFFSET, width: b.width, height: Math.max(200, b.height - HEADER_OFFSET) };
}

function openWindowFallback() {
  const win = mainWindow();
  try {
    const { BrowserWindow } = require('electron');
    const b = win ? panelBounds(win) : { width: 1100, height: 720 };
    if (panelWin && !panelWin.isDestroyed()) { panelWin.show(); panelWin.focus(); return; }
    panelWin = new BrowserWindow({
      x: b.x, y: b.y, width: b.width, height: b.height,
      parent: win || undefined,
      frame: false, show: false, skipTaskbar: true,
      backgroundColor: '#0c0e10',
    });
    panelWin.loadURL('http://127.0.0.1:' + BACKEND_PORT + '/');
    panelWin.once('ready-to-show', () => panelWin.show());
    panelWin.on('closed', () => { panelWin = null; });
    log('fallback window opened');
  } catch (e) { log('openWindowFallback fail: ' + e.message); }
}

function isMainWindow(win) {
  if (!win || win.isDestroyed()) return false;
  if (panelWin && win === panelWin) return false;
  try {
    const u = win.webContents.getURL() || '';
    if (/(?:^|\/)tray\.html/i.test(u)) return false;
    if (u.startsWith('http://127.0.0.1:' + BACKEND_PORT)) return false;
    return true;
  } catch (_) { return false; }
}
function mainWindow() {
  try {
    const { BrowserWindow } = require('electron');
    const wins = BrowserWindow.getAllWindows().filter(isMainWindow);
    const shell = wins.filter(w => {
      try { return (w.webContents.getURL() || '').startsWith('mchose-renderer:'); } catch (_) { return false; }
    });
    return shell[0] || wins[0] || null;
  } catch (_) { return null; }
}

/* ---------------- click bridge: poll window flags ---------------- */
const POLL = `(function(){
  var o = window.__K20_LYRICS_WANT_OPEN__ || 0;
  var c = window.__K20_LYRICS_WANT_CLOSE__ || 0;
  if (o) window.__K20_LYRICS_WANT_OPEN__ = 0;
  if (c) window.__K20_LYRICS_WANT_CLOSE__ = 0;
  var f = document.getElementById('mchose-lyric-page');
  var v = !!(f && f.style.display !== 'none');
  return { o: o, c: c, v: v };
})()`;

function startClickPoll() {
  setInterval(async () => {
    const win = mainWindow();
    if (!win || win.isDestroyed()) return;
    let r = null;
    try { r = await win.webContents.executeJavaScript(POLL, true); } catch (_) { return; }
    if (!r) return;
    if (r.o > 0) {
      log('CLICK open=' + r.o);
      if (inlineOpen) closeLyric(); else openLyric();
    } else if (r.c > 0) {
      log('CLICK close=' + r.c);
      closeLyric();
    } else {
      // 无点击时用 DOM 真实状态校准（页面重载后 iframe 消失）
      inlineOpen = !!r.v;
    }
  }, 300);
}

/* ---------------- attach windows ---------------- */
function attachWindow(win) {
  if (!win || win.isDestroyed()) return;
  if (!isMainWindow(win)) return;  // 跳过托盘、歌词兜底窗等非主窗口
  const c = win.webContents;
  if (!c || c.isDestroyed() || c.__k20Attached) return;
  c.__k20Attached = true;

  let url = '';
  try { url = c.getURL().slice(0, 110); } catch (_) {}
  log('attach ' + url);

  const tryInject = () => { if (isMainWindow(win)) injectTab(c); };
  c.on('dom-ready', () => setTimeout(tryInject, 1200));
  c.on('did-finish-load', () => setTimeout(tryInject, 1000));
  c.on('did-frame-finish-load', () => setTimeout(tryInject, 1000));
  c.on('did-navigate', () => setTimeout(tryInject, 1200));
  c.on('did-navigate-in-page', () => setTimeout(tryInject, 800));

  setTimeout(tryInject, 1500);
}

function attachAll() {
  try {
    const { BrowserWindow } = require('electron');
    for (const w of BrowserWindow.getAllWindows()) attachWindow(w);
  } catch (_) {}
}

/* ---------------- boot ---------------- */
async function boot() {
  log('=== lyric-hub ' + PLUGIN_VERSION + ' boot ===');

  installUiProtocol();

  let ok = await checkBackend();
  if (!ok) {
    backendProc = startBackend();
    for (let i = 0; i < 24 && !ok; i++) {
      await new Promise(r => setTimeout(r, 500));
      ok = await checkBackend();
    }
  }
  log(ok ? 'backend ready' : 'backend NOT ready');

  try {
    const { globalShortcut } = require('electron');
    const reg = globalShortcut.register('CommandOrControl+Alt+K', () => toggleLyric());
    log('hotkey ' + (reg ? 'OK' : 'FAIL'));
  } catch (e) { log('hotkey skip ' + e.message); }

  try {
    const { Tray, Menu, nativeImage } = require('electron');
    const icon = nativeImage.createFromBuffer(Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAABlJREFUWEft0ENJACAQQNOx4fLg0xJ8QhgY0F0XlBwUJ9P4f3/6H4xwAAI5+AF5FfF3dYAAAAASUVORK5CYII=', 'base64'));
    tray = new Tray(icon);
    tray.setToolTip('K20 GT 歌词引擎 · Ctrl+Alt+K');
    tray.on('click', () => toggleLyric());
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开歌词面板', click: () => openLyric() },
      { label: '关闭歌词面板', click: () => closeLyric() },
      { type: 'separator' },
      { label: '快捷键 Ctrl+Alt+K', enabled: false },
    ]));
    log('tray OK');
  } catch (e) { log('tray skip ' + e.message); }

  try {
    const { BrowserWindow } = require('electron');
    BrowserWindow.on('created', (win) => setTimeout(() => attachWindow(win), 1500));
  } catch (_) {}

  setTimeout(attachAll, 1500);
  startClickPoll();

  // 周期性检查主窗口是否已 attach
  setInterval(() => {
    const win = mainWindow();
    if (win && !win.webContents.__k20Attached) attachWindow(win);
  }, 2000);

  log('=== ready ===');
}

function shutdown() {
  try { require('electron').globalShortcut.unregisterAll(); } catch (_) {}
  // 不强制 kill 后端：父进程退出后 stdin 管道关闭，后端会恢复设备屏幕并自行退出
  backendProc = null;
}

if (typeof process !== 'undefined' && process.type === 'browser') {
  log('branch=browser');
  try {
    const { app } = require('electron');
    registerUiScheme(); // 必须在 app ready 之前注册
    log('electron required, isReady=' + (app && app.isReady ? app.isReady() : 'n/a'));
    const start = () => { log('start boot'); setTimeout(boot, 1500); };
    if (app && typeof app.whenReady === 'function') {
      app.whenReady().then(() => { log('whenReady resolved'); start(); }, (err) => { log('whenReady rejected: ' + (err && err.message)); start(); });
    } else {
      start();
    }
  } catch (e) {
    log('browser branch threw: ' + (e && e.message));
    boot();
  }
  process.on('exit', shutdown);
} else {
  module.exports = { boot, shutdown, toggleLyric };
}
