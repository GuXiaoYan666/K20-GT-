/* eslint-disable */
'use strict';
/**
 * lyric-hub · renderer-side Tab injection
 *
 * Runs inside M HUB's main window (webContents.executeJavaScript).
 * - Clones an existing header tab ("官方商城" / "神光同步" / "云端社区")
 * - Renames it to "歌词", swaps icon for a music note
 * - Click → tells main process to open the lyric panel
 * - MutationObserver keeps the entry alive through host re-renders
 */

(function () {
  if (window.__lyricHubTabInjected) return;
  window.__lyricHubTabInjected = true;

  // ---- Constants ----
  var ENTRY_ATTR = 'data-k20-lyric-entry';
  var ENTRY_SELECTOR = '[' + ENTRY_ATTR + ']';
  var TABS_SELECTOR = '.el-tabs, .app-header__primary-group';
  var ITEM_SELECTOR = '.el-tabs__item, .app-header__primary-group > span';
  var TEXT_SELECTOR = '.mc-tabs__item-text, span:not([slot])';
  var TAB_TEXTS = ['官方商城', '神光同步', '云端社区'];
  var TAB_ID = 'tab-mall';
  var ENTRY_TEXT = '歌词';
  var ENTRY_VALUE = 'lyrics';

  // Music note SVG icon (viewBox 64 64 896 896)
  // A simple eighth-note shape that works well at 20px
  var MUSIC_ICON_VIEWBOX = '64 64 896 896';
  var MUSIC_ICON_PATHS = [
    { d: 'M493.2 156.8c-12.8-4.8-27.2 1.6-32 14.4L356 456h-88c-4.8 0-9.6 1.6-12.8 4.8l-100.8 100.8c-9.6 9.6-14.4 22.4-14.4 36.8v4.8c0 14.4 4.8 27.2 14.4 36.8L252 740.8c9.6 9.6 22.4 14.4 36.8 14.4h4.8c14.4 0 27.2-4.8 36.8-14.4l100.8-100.8c3.2-3.2 4.8-8 4.8-12.8V281.6l227.2-81.6c12.8-4.8 19.2-19.2 14.4-32s-19.2-19.2-32-14.4L493.2 156.8z', fill: 'currentColor' }
  ];

  // ---- Helpers ----
  function compact(v) { return String(v == null ? '' : v).replace(/\s+/g, ''); }

  function labelOf(node) {
    if (!node) return '';
    try {
      var labelNode = typeof node.querySelector === 'function' ? node.querySelector(TEXT_SELECTOR) : null;
      if (labelNode) return compact(labelNode.textContent);
    } catch (_) {}
    return compact(node.textContent);
  }

  function usable(node) {
    return !!node && !!node.parentNode && !!node.parentNode.children && node.parentNode.children.length >= 2;
  }

  function depthOf(node) {
    var d = 0, cur = node;
    while (cur && cur.parentNode) { d++; cur = cur.parentNode; }
    return d;
  }

  function inHomeNavigation(node) {
    var strips = document.querySelectorAll(TABS_SELECTOR);
    for (var i = 0; i < strips.length; i++) {
      var strip = strips[i];
      var parent = node;
      while (parent && parent !== strip) parent = parent.parentNode;
      if (!parent) continue;
      var items = strip.querySelectorAll(ITEM_SELECTOR);
      var labels = [];
      for (var j = 0; j < items.length; j++) {
        var label = labelOf(items[j]);
        if (TAB_TEXTS.indexOf(label) >= 0 && labels.indexOf(label) < 0) labels.push(label);
      }
      if (labels.length >= 2) return true;
    }
    return false;
  }

  function pickTemplate() {
    try {
      var direct = document.getElementById(TAB_ID);
      if (direct && usable(direct) && inHomeNavigation(direct)) return direct;
    } catch (_) {}
    var items = document.querySelectorAll(ITEM_SELECTOR);
    for (var order = 0; order < TAB_TEXTS.length; order++) {
      var want = TAB_TEXTS[order];
      for (var i = 0; i < items.length; i++) {
        var item = items[i];
        if (!usable(item) || !inHomeNavigation(item)) continue;
        if (labelOf(item) === want) return item;
      }
    }
    // Legacy fallback: search common tag names
    var tags = ['div', 'span', 'a', 'li', 'button'];
    var nodes = document.querySelectorAll(tags.join(','));
    for (var o = 0; o < TAB_TEXTS.length; o++) {
      var want2 = TAB_TEXTS[o];
      var best = null, bestDepth = Infinity;
      for (var k = 0; k < nodes.length; k++) {
        var n = nodes[k];
        if (!usable(n) || !inHomeNavigation(n)) continue;
        if (compact(n.textContent) !== want2) continue;
        var dp = depthOf(n);
        if (dp < bestDepth) { bestDepth = dp; best = n; }
      }
      if (best) return best;
    }
    return null;
  }

  function setEntryText(node, text) {
    try {
      var labelNode = typeof node.querySelector === 'function' ? node.querySelector(TEXT_SELECTOR) : null;
      if (labelNode) {
        if (compact(labelNode.textContent) !== text) labelNode.textContent = text;
        return true;
      }
    } catch (_) {}
    var walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, null);
    var cur = walker.nextNode();
    while (cur) {
      if (compact(cur.nodeValue)) {
        if (cur.nodeValue !== text) cur.nodeValue = text;
        return true;
      }
      cur = walker.nextNode();
    }
    return false;
  }

  function makeSvg(tag) {
    try {
      if (typeof document.createElementNS === 'function') return document.createElementNS('http://www.w3.org/2000/svg', tag);
    } catch (_) {}
    return null;
  }

  function paintMusicIcon(root) {
    var host = null;
    try { host = root && typeof root.querySelector === 'function' ? root.querySelector('.mc-tabs__item-icon, du-icon') : null; }
    catch (_) { host = null; }
    if (!host) return false;
    // Clear old font icons
    try {
      var fonts = host.querySelectorAll('i');
      for (var i = 0; i < fonts.length; i++) {
        if (fonts[i] && fonts[i].parentNode) fonts[i].parentNode.removeChild(fonts[i]);
      }
    } catch (_) {}
    // Already has our icon?
    try { if (host.querySelector('[data-k20-music-icon]')) return true; } catch (_) {}
    var svg = makeSvg('svg');
    if (!svg) return false;
    svg.setAttribute('viewBox', MUSIC_ICON_VIEWBOX);
    svg.setAttribute('width', '20');
    svg.setAttribute('height', '20');
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.setAttribute('style', 'vertical-align:-0.15em;display:inline-block');
    svg.setAttribute('data-k20-music-icon', '1');
    MUSIC_ICON_PATHS.forEach(function (shape) {
      var p = makeSvg('path');
      if (!p) return;
      p.setAttribute('d', shape.d);
      p.setAttribute('fill', shape.fill);
      svg.appendChild(p);
    });
    host.appendChild(svg);
    return true;
  }

  function scrub(node) {
    var strip = ['id', 'aria-controls', 'data-track', 'tabindex', 'href', 'data-href', 'onclick'];
    for (var i = 0; i < strip.length; i++) {
      try { if (node.hasAttribute && node.hasAttribute(strip[i])) node.removeAttribute(strip[i]); } catch (_) {}
    }
    try { if (node.setAttribute) node.setAttribute('aria-selected', 'false'); } catch (_) {}
    try { if (node.setAttribute) node.setAttribute(ENTRY_ATTR, '1'); } catch (_) {}
  }

  // ---- Click handler: 只设置 window 标志，主进程轮询读取 ----
  function fireOpen() {
    try { window.__K20_LYRICS_WANT_OPEN__ = (window.__K20_LYRICS_WANT_OPEN__ || 0) + 1; } catch (_) {}
  }
  function fireClose() {
    try { window.__K20_LYRICS_WANT_CLOSE__ = (window.__K20_LYRICS_WANT_CLOSE__ || 0) + 1; } catch (_) {}
  }

  function bindClick(node) {
    if (!node || node.__k20LyricBound) return;
    node.__k20LyricBound = true;
    var last = 0;
    var handler = function (event) {
      var now = Date.now();
      if (now - last < 300) return;
      last = now;
      try {
        if (event.preventDefault) event.preventDefault();
        if (event.stopPropagation) event.stopPropagation();
        if (event.stopImmediatePropagation) event.stopImmediatePropagation();
      } catch (_) {}
      fireOpen();
    };
    // 直接绑在自己的节点上（捕获阶段），不依赖父容器
    node.addEventListener('click', handler, true);
    node.addEventListener('pointerup', handler, true);
    node.addEventListener('mouseup', handler, true);
  }

  // 其它 tab 被点击时通知关闭
  function bindNavClose() {
    var items = null;
    try { items = document.querySelectorAll(ITEM_SELECTOR + ', .app-header__utility-action'); }
    catch (_) { items = null; }
    if (!items) return;
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (!item) continue;
      try { if (item.hasAttribute && item.hasAttribute(ENTRY_ATTR)) continue; } catch (_) {}
      if (item.__k20NavBound) continue;
      item.__k20NavBound = true;
      item.addEventListener('click', function () { fireClose(); }, true);
    }
  }

  // ---- Main inject function ----
  function inject() {
    // 快速路径：入口已存在且仍在文档中时，只做维护，避免每次 DOM 变动都全量扫描
    var existing = document.querySelector(ENTRY_SELECTOR);
    if (existing && document.contains(existing)) {
      var dupes = document.querySelectorAll(ENTRY_SELECTOR);
      for (var d = 1; d < dupes.length; d++) {
        try { dupes[d].parentNode.removeChild(dupes[d]); } catch (_) {}
      }
      setEntryText(existing, ENTRY_TEXT);
      paintMusicIcon(existing);
      bindClick(existing);
      bindNavClose();
      return true;
    }

    var template = pickTemplate();
    if (!template || !template.parentNode) return false;
    var clone = template.cloneNode(true);
    scrub(clone);
    // Modern M HUB uses Vue slot / value
    if (template.parentNode.matches && template.parentNode.matches('.app-header__primary-group')) {
      try { clone.removeAttribute('slot'); } catch (_) {}
      try { clone.setAttribute('value', ENTRY_VALUE); } catch (_) {}
      try { clone.setAttribute('aria-label', ENTRY_TEXT); } catch (_) {}
      try { clone.setAttribute('title', ENTRY_TEXT); } catch (_) {}
      try { clone.className = template.className; } catch (_) {}
    }
    setEntryText(clone, ENTRY_TEXT);
    paintMusicIcon(clone);
    template.parentNode.insertBefore(clone, template.nextSibling);
    bindClick(clone);
    bindNavClose();
    return true;
  }

  // ---- MutationObserver ----
  function startObserver() {
    if (window.__k20LyricObserverInstalled) return;
    window.__k20LyricObserverInstalled = true;
    var pending = false;
    var flush = function () {
      pending = false;
      try { inject(); } catch (_) {}
    };
    var schedule = function () {
      if (pending) return;
      pending = true;
      try {
        if (window.requestAnimationFrame) window.requestAnimationFrame(flush);
        else setTimeout(flush, 300);
      } catch (_) { pending = false; }
    };
    var obs = new MutationObserver(schedule);
    obs.observe(document.body, { childList: true, subtree: true });
  }

  // ---- Retry loop ----
  function startRetry() {
    var started = Date.now();
    var tick = function () {
      var ok = false;
      try { ok = inject(); } catch (_) { ok = false; }
      if (ok) { startObserver(); return; }
      if (Date.now() - started > 60000) return; // give up after 60s
      setTimeout(tick, 500);
    };
    tick();
  }

  // Kick off
  try {
    var ok = inject();
    if (!ok) startRetry();
    else startObserver();
  } catch (e) {
    startRetry();
  }
})();
