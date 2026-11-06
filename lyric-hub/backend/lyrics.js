'use strict';
/**
 * 歌词检索引擎 v2
 * - 网易云 / QQ音乐 / 酷狗 / 酷我
 * - 多源全检索 + 最佳匹配（不是第一个搜到的就用）
 * - 严格评分：只接受分数 >=70% 置信度的结果
 * - 歌名归一化：去括号后缀、拆 camelCase、清理标点
 * - 本地缓存（含 notFound 缓存 30 分钟）
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const CACHE_DIR = path.join(__dirname, 'data', 'lyrics');
const NOT_FOUND_TTL = 30 * 60 * 1000;
const FETCH_TIMEOUT = 9000;

function ensureDir() {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
}
ensureDir();

function cacheKey(title, artist, duration) {
  const parts = [String(title || '').trim().toLowerCase(), String(artist || '').trim().toLowerCase()];
  if (duration && Number(duration) > 0) parts.push(Math.round(Number(duration)));
  return crypto.createHash('md5').update(parts.join('|')).digest('hex');
}

function fetchUrl(url, headers = {}, timeout = FETCH_TIMEOUT, parser = 'json') {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  return fetch(url, { headers: { 'User-Agent': UA, ...headers }, signal: ctrl.signal })
    .then(async (r) => {
      const text = await r.text();
      if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + text.slice(0, 80));
      return text;
    })
    .then((txt) => parser === 'json' ? JSON.parse(txt) : txt)
    .finally(() => clearTimeout(timer));
}

/* ---------- 评分系统 ----------
 * 每个维度 0 分最好，分数越低越匹配
 * durationScore: 0 (完美/未知) → 10 (差极大)
 * artistScore:   0 (匹配或缺失) → 8 (明显不对)
 * titleScore:    0 (精确) → 10 (明显不对)
 * 加权总分:  durationScore*0.25 + artistScore*0.35 + titleScore*0.40
 * 置信度 = max(0, 100 - normalizedScore * 8)
 * 接受条件: 置信度 >= 60
 */

function durationScore(durA, durB) {
  const a = Number(durA), b = Number(durB);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return 0;
  const diff = Math.abs(a - b);
  if (diff < 1.5) return 0;       // 完美匹配
  if (diff < 5) return 1;         // 差异小
  if (diff < 15) return 3;        // 中等差异
  if (diff < 30) return 6;        // 明显差异
  return 10;                      // 完全不对
}

function artistMatchScore(a, b) {
  if (!a || !b) return 0;  // 缺 artist 不扣分
  const norm = (s) => String(s || '').toLowerCase().replace(/[\s·.,&/\-·、]+/g, '').trim();
  const x = norm(a), y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 0;
  if (x.includes(y) || y.includes(x)) return 1;
  // 部分重叠计算
  const overlap = x.split('').filter(c => y.includes(c)).length / Math.max(x.length, y.length);
  if (overlap > 0.6) return 4;  // 部分相似
  return 8;  // 明显不对
}

function titleMatchScore(a, b) {
  if (!a || !b) return 4;
  const norm = (s) => normalizeTitle(s).toLowerCase().replace(/\s+/g, '');
  const x = norm(a), y = norm(b);
  if (!x || !y) return 4;
  if (x === y) return 0;
  if (x.includes(y) || y.includes(x)) return 1;
  // 去掉专辑/EP/单曲 后缀再比
  const clean = (s) => s.replace(/[（(](?:\d+|专辑|EP|单曲|single|album)[）)]$/i, '');
  const cx = clean(x), cy = clean(y);
  if (cx === cy) return 2;
  if (cx.includes(cy) || cy.includes(cx)) return 2;
  // 字符级相似度
  const len = Math.max(cx.length, cy.length);
  let matches = 0;
  for (const c of cx) if (cy.includes(c)) matches++;
  const sim = matches / len;
  if (sim > 0.85) return 3;
  if (sim > 0.65) return 6;
  return 10;  // 完全不对
}

