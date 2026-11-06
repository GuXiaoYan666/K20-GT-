'use strict';
/**
 * Windows 媒体会话（SMTC）监听
 * 通过常驻 PowerShell 进程读取全局媒体会话，任何注册 SMTC 的播放器都能被识别：
 * 汽水音乐、酷狗、酷我、洛雪音乐（LX Music）等。
 */
const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const path = require('path');

class SmtcMonitor extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.interval = opts.interval || 500;
    this.proc = null;
    this.stopped = false;
    this.lastPayload = null;
    this.restartTimer = null;
    this.error = '';
  }

  start() {
    this.stopped = false;
    if (this.proc) return;
    const script = path.join(__dirname, 'smtc.ps1');
    const env = { ...process.env, K20_SMTC_INTERVAL: String(this.interval) };
    let proc;
    try {
      proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
        windowsHide: true,
        env,
      });
    } catch (err) {
      this.error = err.message;
      this._scheduleRestart();
      return;
    }
    this.proc = proc;
    let buffer = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      buffer += chunk;
      const parts = buffer.split(/\r?\n/);
      buffer = parts.pop() || '';
      for (const line of parts) {
        const s = line.trim();
        if (!s || s[0] !== '{') continue;
        try {
          const payload = JSON.parse(s);
          if (payload.ok) {
            this.error = '';
            this.lastPayload = payload;
            this.emit('sessions', payload);
          } else {
            this.error = payload.error || 'SMTC 初始化失败';
            this.emit('error', this.error);
          }
        } catch (e) { /* 忽略半行 */ }
      }
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk) => {
      const s = String(chunk).trim();
      if (s) this.emit('stderr', s);
    });
    proc.on('exit', () => {
      this.proc = null;
      if (!this.stopped) {
        this.error = '媒体监听进程已退出，正在重启';
        this.emit('error', this.error);
        this._scheduleRestart();
      }
    });
    proc.on('error', (err) => {
      // 没有 error 监听器时，子进程 error 事件会导致主进程崩溃
      this.proc = null;
      this.error = '媒体监听启动失败：' + err.message;
      this.emit('error', this.error);
      this._scheduleRestart();
    });
  }

  _scheduleRestart() {
    if (this.stopped) return;
    if (this.restartTimer) return;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.start();
    }, 2500);
  }

  stop() {
    this.stopped = true;
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
    if (this.proc) {
      try { this.proc.kill(); } catch (e) { /* ignore */ }
      this.proc = null;
    }
  }
}

module.exports = { SmtcMonitor };
