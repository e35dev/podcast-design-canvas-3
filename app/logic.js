/*
 * Podcast Design Canvas — pure composition logic.
 *
 * This module is deliberately side-effect free so it can be:
 *   - loaded in the browser as a CLASSIC script (no ES modules), which keeps the
 *     app working when opened directly via file:// as well as over a dev server, and
 *   - required from Node for unit tests.
 *
 * It is wrapped in a UMD-style closure that assigns to a single namespace
 * (window.PDC). There are no top-level globals, so loading it more than once can
 * never throw "Identifier 'X' has already been declared".
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api; // Node (CommonJS) — used by the test suite.
  }
  if (root) {
    root.PDC = api; // Browser — single namespace, idempotent on re-load.
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Three genuinely distinct preset identities. Each defines a layout strategy,
  // a pacing rhythm (how often the active speaker highlight rotates), and an
  // accent palette so different shows can look different — never one house style.
  var PRESETS = [
    {
      id: 'roundtable',
      name: 'Roundtable',
      tagline: 'Equal panel — everyone on screen together',
      layout: 'grid',
      pacingMs: 4200,
      bg: '#0f1729',
      accent: '#6ea8fe',
      nameBar: true
    },
    {
      id: 'spotlight',
      name: 'Host Spotlight',
      tagline: 'Host leads, guests framed alongside',
      layout: 'spotlight',
      pacingMs: 5200,
      bg: '#161021',
      accent: '#f7a072',
      nameBar: true
    },
    {
      id: 'social',
      name: 'Social Studio',
      tagline: 'Bold lower-thirds tuned for clips',
      layout: 'social',
      pacingMs: 3200,
      bg: '#0c1f1a',
      accent: '#5fe3a1',
      nameBar: true
    }
  ];

  var ROLES = [
    { key: 'host', label: 'Host', tint: '#6ea8fe' },
    { key: 'guest1', label: 'Guest 1', tint: '#f7a072' },
    { key: 'guest2', label: 'Guest 2', tint: '#5fe3a1' }
  ];

  function getPreset(id) {
    for (var i = 0; i < PRESETS.length; i++) {
      if (PRESETS[i].id === id) return PRESETS[i];
    }
    return PRESETS[0];
  }

  // Title-case a raw token: "jane_doe" / "jane.doe" -> "Jane Doe".
  function humanize(token) {
    if (!token) return '';
    var cleaned = String(token).replace(/^@+/, '').replace(/[._\-+]+/g, ' ').trim();
    if (!cleaned) return '';
    return cleaned.split(/\s+/).map(function (w) {
      return w.charAt(0).toUpperCase() + w.slice(1);
    }).join(' ');
  }

  // Infer a likely on-screen name from a social link or handle. Social context is
  // used ONLY to label speakers — never to surface unrelated personal details.
  function inferName(social) {
    if (!social) return '';
    var raw = String(social).trim();
    if (!raw) return '';
    // Bare @handle.
    if (raw.charAt(0) === '@') return humanize(raw);
    var withProto = /^[a-zA-Z][a-zA-Z0-9+.\-]*:\/\//.test(raw) ? raw : 'https://' + raw;
    var handle = '';
    try {
      var u = new URL(withProto);
      var parts = u.pathname.split('/').filter(Boolean);
      // Skip platform path prefixes that are not the handle (e.g. linkedin /in/).
      var skip = { in: 1, profile: 1, u: 1, user: 1, users: 1, channel: 1, c: 1 };
      handle = '';
      for (var i = 0; i < parts.length; i++) {
        if (!skip[parts[i].toLowerCase()]) { handle = parts[i]; break; }
      }
      if (!handle && u.hostname) {
        handle = u.hostname.replace(/^www\./, '').split('.')[0];
      }
    } catch (e) {
      handle = raw;
    }
    return humanize(handle);
  }

  // Resolve the display name for a speaker: explicit name wins, otherwise infer
  // from the social link, otherwise fall back to the role label.
  function speakerName(speaker, roleLabel) {
    if (speaker && speaker.name) return speaker.name;
    var fromSocial = inferName(speaker && speaker.social);
    return fromSocial || roleLabel;
  }

  // Map a video's intrinsic size onto a destination rectangle using "cover"
  // semantics (fill the box, crop the overflow) so frames never distort.
  function coverRect(srcW, srcH, dst) {
    if (!srcW || !srcH) return { sx: 0, sy: 0, sw: 0, sh: 0 };
    var srcRatio = srcW / srcH;
    var dstRatio = dst.w / dst.h;
    var sw, sh;
    if (srcRatio > dstRatio) {
      sh = srcH;
      sw = srcH * dstRatio;
    } else {
      sw = srcW;
      sh = srcW / dstRatio;
    }
    return { sx: (srcW - sw) / 2, sy: (srcH - sh) / 2, sw: sw, sh: sh };
  }

  // Compute the on-canvas rectangle for each speaker tile for a given preset.
  // Pure geometry — fully unit tested. Returns [] for <1 speaker.
  function computeLayout(presetId, speakerCount, width, height) {
    var preset = getPreset(presetId);
    var n = Math.max(0, Math.min(3, speakerCount | 0));
    if (n === 0) return [];
    var pad = Math.round(width * 0.03);
    var gap = Math.round(width * 0.018);
    var top = Math.round(height * 0.12); // leave room for the title bar
    var bottom = Math.round(height * 0.04);
    var innerW = width - pad * 2;
    var innerH = height - top - bottom;
    var rects = [];

    function push(x, y, w, h, emphasis) {
      rects.push({
        x: Math.round(x), y: Math.round(y),
        w: Math.round(w), h: Math.round(h),
        emphasis: !!emphasis
      });
    }

    if (preset.layout === 'spotlight') {
      var mainW = n === 1 ? innerW : Math.round(innerW * 0.62);
      push(pad, top, mainW, innerH, true);
      if (n > 1) {
        var sideX = pad + mainW + gap;
        var sideW = innerW - mainW - gap;
        var stack = n - 1;
        var sideH = (innerH - gap * (stack - 1)) / stack;
        for (var i = 0; i < stack; i++) {
          push(sideX, top + i * (sideH + gap), sideW, sideH, false);
        }
      }
      return rects;
    }

    if (preset.layout === 'social') {
      // Centered tiles with breathing room for prominent lower-thirds.
      var sPad = Math.round(width * 0.06);
      var sInnerW = width - sPad * 2;
      var sTop = Math.round(height * 0.14);
      var sInnerH = height - sTop - Math.round(height * 0.1);
      var sGap = Math.round(width * 0.025);
      var tileW = (sInnerW - sGap * (n - 1)) / n;
      for (var k = 0; k < n; k++) {
        push(sPad + k * (tileW + sGap), sTop, tileW, sInnerH, k === 0);
      }
      return rects;
    }

    // Default: roundtable grid — equal tiles in a single row.
    var cellW = (innerW - gap * (n - 1)) / n;
    for (var j = 0; j < n; j++) {
      push(pad + j * (cellW + gap), top, cellW, innerH, false);
    }
    return rects;
  }

  function slugify(title) {
    var base = String(title || '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return base || 'podcast-episode';
  }

  function exportFileName(title) {
    return slugify(title) + '.webm';
  }

  function formatDuration(seconds) {
    if (!isFinite(seconds) || seconds < 0) seconds = 0;
    var total = Math.floor(seconds);
    var m = Math.floor(total / 60);
    var s = total % 60;
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }

  // Pick the strongest WebM MediaRecorder mime the runtime supports.
  function pickRecorderMime(candidates, isSupported) {
    var list = candidates || [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm'
    ];
    if (typeof isSupported !== 'function') return list[list.length - 1];
    for (var i = 0; i < list.length; i++) {
      if (isSupported(list[i])) return list[i];
    }
    return '';
  }

  return {
    PRESETS: PRESETS,
    ROLES: ROLES,
    getPreset: getPreset,
    humanize: humanize,
    inferName: inferName,
    speakerName: speakerName,
    coverRect: coverRect,
    computeLayout: computeLayout,
    slugify: slugify,
    exportFileName: exportFileName,
    formatDuration: formatDuration,
    pickRecorderMime: pickRecorderMime
  };
});