/** 计算加权总分（越低越好） */
function computeScore({ duration, artist, title }, target) {
  const ds = durationScore(target.duration, duration);
  const as = artistMatchScore(target.artist, artist);
  const ts = titleMatchScore(target.title, title);
  const total = ds * 0.25 + as * 0.35 + ts * 0.40;
  // 置信度：100 - total * 8，封顶 100，保底 0
  const confidence = Math.max(0, Math.min(100, Math.round(100 - total * 8)));
  return {
    ds, as, ts,
    total: Math.round(total * 100) / 100,
    confidence,
  };
}

/** 判定是否值得信任（严格条件）
 *  - 置信度 >= 80% 总体通过
 *  - title 必须匹配良好 (ts <= 4，即至少有 60% 相似度)
 *  - artist 如果两边都有，必须匹配良好 (as <= 4)
 */
const MIN_CONFIDENCE = 80;
function isTrustworthy(score) {
  if (score.confidence < MIN_CONFIDENCE) return false;
  if (score.ts > 4) return false;  // 歌名差太大直接拒
  return true;
}

/** 歌名归一化 */
function normalizeTitle(title) {
  if (!title) return '';
  let t = String(title).trim();
  // 去掉括号里的 (feat. xxx)、[live]、(Remix) 等后缀
  t = t.replace(/\([^)]*(?:feat|remix|live|acoustic|unplugged|studio|demo|album|single|版|original|ver\.?|version|live studio session|live at)[^)]*\)/gi, '');
  t = t.replace(/\[[^\]]*(?:feat|remix|live|acoustic|版|original)[^\]]*\]/gi, '');
  t = t.replace(/（[^）]*?(?:feat|Remix|Live|版|伴奏|翻唱|现场|钢琴|吉他|纯音乐|inst|karaoke)[^）]*?）/gi, '');
  // 去掉尾部 remix / live / acoustic 等（不依赖括号）
  t = t.replace(/\s*(?:-\s*|\b)(?:remix|remastered|reissue|repack|deluxe|special|anniversary|live|acoustic|unplugged|demo|mix|edit|short|intro|outro)\b.*$/gi, '');
  t = t.replace(/^[-—_]+\s*/, '').replace(/\s*[-—_]+\s*$/, '');
  // 去掉标点
  t = t.replace(/[·.,，。！？!@#$%^&*()_+={}|\[\]\\<>\/~`';:'",。、]/g, '');
  // camelCase 拆分
  t = t.replace(/(?<!^)(?=[A-Z])/g, ' ')
       .replace(/([a-z])([A-Z])/g, '$1 $2')
       .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
       .replace(/([a-zA-Z])(\d)/g, '$1 $2')
       .replace(/(\d)([a-zA-Z])/g, '$1 $2');
  t = t.replace(/[_-]+/g, ' ');
  // feat/ft 后面全去掉
  t = t.replace(/\bfeat[.\s\S]*$/i, '').replace(/\bft[.\s\S]*$/i, '');
  return t.trim();
}

/** 多组搜索词（只保留歌名，歌手由各歌词源拼接，避免重复） */
function buildSearchQueries(title) {
  const rawTitle = String(title || '').trim();
  const normTitle = normalizeTitle(rawTitle);
  const queries = [];
  const push = (kw) => { const k = String(kw).trim(); if (k && !queries.includes(k)) queries.push(k); };
  if (normTitle) push(normTitle);
  if (rawTitle && rawTitle !== normTitle) push(rawTitle);
  if (!queries.length && rawTitle) push(rawTitle);
  return queries;
}

/* ---------- LRC 解析 ---------- */
function parseLrc(lrcText, transText) {
  const lines = [];
  const transMap = new Map();
  const timeRe = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
  const creditRe = /^(作词|作曲|编曲|制作人|制作|监制|混音|录音|母带|发行|出品|演唱|和声|吉他|贝斯|鼓|弦乐|统筹|策划|企划|宣传|词|曲|词曲|原唱|改编|OP|SP|Produced|Producer|Composer|Lyricist|Arranger|Mixed|Mastered|Recorded|封面|美术|MV|钢琴|吉他手)\s*[:：]/i;

  function scan(text, isTrans) {
    if (!text) return;
    for (const raw of text.split(/\r?\n/)) {
      const stamps = [];
      let m;
      timeRe.lastIndex = 0;
      while ((m = timeRe.exec(raw)) !== null) {
        const min = parseInt(m[1], 10);
        const sec = parseInt(m[2], 10);
        const fracRaw = m[3] || '0';
        const frac = fracRaw.length === 3 ? parseInt(fracRaw, 10) / 1000
          : fracRaw.length === 2 ? parseInt(fracRaw, 10) / 100
            : parseInt(fracRaw, 10) / 10;
        stamps.push(min * 60 + sec + frac);
      }
      let textContent = raw.replace(timeRe, '').replace(/<[^>]+>/g, '').trim();
      // 兼容酷我这类“纯秒数”时间戳：[123.45]歌词
      if (!stamps.length) {
        const sec = raw.match(/^\s*\[(\d{1,4}(?:\.\d{1,3})?)\]/);
        if (sec) {
          stamps.push(parseFloat(sec[1]));
          textContent = raw.replace(/^\s*\[[^\]]*\]/, '').replace(/<[^>]+>/g, '').trim();
        }
      }
      // Kuwo AI 垃圾行
      if (!isTrans && /本字幕由.*(?:AI|生成|创作|制作|字幕组)/i.test(textContent)) continue;
      if (!isTrans && creditRe.test(textContent)) continue;
      if (!stamps.length) continue;
      for (const t of stamps) {
        if (isTrans) {
          if (textContent) transMap.set(t.toFixed(2), textContent);
        } else if (textContent) {
          lines.push({ time: t, text: textContent });
        }
      }
    }
  }

  scan(lrcText, false);
  scan(transText, true);

  return lines.map(l => ({ ...l, trans: transMap.get(l.time.toFixed(2)) || '' }))
    .sort((a, b) => a.time - b.time)
    .filter((l, i, arr) => {
      if (i === 0) return true;
      const prev = arr[i - 1];
      if (Math.abs(prev.time - l.time) < 0.2 && prev.text === l.text) return false;
      return true;
    });
}

