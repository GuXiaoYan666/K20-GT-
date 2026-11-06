'use strict';
/**
 * 迈从 K20 GT 屏幕通信模块
 * 协议：MCHOSE MC 帧（HID 输出报告 0xBC，63 字节）
 * 参考：M HUB 官方驱动页所下发的 MC 命令格式
 */
const { EventEmitter } = require('events');
const HID = require('node-hid');

const VID = 0x3837;
const PID = 0x60c6;
const REPORT_ID = 0xbc;
const FRAME_LEN = 63;
const START = 0xaa;
const VERSION = 1;

const MAX_LYRIC_BYTES = 51;      // 单行歌词上屏上限
const MAX_CUSTOM_TEXT_BYTES = 51;
const PACKET_BYTES = 45;         // 扩展歌词分片上限

const SUB = {
  SCREEN_STATE: 1,
  LYRIC_STATE: 2,
  SCREEN_TEXT: 7,
  SET_SCREEN_STATE: 9,
  SET_THEME: 10,
  SET_LYRICS: 11,
  SET_SCREEN_TIME: 15,
  LYRIC_SETTINGS: 17,
  SET_SCREEN_TEXT: 29,
  SET_EXTENDED_LYRICS: 39,
};

const TYPE = { REQUEST: [0, 1], SET: [0, 2], NOTIFY: [0, 4] };

function buildFrame(type, sub, body = []) {
  const b = Array.from(body);
  const len = b.length + 1;
  const f = new Uint8Array(FRAME_LEN);
  f[0] = START;
  f[1] = VERSION;
  f[2] = 0;          // check 标志位为 0
  f[3] = len;
  f[4] = type[0];
  f[5] = type[1];
  f[6] = sub;
  f.set(b, 7);
  f[7 + b.length] = 0;
  return Array.from(f);
}

function truncateUtf8(text, maxBytes) {
  const bytes = Buffer.from(String(text || ''), 'utf8');
  if (bytes.length <= maxBytes) return { bytes: Array.from(bytes), truncated: false };
  let end = maxBytes;
  while (end > 0) {
    try {
      const slice = bytes.slice(0, end);
      const str = slice.toString('utf8');
      if (!str.endsWith('\uFFFD')) return { bytes: Array.from(slice), truncated: true };
    } catch (e) { /* ignore */ }
    end -= 1;
  }
  return { bytes: [], truncated: true };
}

function bytesToText(bytes) {
  return Buffer.from(bytes, 'utf8').toString('utf8');
}

function findControlPath() {
  let devices = [];
  try { devices = HID.devices() || []; } catch (e) { return null; }
  const matched = devices.filter(d => d.vendorId === VID && d.productId === PID);
  if (!matched.length) return null;
  const preferred = matched.find(d => (d.interface || -1) === 3 && /Col01/i.test(d.path || ''))
    || matched.find(d => /MI_03&Col01/i.test(d.path || ''))
    || matched[0];
  return preferred.path || null;
}

class K20Device extends EventEmitter {
  constructor() {
    super();
    this.device = null;
    this.path = null;
    this.connected = false;
    this.pending = new Map();
    this.lastError = '';
    this.reconnectTimer = null;
  }

  open() {
    const path = findControlPath();
    if (!path) {
      this._setDisconnected('未检测到 K20 GT（请确认 USB 已连接）');
      return false;
    }
    try {
      const dev = new HID.HID(path);
      this.device = dev;
      this.path = path;
      this.connected = true;
      this.lastError = '';
      dev.on('data', (data) => this._onData(data));
      dev.on('error', (err) => {
        this.lastError = err.message;
        this._setDisconnected(err.message);
      });
      this.emit('status', this.status());
      return true;
    } catch (err) {
      this.lastError = err.message;
      this._setDisconnected(err.message);
      return false;
    }
  }

  ensureOpen() {
    if (this.connected && this.device) return true;
    if (this.reconnectTimer) return false;
    return this.open();
  }

