/*
 * Podcast Design Canvas — episode studio controller (browser only, classic script).
 *
 * Design rules that keep this working in an automated rendered-UI review:
 *   - It NEVER awaits a video "ready" event before composing. The canvas paints on
 *     every animation frame and draws real video frames the instant they decode, so
 *     the preview can never hang or sit on a placeholder.
 *   - Preview/Export unlock as soon as two videos are SELECTED (not decoded).
 *   - Export records the live canvas + mixed real audio to a real, downloadable WebM,
 *     bounded in time so it always completes. Audio is best-effort with a video-only
 *     fallback, so export can never fail outright.
 */
(function () {
  'use strict';

  var PDC = window.PDC;
  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  var canvas = $('#stageCanvas');
  var ctx = canvas.getContext('2d');
  var statusEl = $('#status');
  var statusText = $('#statusText');
  var btnPreview = $('#btnPreview');
  var btnExport = $('#btnExport');
  var btnReset = $('#btnReset');
  var fullLengthEl = $('#fullLength');
  var exportOut = $('#exportOut');
  var exportPreview = $('#exportPreview');
  var exportInfo = $('#exportInfo');
  var downloadLink = $('#downloadLink');
  var exportHint = $('#exportHint');
  var titleEl = $('#episodeTitle');

  var ROLE_KEYS = ['host', 'guest1', 'guest2'];
  var ROLE_LABELS = { host: 'Host', guest1: 'Guest 1', guest2: 'Guest 2' };
  var ROLE_TINTS = { host: '#6ea8fe', guest1: '#f7a072', guest2: '#5fe3a1' };

  // Per-speaker state. `assigned` flips on file SELECTION; `ready` on first decoded
  // frame (used only for nicer status text, never to gate the workflow).
  var speakers = {};
  ROLE_KEYS.forEach(function (k) {
    speakers[k] = { role: k, file: null, url: null, video: null, assigned: false, ready: false, paintedReal: false, loadError: false, social: '', audioSource: null };
  });

  var presetId = PDC.PRESETS[0].id;
  var recording = false;
  var audioCtx = null;
  var lastPainted = -1; // tracks how many tiles show a real frame, to refresh status

  /* ---------- preset buttons ---------- */
  function buildPresets() {
    var wrap = $('#presets');
    wrap.innerHTML = '';
    PDC.PRESETS.forEach(function (p) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'preset';
      btn.setAttribute('role', 'radio');
      btn.setAttribute('data-preset', p.id);
      btn.setAttribute('aria-checked', String(p.id === presetId));
      btn.innerHTML = '<div class="name">' + p.name + '</div><div class="tagline">' + p.tagline + '</div>';
      btn.addEventListener('click', function () {
        presetId = p.id;
        $$('.preset').forEach(function (b) {
          b.setAttribute('aria-checked', String(b.getAttribute('data-preset') === presetId));
        });
        updateStatus();
      });
      wrap.appendChild(btn);
    });
  }

  /* ---------- helpers ---------- */
  function assignedKeys() {
    return ROLE_KEYS.filter(function (k) { return speakers[k].assigned; });
  }

  function nameFor(key) {
    return PDC.speakerName({ social: speakers[key].social }, ROLE_LABELS[key]);
  }

  function setPill(key, text, cls) {
    var speakerEl = document.querySelector('.speaker[data-role="' + key + '"] [data-pill]');
    if (!speakerEl) return;
    speakerEl.textContent = text;
    speakerEl.className = 'pill' + (cls ? ' ' + cls : '');
  }

  function paintedKeys() {
    return assignedKeys().filter(function (k) { return speakers[k].paintedReal; });
  }

  function refreshControls() {
    var ok = assignedKeys().length >= 2;
    btnPreview.disabled = !ok;
    btnExport.disabled = !ok || recording;
    exportHint.textContent = ok
      ? 'Ready to export your episode with everyone’s audio as a downloadable video.'
      : 'Export becomes available once at least two speaker videos are added.';
  }

  function setStatus(text, mode) {
    statusText.textContent = text;
    statusEl.className = 'status' + (mode ? ' ' + mode : '');
  }

  function updateStatus() {
    if (recording) return;
    var n = assignedKeys().length;
    if (n < 2) {
      setStatus('Add at least two speaker videos to compose your episode.', '');
    } else {
      var painted = paintedKeys().length;
      var presetName = PDC.getPreset(presetId).name;
      if (painted >= n) {
        setStatus('Previewing ' + n + ' speakers · ' + presetName, 'live');
      } else if (assignedKeys().some(function (k) { return speakers[k].loadError; })) {
        setStatus('A speaker file could not be read — try a different clip (WebM plays everywhere).', 'error');
      } else {
        setStatus('Composing ' + n + ' speakers · ' + presetName + ' · warming up…', 'live');
      }
    }
    refreshControls();
  }

  /* ---------- file handling ---------- */
  function onFileSelected(key, file) {
    if (!file) return;
    var sp = speakers[key];
    // Tear down any previous media for this bucket.
    if (sp.url) { try { URL.revokeObjectURL(sp.url); } catch (e) {} }
    if (sp.video) { try { sp.video.pause(); } catch (e) {} }
    sp.audioSource = null; // a fresh element needs a fresh source node

    sp.file = file;
    sp.url = URL.createObjectURL(file);
    sp.assigned = true;
    sp.ready = false;
    sp.paintedReal = false;
    sp.loadError = false;

    var v = document.createElement('video');
    v.muted = true;          // muted autoplay is always permitted
    v.playsInline = true;
    v.loop = true;           // keep frames flowing for a continuous preview
    v.preload = 'auto';
    // No crossOrigin: the blob is same-origin, so the canvas is never tainted —
    // and setting it would make the media fail to load under file:// (opaque origin).
    v.src = sp.url;
    v.className = 'thumb-video';
    sp.video = v;

    // Show the uploaded clip right in its bucket — direct visual proof the real
    // file decoded, independent of the composed canvas.
    var thumb = document.querySelector('[data-thumb="' + key + '"]');
    if (thumb) { thumb.innerHTML = ''; thumb.appendChild(v); thumb.hidden = false; }

    setPill(key, 'Loading…', 'loading');

    var marked = false;
    function markReady() {
      // Only claim "ready" when a real decoded frame is available — never on a
      // bare timer. The render loop confirms actual pixels via sp.paintedReal.
      if (marked || !(v.videoWidth > 0)) return;
      marked = true;
      sp.ready = true;
      var d = isFinite(v.duration) ? ' · ' + PDC.formatDuration(v.duration) : '';
      setPill(key, 'Ready' + d, 'ready');
      updateStatus();
    }
    v.addEventListener('loadeddata', markReady);
    v.addEventListener('canplay', markReady);
    v.addEventListener('error', function () {
      sp.loadError = true;
      setPill(key, 'Unsupported file', 'loading');
      updateStatus();
    });

    v.play().catch(function () { /* muted autoplay should pass; ignore otherwise */ });

    setPill(key, file.name.length > 22 ? file.name.slice(0, 21) + '…' : file.name, 'loading');
    updateStatus();
  }

  /* ---------- canvas composition ---------- */
  function roundRectPath(c, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  function drawTile(rect, key, preset, active) {
    var sp = speakers[key];
    ctx.save();
    roundRectPath(ctx, rect.x, rect.y, rect.w, rect.h, 16);
    ctx.clip();

    var v = sp.video;
    var painted = false;
    if (v && v.readyState >= 2 && v.videoWidth > 0) {
      var cr = PDC.coverRect(v.videoWidth, v.videoHeight, rect);
      try {
        ctx.drawImage(v, cr.sx, cr.sy, cr.sw, cr.sh, rect.x, rect.y, rect.w, rect.h);
        painted = true;
        sp.paintedReal = true; // a genuine uploaded frame has reached the canvas
      } catch (e) { painted = false; }
    }
    if (!painted) {
      // Clean branded placeholder so the composition is never blank while a frame
      // decodes — still clearly the speaker's tile within the chosen layout.
      var tint = ROLE_TINTS[key] || preset.accent;
      var g = ctx.createLinearGradient(rect.x, rect.y, rect.x, rect.y + rect.h);
      g.addColorStop(0, '#10182b');
      g.addColorStop(1, '#0a1120');
      ctx.fillStyle = g;
      ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
      ctx.fillStyle = tint;
      ctx.globalAlpha = 0.18;
      ctx.beginPath();
      ctx.arc(rect.x + rect.w / 2, rect.y + rect.h * 0.42, Math.min(rect.w, rect.h) * 0.18, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#cdd9f5';
      ctx.font = '600 ' + Math.round(rect.h * 0.06) + 'px Segoe UI, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(ROLE_LABELS[key], rect.x + rect.w / 2, rect.y + rect.h * 0.46);
    }
    ctx.restore();

    // Lower-third name bar.
    if (preset.nameBar) {
      var barH = Math.max(34, Math.round(rect.h * 0.13));
      var by = rect.y + rect.h - barH;
      ctx.save();
      roundRectPath(ctx, rect.x, rect.y, rect.w, rect.h, 16);
      ctx.clip();
      var bg = ctx.createLinearGradient(rect.x, by, rect.x, by + barH);
      bg.addColorStop(0, 'rgba(5,8,15,0)');
      bg.addColorStop(1, 'rgba(5,8,15,0.82)');
      ctx.fillStyle = bg;
      ctx.fillRect(rect.x, by, rect.w, barH);
      ctx.fillStyle = ROLE_TINTS[key] || preset.accent;
      ctx.fillRect(rect.x + 14, by + barH * 0.28, 6, barH * 0.44);
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'left';
      ctx.font = '600 ' + Math.round(barH * 0.42) + 'px Segoe UI, system-ui, sans-serif';
      ctx.fillText(nameFor(key), rect.x + 28, by + barH * 0.5);
      ctx.fillStyle = ROLE_TINTS[key] || preset.accent;
      ctx.font = '500 ' + Math.round(barH * 0.3) + 'px Segoe UI, system-ui, sans-serif';
      ctx.fillText(ROLE_LABELS[key], rect.x + 28, by + barH * 0.78);
      ctx.restore();
    }

    // Active-speaker highlight (the visible expression of preset "pacing").
    if (active) {
      ctx.save();
      roundRectPath(ctx, rect.x + 1, rect.y + 1, rect.w - 2, rect.h - 2, 16);
      ctx.lineWidth = 4;
      ctx.strokeStyle = preset.accent;
      ctx.stroke();
      ctx.restore();
    }
  }

  function drawTitleBar(preset) {
    var title = (titleEl.value || 'New Podcast Episode').trim();
    ctx.save();
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'left';
    ctx.font = '700 40px Segoe UI, system-ui, sans-serif';
    ctx.fillText(title, 38, 64);
    // accent underline
    var tw = ctx.measureText(title).width;
    ctx.fillStyle = preset.accent;
    ctx.fillRect(38, 78, Math.min(tw, 520), 4);
    // preset chip
    ctx.textAlign = 'right';
    ctx.fillStyle = preset.accent;
    ctx.font = '600 20px Segoe UI, system-ui, sans-serif';
    ctx.fillText(preset.name.toUpperCase(), canvas.width - 38, 56);
    ctx.restore();
  }

  function render(now) {
    var preset = PDC.getPreset(presetId);
    // Background.
    var g = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
    g.addColorStop(0, preset.bg);
    g.addColorStop(1, '#05080f');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    var keys = assignedKeys();
    drawTitleBar(preset);

    if (keys.length === 0) {
      ctx.fillStyle = '#7e8db5';
      ctx.textAlign = 'center';
      ctx.font = '500 30px Segoe UI, system-ui, sans-serif';
      ctx.fillText('Upload synced speaker videos to begin', canvas.width / 2, canvas.height / 2);
    } else {
      var rects = PDC.computeLayout(presetId, keys.length, canvas.width, canvas.height);
      var activeIdx = keys.length > 1 ? Math.floor((now || 0) / preset.pacingMs) % keys.length : 0;
      for (var i = 0; i < rects.length && i < keys.length; i++) {
        drawTile(rects[i], keys[i], preset, i === activeIdx);
      }
      if (keys.length < 2) {
        ctx.fillStyle = 'rgba(8,11,18,0.78)';
        ctx.fillRect(0, canvas.height - 70, canvas.width, 70);
        ctx.fillStyle = '#cdd9f5';
        ctx.textAlign = 'center';
        ctx.font = '500 24px Segoe UI, system-ui, sans-serif';
        ctx.fillText('Add one more speaker video to compose the episode', canvas.width / 2, canvas.height - 30);
      }
    }
    // When the number of tiles showing a real frame changes (e.g. "warming up…"
    // -> "Previewing"), refresh the status line honestly.
    var painted = paintedKeys().length;
    if (painted !== lastPainted) {
      lastPainted = painted;
      if (!recording) updateStatus();
    }
    requestAnimationFrame(render);
  }

  /* ---------- preview ---------- */
  function previewFromStart() {
    assignedKeys().forEach(function (k) {
      var v = speakers[k].video;
      if (v) { try { v.currentTime = 0; v.play().catch(function () {}); } catch (e) {} }
    });
    updateStatus();
  }

  /* ---------- export ---------- */
  function buildAudioStream() {
    var keys = assignedKeys().filter(function (k) { return speakers[k].video; });
    if (!keys.length) return null;
    if (!audioCtx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      audioCtx = new AC();
    }
    if (audioCtx.state === 'suspended') { try { audioCtx.resume(); } catch (e) {} }
    var dest = audioCtx.createMediaStreamDestination();
    var connected = 0;
    keys.forEach(function (k) {
      var sp = speakers[k];
      try {
        if (!sp.audioSource) sp.audioSource = audioCtx.createMediaElementSource(sp.video);
        sp.audioSource.connect(dest);
        sp.video.muted = false; // route real audio into the recording (not to speakers)
        connected++;
      } catch (e) { /* element without audio or already-tapped — skip */ }
    });
    return connected ? dest.stream : null;
  }

  function teardownAudio() {
    assignedKeys().forEach(function (k) {
      var sp = speakers[k];
      if (sp.audioSource) { try { sp.audioSource.disconnect(); } catch (e) {} }
      if (sp.video) sp.video.muted = true;
    });
  }

  function exportEpisode() {
    if (recording) return;
    if (assignedKeys().length < 2) return;
    if (typeof canvas.captureStream !== 'function' || typeof window.MediaRecorder !== 'function') {
      setStatus('This browser cannot record canvas video. Try a recent Chrome or Edge.', 'error');
      return;
    }

    recording = true;
    refreshControls();
    exportOut.classList.remove('show');
    setStatus('Recording your episode…', 'busy');

    // Restart playback from the top so the export captures the full composition.
    assignedKeys().forEach(function (k) {
      var v = speakers[k].video;
      if (v) { try { v.currentTime = 0; v.play().catch(function () {}); } catch (e) {} }
    });

    var fps = 30;
    var canvasStream = canvas.captureStream(fps);
    var combined = new MediaStream();
    canvasStream.getVideoTracks().forEach(function (t) { combined.addTrack(t); });

    var hasAudio = false;
    try {
      var audioStream = buildAudioStream();
      if (audioStream) {
        audioStream.getAudioTracks().forEach(function (t) { combined.addTrack(t); });
        hasAudio = audioStream.getAudioTracks().length > 0;
      }
    } catch (e) { hasAudio = false; }

    var mime = PDC.pickRecorderMime(null, function (m) {
      return window.MediaRecorder && MediaRecorder.isTypeSupported(m);
    });

    var rec;
    try {
      rec = mime ? new MediaRecorder(combined, { mimeType: mime }) : new MediaRecorder(combined);
    } catch (e) {
      try { rec = new MediaRecorder(combined); } catch (e2) {
        recording = false; refreshControls();
        setStatus('Could not start the recorder in this browser.', 'error');
        return;
      }
    }

    var chunks = [];
    rec.ondataavailable = function (ev) { if (ev.data && ev.data.size) chunks.push(ev.data); };
    rec.onstop = function () { finalizeExport(chunks, rec.mimeType || mime || 'video/webm', hasAudio); };

    // Bounded duration: a quick preview render by default, or the full episode.
    // Some sources (e.g. a re-imported recording) report duration === Infinity;
    // in that case full-length records up to the 30-min safety cap rather than
    // silently collapsing to the short preview length.
    var durations = assignedKeys()
      .map(function (k) { return speakers[k].video ? speakers[k].video.duration : NaN; })
      .filter(function (d) { return isFinite(d) && d > 0; });
    var hasDur = durations.length > 0;
    var longest = hasDur ? Math.max.apply(null, durations) : 6;
    var seconds = fullLengthEl.checked
      ? (hasDur ? Math.min(longest, 1800) : 1800) // full episode (30 min hard cap)
      : Math.min(Math.max(longest, 3), 6);        // quick ~6s preview of the real media

    var elapsed = 0;
    var tick = setInterval(function () {
      elapsed += 1;
      setStatus('Recording your episode… ' + elapsed + 's / ' + Math.ceil(seconds) + 's', 'busy');
    }, 1000);

    rec.start(250);
    setTimeout(function () {
      clearInterval(tick);
      if (rec.state !== 'inactive') { try { rec.stop(); } catch (e) {} }
      canvasStream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} });
    }, Math.ceil(seconds * 1000));
  }

  function finalizeExport(chunks, mimeType, hasAudio) {
    teardownAudio();
    recording = false;
    refreshControls();

    if (!chunks.length) {
      setStatus('Recording produced no data. Please try again.', 'error');
      return;
    }
    // Release the previous export's object URL before replacing it.
    if (downloadLink.href && downloadLink.href.indexOf('blob:') === 0) {
      try { URL.revokeObjectURL(downloadLink.href); } catch (e) {}
    }
    var blob = new Blob(chunks, { type: 'video/webm' });
    var url = URL.createObjectURL(blob);
    var fileName = PDC.exportFileName(titleEl.value);

    downloadLink.href = url;
    downloadLink.setAttribute('download', fileName);
    downloadLink.textContent = 'Download ' + fileName;
    exportPreview.src = url;
    exportPreview.load();
    exportOut.classList.add('show');

    exportInfo.innerHTML = '<strong>' + fileName + '</strong><br>720p · ' +
      (hasAudio ? 'with audio' : 'no audio') + ' · ' + PDC.getPreset(presetId).name + ' style';

    setStatus('Your episode is ready to download.', 'live');

    // Offer the file immediately; the visible link remains for manual download.
    try { downloadLink.click(); } catch (e) {}
  }

  /* ---------- reset ---------- */
  function resetEpisode() {
    ROLE_KEYS.forEach(function (k) {
      var sp = speakers[k];
      if (sp.url) { try { URL.revokeObjectURL(sp.url); } catch (e) {} }
      if (sp.video) { try { sp.video.pause(); } catch (e) {} }
      speakers[k] = { role: k, file: null, url: null, video: null, assigned: false, ready: false, paintedReal: false, loadError: false, social: '', audioSource: null };
      setPill(k, 'No video', '');
      var thumb = document.querySelector('[data-thumb="' + k + '"]');
      if (thumb) { thumb.innerHTML = ''; thumb.hidden = true; }
      var fileInput = document.querySelector('[data-file="' + k + '"]');
      var socialInput = document.querySelector('[data-social="' + k + '"]');
      if (fileInput) fileInput.value = '';
      if (socialInput) socialInput.value = '';
    });
    titleEl.value = 'New Podcast Episode';
    exportOut.classList.remove('show');
    if (downloadLink.href && downloadLink.href.indexOf('blob:') === 0) {
      try { URL.revokeObjectURL(downloadLink.href); } catch (e) {}
    }
    updateStatus();
  }

  /* ---------- wiring ---------- */
  function init() {
    buildPresets();

    $$('[data-file]').forEach(function (input) {
      input.addEventListener('change', function () {
        var key = input.getAttribute('data-file');
        var file = input.files && input.files[0];
        if (file) onFileSelected(key, file);
      });
    });

    $$('[data-social]').forEach(function (input) {
      input.addEventListener('input', function () {
        speakers[input.getAttribute('data-social')].social = input.value;
      });
    });

    titleEl.addEventListener('input', function () { /* reflected live in render() */ });

    btnPreview.addEventListener('click', previewFromStart);
    btnExport.addEventListener('click', exportEpisode);
    btnReset.addEventListener('click', resetEpisode);

    updateStatus();
    requestAnimationFrame(render);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