/* ---------- 歌词源 ---------- */
async function fromNetease(title, artist, duration) {
  const search = await fetchUrl('https://music.163.com/api/search/get?s=' + encodeURIComponent(`${title} ${artist}`.trim()) + '&type=1&limit=10', {
    Referer: 'https://music.163.com/',
  });
  const songs = (search && search.result && search.result.songs) || [];
  if (!songs.length) throw new Error('网易云未搜索到');
  const candidates = songs.map(s => ({
    id: s.id,
    duration: (s.duration || 0) / 1000,
    artist: (s.artists || s.ar || []).map(a => a.name).join('/'),
    title: s.name || '',
    album: (s.album || {}).name || '',
  }));
  const scored = candidates.map(c => ({ c, score: computeScore(c, { title, artist, duration }) }));

  const results = [];
  for (const { c, score } of scored.slice(0, 5)) {
    try {
      const lyric = await fetchUrl('https://music.163.com/api/song/lyric?id=' + c.id + '&lv=-1&kv=-1&tv=-1', {
        Referer: 'https://music.163.com/',
      });
      const lrc = lyric && lyric.lrc && lyric.lrc.lyric;
      if (!lrc) continue;
      results.push({
        source: '网易云音乐',
        lrc, trans: lyric.tlyric && lyric.tlyric.lyric,
        matched: `${c.title} · ${c.artist}${c.album ? ' [' + c.album + ']' : ''}`,
        duration: c.duration, score,
      });
    } catch (e) { /* skip */ }
  }
  if (!results.length) throw new Error('网易云无歌词');
  return results;
}

async function fromQQ(title, artist, duration) {
  const q = `${title} ${artist}`.trim();
  const search = await fetchUrl(
    'https://c.y.qq.com/soso/fcgi-bin/client_search_cp?p=1&n=10&w=' + encodeURIComponent(q) + '&format=json',
    { Referer: 'https://y.qq.com/' }
  );
  const list = (search && search.data && search.data.song && search.data.song.list) || [];
  if (!list.length) throw new Error('QQ音乐未搜索到');

  const candidates = list.map(s => ({
    songmid: s.songmid,
    duration: Number(s.interval) || 0,
    artist: (s.singer || []).map(x => x.name).join('/'),
    title: s.songname || '',
    album: (s.album || {}).name || '',
  }));
  const scored = candidates.map(c => ({ c, score: computeScore(c, { title, artist, duration }) }));

  const results = [];
  for (const { c, score } of scored.slice(0, 5)) {
    try {
      const lyric = await fetchUrl(
        'https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=' + c.songmid + '&format=json&nobase64=1&g_tk=5381',
        { Referer: 'https://y.qq.com/' }
      );
      const lrc = lyric && lyric.lyric;
      if (!lrc) continue;
      results.push({
        source: 'QQ音乐',
        lrc, trans: lyric.trans || '',
        matched: `${c.title} · ${c.artist}`,
        duration: c.duration, score,
      });
    } catch (e) { /* skip */ }
  }
  if (!results.length) throw new Error('QQ音乐无歌词');
  return results;
}