  _setDisconnected(reason) {
    const was = this.connected;
    this.connected = false;
    try { this.device && this.device.close(); } catch (e) { /* ignore */ }
    this.device = null;
    this.lastError = reason || '';
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason || '设备未连接'));
    }
    this.pending.clear();
    if (was) this.emit('status', this.status());
    if (!this.reconnectTimer) {
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.open();
      }, 3000);
    }
  }

  _onData(raw) {
    let buf = Array.from(raw);
    if (buf.length > FRAME_LEN && buf[0] === REPORT_ID) buf = buf.slice(1);
    if (buf[0] !== START) return;
    const len = buf[3];
    const type = [buf[4], buf[5]];
    const sub = buf[6];
    const body = buf.slice(7, 7 + Math.max(0, len - 1));
    if (type[1] === 1) {
      const p = this.pending.get(sub);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(sub);
        p.resolve(body);
      }
      this.emit('response', { sub, body });
    } else {
      this.emit('notify', { sub, body });
    }
  }

  write(sub, body = [], type = TYPE.SET) {
    if (!this.ensureOpen() || !this.device) throw new Error('设备未连接');
    const frame = buildFrame(type, sub, body);
    try {
      this.device.write([REPORT_ID, ...frame]);
    } catch (err) {
      this.lastError = err.message;
      this._setDisconnected(err.message);
      throw err;
    }
  }

  request(sub, body = [], timeout = 900) {
    return new Promise((resolve, reject) => {
      if (!this.ensureOpen()) return reject(new Error('设备未连接'));
      const timer = setTimeout(() => {
        this.pending.delete(sub);
        reject(new Error('设备响应超时'));
      }, timeout);
      this.pending.set(sub, { resolve, reject, timer });
      try { this.write(sub, body, TYPE.REQUEST); } catch (err) {
        clearTimeout(timer);
        this.pending.delete(sub);
        reject(err);
      }
    });
  }

  async readScreenState() {
    const body = await this.request(SUB.SCREEN_STATE);
    return { raw: body, enabled: body[0] === 1, mode: body[4] };
  }

  async readLyricState() {
    const body = await this.request(SUB.LYRIC_STATE);
    return {
      raw: body,
      enabled: body[0] === 1,
      scroll: body[1],
      text: bytesToText(body.slice(3, 3 + (body[2] || 0))),
    };
  }

  async readLyricSettings() {
    const body = await this.request(SUB.LYRIC_SETTINGS);
    return {
      raw: body,
      enabled: body[0] === 1,
      font: body[1] || 0,
      fontSize: body[2] || 0,
      align: body[3] ?? 1,
      direction: body[4] || 0,
      animation: body[5] ?? 9,
    };
  }

  async readScreenText() {
    const body = await this.request(SUB.SCREEN_TEXT);
    const len = Math.min(body[3] || 0, MAX_CUSTOM_TEXT_BYTES);
    return {
      raw: body,
      type: body[0] || 0,
      align: body[1] || 1,
      scroll: body[2] || 0,
      text: bytesToText(body.slice(4, 4 + len)),
    };
  }

  /** 简洁歌词模式：仅一行，最多 51 字节 */
  setLyricLineSimple(text, scroll = 0) {
    const t = truncateUtf8(text, MAX_LYRIC_BYTES);
    this.write(SUB.SET_LYRICS, [1, scroll ? 1 : 0, t.bytes.length, ...t.bytes]);
    return t;
  }

  /**
   * 扩展歌词模式：支持字号、对齐、动画与长句分片
   */
  async setLyricLineExtended(text, opts = {}) {
    const { font = 0, fontSize = 0, align = 1, direction = 0, animation = 9, enabled = true } = opts;
    const bytes = Buffer.from(String(text || ''), 'utf8');
    const total = bytes.length;
    const chunks = [];
    for (let i = 0; i < total; i += PACKET_BYTES) chunks.push(bytes.slice(i, i + PACKET_BYTES));
    if (!chunks.length) chunks.push(Buffer.alloc(0));
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      this.write(SUB.SET_EXTENDED_LYRICS, [
        enabled ? 1 : 0,
        font & 0xff,
        fontSize & 0xff,
        align & 0xff,
        direction & 0xff,
        animation & 0xff,
        chunks.length,
        Math.min(total, 255),
        i + 1,
        c.length,
        ...Array.from(c),
      ]);
      if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 2));
    }
    return { packets: chunks.length, bytes: total };
  }

  /** 恢复屏幕自定义文字（空闲时退出歌词模式） */
  setScreenText({ type = 0, align = 1, scroll = 0, text = '' }) {
    const t = truncateUtf8(text, MAX_CUSTOM_TEXT_BYTES);
    this.write(SUB.SET_SCREEN_TEXT, [type, align, scroll ? 1 : 0, t.bytes.length, ...t.bytes]);
    return t;
  }

  status() {
    return {
      connected: this.connected,
      path: this.path,
      reportId: REPORT_ID,
      lastError: this.lastError,
    };
  }
}

module.exports = { K20Device, buildFrame, SUB, TYPE, MAX_LYRIC_BYTES, MAX_CUSTOM_TEXT_BYTES, truncateUtf8, findControlPath };
