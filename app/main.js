/*
 * Podcast Design Canvas — browser wiring (active step #32).
 *
 * Classic script (no ES module) so it runs from file://. Wrapped in an IIFE so
 * it declares no globals. Depends on window.PDC_MODEL (app/model.js, first).
 *
 * Proves the real upload/record -> assign -> preset -> composed preview path:
 *   - runs from file://, no module CORS
 *   - controls visible on first paint
 *   - two real-media inputs per speaker: upload a local file OR record live
 *     with the camera (getUserMedia) — both feed the SAME preview pipeline
 *   - the composed preview draws real video pixels immediately and NEVER blocks
 *     on a media event that might not fire
 *   - uploaded/recorded media survives preset switching within the session
 */
(function () {
  "use strict";

  var M = window.PDC_MODEL;
  if (!M) {
    console.warn("PDC_MODEL missing — app/model.js must load first.");
    return;
  }

  var state = {
    presetId: M.PRESETS[0].id,
    speakers: {},
    playing: false,
  };
  M.SPEAKER_SLOTS.forEach(function (slot) {
    state.speakers[slot.id] = {
      hasMedia: false,
      source: null, // "upload" | "record"
      video: null, // hidden HTMLVideoElement used as the draw source
      objectUrl: null,
      stream: null,
      fileName: "",
    };
  });

  var $ = function (id) {
    return document.getElementById(id);
  };
  var els = {
    speakers: $("speakers"),
    presets: $("presets"),
    canvas: $("stage-canvas"),
    stageEmpty: $("stage-empty"),
    btnPlay: $("btn-play"),
    btnRestart: $("btn-restart"),
    status: $("preview-status"),
  };
  var ctx = els.canvas.getContext("2d");
  var rafId = 0;

  // ---- Build the setup UI --------------------------------------------------
  function buildSpeakerCards() {
    M.SPEAKER_SLOTS.forEach(function (slot) {
      var card = document.createElement("div");
      card.className = "speaker-card";
      card.dataset.slot = slot.id;
      card.style.setProperty("--accent", slot.accent);
      card.innerHTML =
        '<div class="speaker-head"><span class="dot"></span><strong>' +
        slot.label +
        '</strong><span class="speaker-state" data-role="state">No video</span></div>' +
        '<div class="dropzone" data-role="dropzone">' +
        "<p>Drop a video here, or</p>" +
        '<div class="ingest">' +
        '<label class="btn file-btn">Upload ' +
        slot.label +
        ' video<input type="file" accept="video/*" data-role="file" hidden /></label>' +
        '<button type="button" class="btn record-btn" data-role="record">Record ' +
        slot.label +
        " with camera</button>" +
        "</div></div>";
      els.speakers.appendChild(card);

      var fileInput = card.querySelector('[data-role="file"]');
      var recordBtn = card.querySelector('[data-role="record"]');
      var dropzone = card.querySelector('[data-role="dropzone"]');

      fileInput.addEventListener("change", function (e) {
        var file = e.target.files && e.target.files[0];
        if (file) attachUpload(slot.id, file);
      });
      recordBtn.addEventListener("click", function () {
        recordSpeaker(slot.id);
      });
      ["dragover", "dragenter"].forEach(function (evt) {
        dropzone.addEventListener(evt, function (e) {
          e.preventDefault();
          dropzone.classList.add("drag");
        });
      });
      ["dragleave", "drop"].forEach(function (evt) {
        dropzone.addEventListener(evt, function (e) {
          e.preventDefault();
          dropzone.classList.remove("drag");
        });
      });
      dropzone.addEventListener("drop", function (e) {
        var file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (file) attachUpload(slot.id, file);
      });
    });
  }

  function buildPresetCards() {
    M.PRESETS.forEach(function (preset) {
      var card = document.createElement("label");
      card.className = "preset-card";
      card.dataset.preset = preset.id;
      card.innerHTML =
        '<input type="radio" name="preset" value="' +
        preset.id +
        '"' +
        (preset.id === state.presetId ? " checked" : "") +
        ' /><span class="preset-name">' +
        preset.name +
        '</span><span class="preset-blurb">' +
        preset.blurb +
        "</span>";
      card.querySelector("input").addEventListener("change", function () {
        state.presetId = preset.id;
        markSelectedPreset();
        // Switching presets must NOT drop the media — only the layout changes.
      });
      els.presets.appendChild(card);
    });
    markSelectedPreset();
  }

  function markSelectedPreset() {
    var cards = els.presets.querySelectorAll(".preset-card");
    for (var i = 0; i < cards.length; i++) {
      cards[i].classList.toggle("selected", cards[i].dataset.preset === state.presetId);
    }
  }

  // ---- Media attachment (upload + record feed the same pipeline) -----------
  function ensureVideoEl(slotId) {
    var sp = state.speakers[slotId];
    if (sp.video) return sp.video;
    var v = document.createElement("video");
    v.muted = true; // muted so playback can autostart without a gesture
    v.playsInline = true;
    v.loop = true;
    v.preload = "auto";
    sp.video = v;
    return v;
  }

  function attachUpload(slotId, file) {
    var sp = state.speakers[slotId];
    releaseStream(slotId);
    var v = ensureVideoEl(slotId);
    if (sp.objectUrl) URL.revokeObjectURL(sp.objectUrl);
    sp.objectUrl = URL.createObjectURL(file);
    sp.source = "upload";
    sp.fileName = file.name;
    v.srcObject = null;
    v.src = sp.objectUrl;
    v.load();
    safePlay(v);
    sp.hasMedia = true;
    setCardState(slotId, file.name);
    onMediaAdded();
  }

  function recordSpeaker(slotId) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setCardState(slotId, "Camera not available", true);
      return;
    }
    setCardState(slotId, "Starting camera…");
    navigator.mediaDevices
      .getUserMedia({ video: true, audio: false })
      .then(function (stream) {
        var sp = state.speakers[slotId];
        if (sp.objectUrl) {
          URL.revokeObjectURL(sp.objectUrl);
          sp.objectUrl = null;
        }
        var v = ensureVideoEl(slotId);
        sp.source = "record";
        sp.stream = stream;
        sp.fileName = "Live recording";
        v.src = "";
        v.srcObject = stream;
        safePlay(v);
        sp.hasMedia = true;
        setCardState(slotId, "Recording (live camera)");
        onMediaAdded();
      })
      .catch(function (err) {
        setCardState(slotId, "Camera blocked", true);
        console.warn("getUserMedia failed for " + slotId, err);
      });
  }

  function releaseStream(slotId) {
    var sp = state.speakers[slotId];
    if (sp.stream) {
      sp.stream.getTracks().forEach(function (t) {
        t.stop();
      });
      sp.stream = null;
    }
  }

  function safePlay(video) {
    try {
      var p = video.play();
      if (p && typeof p.catch === "function") p.catch(function () {});
    } catch (e) {
      /* the render loop still draws frames as they decode */
    }
  }

  function setCardState(slotId, text, isError) {
    var card = els.speakers.querySelector('[data-slot="' + slotId + '"]');
    if (!card) return;
    var stateEl = card.querySelector('[data-role="state"]');
    if (stateEl) {
      stateEl.textContent = text;
      stateEl.classList.toggle("error", !!isError);
    }
    card.classList.toggle("filled", !!state.speakers[slotId].hasMedia);
  }

  // ---- Readiness + preview loop (never blocks) -----------------------------
  function onMediaAdded() {
    refresh();
    if (!rafId) startPreviewLoop(); // show composed pixels as soon as media exists
    els.stageEmpty.hidden = true;
  }

  function refresh() {
    var ready = M.isReadyToPreview(state);
    els.btnPlay.disabled = !ready;
    els.btnRestart.disabled = !ready;
    var reason = M.blockingReason(state);
    els.status.textContent = ready
      ? "Ready — press Play preview to play your composed episode."
      : reason;
  }

  function startPreviewLoop() {
    cancelAnimationFrame(rafId);
    var loop = function () {
      drawFrame();
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);
  }

  function drawFrame() {
    var assigned = M.assignedSlotIds(state);
    var layout = M.computeLayout(state.presetId, assigned, els.canvas.width, els.canvas.height);
    ctx.fillStyle = layout.background || "#0f172a";
    ctx.fillRect(0, 0, els.canvas.width, els.canvas.height);
    layout.frames.forEach(function (rect) {
      drawSpeaker(state.speakers[rect.id], rect);
    });
  }

  function drawSpeaker(sp, rect) {
    var v = sp && sp.video;
    var ready = v && v.readyState >= 2 && v.videoWidth > 0;
    roundRect(rect.x, rect.y, rect.w, rect.h, 14);
    ctx.save();
    ctx.clip();
    if (ready) {
      drawCover(v, rect);
    } else {
      ctx.fillStyle = "#1f2937";
      ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
      ctx.fillStyle = "rgba(255,255,255,0.65)";
      ctx.font = "500 22px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(
        sp && sp.hasMedia ? "Loading…" : rect.label,
        rect.x + rect.w / 2,
        rect.y + rect.h / 2
      );
    }
    ctx.restore();

    ctx.lineWidth = 3;
    ctx.strokeStyle = rect.accent;
    roundRect(rect.x, rect.y, rect.w, rect.h, 14);
    ctx.stroke();

    // Speaker name chip.
    var pad = 10;
    var chipH = 30;
    ctx.font = "600 18px system-ui, sans-serif";
    var tw = ctx.measureText(rect.label).width;
    ctx.fillStyle = "rgba(15,23,42,0.78)";
    roundRect(rect.x + 10, rect.y + rect.h - chipH - 10, tw + pad * 2, chipH, 8);
    ctx.fill();
    ctx.fillStyle = rect.accent;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(rect.label, rect.x + 10 + pad, rect.y + rect.h - chipH / 2 - 10);
  }

  function drawCover(video, rect) {
    var vw = video.videoWidth;
    var vh = video.videoHeight;
    if (!vw || !vh) return;
    var scale = Math.max(rect.w / vw, rect.h / vh);
    var dw = vw * scale;
    var dh = vh * scale;
    var dx = rect.x + (rect.w - dw) / 2;
    var dy = rect.y + (rect.h - dh) / 2;
    try {
      ctx.drawImage(video, dx, dy, dw, dh);
    } catch (e) {
      /* a not-yet-decodable frame can throw; next frame retries */
    }
  }

  function roundRect(x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // ---- Play controls -------------------------------------------------------
  function playPreview() {
    if (!M.isReadyToPreview(state)) return;
    state.playing = true;
    els.stageEmpty.hidden = true;
    if (!rafId) startPreviewLoop();
    syncPlay();
    els.status.textContent = "Playing your composed preview from the uploaded media.";
  }

  function restartPreview() {
    if (!M.isReadyToPreview(state)) return;
    els.stageEmpty.hidden = true;
    if (!rafId) startPreviewLoop();
    syncPlay();
  }

  // Start every assigned speaker's video together, from the top where seekable.
  function syncPlay() {
    M.assignedSlotIds(state).forEach(function (id) {
      var sp = state.speakers[id];
      if (!sp.video) return;
      if (sp.source === "upload") {
        try {
          sp.video.currentTime = 0;
        } catch (e) {
          /* ignore */
        }
      }
      safePlay(sp.video);
    });
  }

  function init() {
    buildSpeakerCards();
    buildPresetCards();
    els.btnPlay.addEventListener("click", playPreview);
    els.btnRestart.addEventListener("click", restartPreview);
    refresh();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