async function fromKugou(title, artist, duration) {
  const q = `${title} ${artist}`.trim();
  const search = await fetchUrl('http://mobilecdn.kugou.com/api/v3/search/song?format=json&keyword=' + encodeURIComponent(q) + '&page=1&pagesize=10&showtype=1');
  const info = (search && search.data && search.data.info) || [];
  if (!info.length) throw new Error('酷狗未搜索到');

  const candidates = info.map(s => ({
    hash: s.hash,
    duration: Number(s.duration) || 0,
    artist: s.singername || s.singer_name || '',
    title: s.songname || '',
  }));
  const scored = candidates.map(c => ({ c, score: computeScore(c, { title, artist, duration }) }));

  const results = [];
  for (const { c, score } of scored.slice(0, 3)) {
    try {
      const candidates2 = await fetchUrl('https://krcs.kugou.com/search?ver=1&man=yes&client=mobi&keyword=&duration=' + c.duration + '&hash=' + c.hash + '&album_id=&lrcx=1');
      const list = (candidates2 && candidates2.candidates) || [];
      for (const cand of list.slice(0, 3)) {
        try {
          const dl = await fetchUrl('https://lyrics.kugou.com/download?ver=1&client=pc&id=' + cand.id + '&accesskey=' + encodeURIComponent(cand.accesskey) + '&fmt=lrc&charset=utf8');
          if (!dl || !dl.content) continue;
          const text = Buffer.from(dl.content, 'base64').toString('utf8');
          if (text) {
            results.push({
              source: '酷狗音乐',
              lrc: text, trans: '',
              matched: `${cand.song || c.title} · ${cand.singer || c.artist}`,
              duration: Number(cand.duration) || c.duration, score,
            });
            break;
          }
        } catch (e) { /* skip inner */ }
      }
    } catch (e) { /* skip */ }
  }
  if (!results.length) throw new Error('酷狗无歌词');
  return results;
}

async function fromKuwo(title, artist, duration) {
  const q = `${title} ${artist}`.trim();
  const raw = await fetchUrl(
    'http://search.kuwo.cn/r.s?all=' + encodeURIComponent(q) + '&ft=music&itemset=web_2013&client=kt&pn=0&rn=10&rformat=json&encoding=utf8',
    {}, FETCH_TIMEOUT, 'text'
  );
  const search = JSON.parse(raw.replace(/'/g, '"').replace(/\bNone\b/g, 'null'));
  const list = (search && search.abslist) || [];
  if (!list.length) throw new Error('酷我未搜索到');

  const candidates = list.map(s => ({
    duration: Number(s.DURATION) || 0,
    artist: s.ARTIST || '',
    title: (s.SONGNAME || '').replace(/&nbsp;/g, ' ').replace(/<[^>]+>/g, ''),
    musicId: String(s.MUSICRID || '').replace(/^MUSIC_/, ''),
  }));
  const scored = candidates.map(c => ({ c, score: computeScore(c, { title, artist, duration }) }));

  const results = [];
  for (const { c, score } of scored.slice(0, 3)) {
    try {
      if (!c.musicId) continue;
      const lyric = await fetchUrl(
        'https://m.kuwo.cn/newh5/singles/songinfoandlrc?musicId=' + c.musicId + '&httpsStatus=1',
        { Referer: 'https://m.kuwo.cn/' }, FETCH_TIMEOUT, 'json'
      );
      const data = lyric && lyric.data;
      const lrclist = (data && data.lrclist) || [];
      if (!lrclist.length) continue;
      const lrcLines = lrclist.map(l => `[${Number(l.time).toFixed(2)}]${l.lineLyric || ''}`).join('\n');
      results.push({
        source: '酷我音乐',
        lrc: lrcLines, trans: '',
        matched: `${c.title} · ${c.artist}`,
        duration: c.duration, score,
      });
    } catch (e) { /* skip */ }
  }
  if (!results.length) throw new Error('酷我无歌词');
  return results;
}

/* ---------- 多源调度（收集全部候选，选最佳） ---------- */
const PROVIDERS = [
  { name: 'netease', run: fromNetease },
  { name: 'qq', run: fromQQ },
  { name: 'kugou', run: fromKugou },
  { name: 'kuwo', run: fromKuwo },
];

async function fetchLyrics(title, artist, duration, opts = {}) {
  const forceRefresh = !!opts.force;
  const queries = buildSearchQueries(title);
  const key = cacheKey(title, artist, duration);
  const file = path.join(CACHE_DIR, key + '.json');

  // 缓存命中
  if (!forceRefresh && fs.existsSync(file)) {
    try {
      const cached = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (cached.notFound && Date.now() - cached.at < NOT_FOUND_TTL) {
        return { ok: false, reason: '暂未找到歌词（缓存）', cached: true };
      }
      if (!cached.notFound && cached.lines && cached.lines.length && cached.score && cached.score.confidence >= MIN_CONFIDENCE) {
        return { ok: true, cached: true, ...cached };
      }
    } catch (e) { /* 缓存损坏 → 重新搜 */ }
  }

  const allResults = [];
  const errors = [];

  // 并发跑所有 provider 的所有查询（第一轮用第一组关键词，最精确）
  const firstKw = queries[0] || title;
  const providerTasks = PROVIDERS.map(p =>
    p.run(firstKw, artist, duration)
      .then(list => { for (const r of list) { r.provider = p.name; allResults.push(r); } })
      .catch(err => errors.push(`${p.name}: ${err.message}`))
  );
  await Promise.all(providerTasks);

  // 如果第一组没拿到好结果，再用后续关键词试试
  if (!allResults.length && queries.length > 1) {
    for (const kw of queries.slice(1)) {
      const more = await Promise.all(PROVIDERS.map(p =>
        p.run(kw, artist, duration)
          .then(list => list.map(r => { r.provider = p.name; return r; }))
          .catch(() => [])
      ));
      for (const list of more) allResults.push(...list);
      if (allResults.length) break;
    }
  }

  if (!allResults.length) {
    try { fs.writeFileSync(file, JSON.stringify({ notFound: true, at: Date.now(), errors, queries })); } catch (e) { /* ignore */ }
    return { ok: false, reason: '暂未找到歌词', errors, queries };
  }

  // 按置信度排序，选最佳
  allResults.sort((a, b) => b.score.confidence - a.score.confidence);
  const best = allResults[0];
  const otherConfidences = allResults.slice(1, 4).map(r => `${r.source}(${r.score.confidence}%)`);

  // 置信度不够
  if (!isTrustworthy(best.score)) {
    try { fs.writeFileSync(file, JSON.stringify({ notFound: true, at: Date.now(), reason: '所有候选置信度不足' })); } catch (e) { /* ignore */ }
    return {
      ok: false,
      reason: `歌词置信度不足（最佳 ${best.score.confidence}%，需要 ≥${MIN_CONFIDENCE}%）`,
      best: { source: best.source, matched: best.matched, confidence: best.score.confidence },
      errors, queries,
    };
  }

  const lines = parseLrc(best.lrc, best.trans);
  if (!lines.length) {
    return { ok: false, reason: '解析后歌词为空' };
  }

  const payload = {
    ok: true,
    title, artist,
    source: best.source,
    matched: best.matched,
    duration: best.duration,
    lines,
    score: best.score,
    alternatives: otherConfidences,
    fetchedAt: Date.now(),
  };
  try { fs.writeFileSync(file, JSON.stringify(payload)); } catch (e) { /* ignore */ }
  return payload;
}

module.exports = { fetchLyrics, parseLrc, normalizeTitle, computeScore };
