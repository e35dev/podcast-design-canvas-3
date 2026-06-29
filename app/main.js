/*
 * Podcast Design Canvas — browser app wiring.
 *
 * Classic script (no ES module) so it runs from file://. Wrapped in an IIFE so
 * it declares no globals. Depends on window.PDC_MODEL (app/model.js, loaded
 * first). Every rule here maps to a real failure mode from earlier attempts:
 *   - runs from file://, no module CORS
 *   - no duplicate global declarations
 *   - Preview never blocks: it starts a render loop that draws immediately and
 *     never awaits a media event that might not fire
 *   - real uploaded/recorded media is drawn on the canvas (not a placeholder)
 *   - no demo/sample media path — only real uploads and real live capture
 *   - Export produces a real, downloadable WebM with mixed audio
 */
(function () {
  "use strict";

  var M = window.PDC_MODEL;
  if (!M) {
    console.warn("PDC_MODEL missing — app/model.js must load first.");
    return;
  }

  // ---- Episode state -------------------------------------------------------
  var state = {
    title: "",
    presetId: M.PRESETS[0].id,
    speakers: {}, // slotId -> { hasMedia, source, video, social, name, stream, audioSource }
  };
  M.SPEAKER_SLOTS.forEach(function (slot) {
    state.speakers[slot.id] = {
      hasMedia: false,
      source: null, // "upload" | "capture"
      video: null, // hidden HTMLVideoElement used as the draw source
      social: "",
      name: "",
      stream: null, // MediaStream for live capture
    };
  });

  // ---- DOM refs ------------------------------------------------------------
  var $ = function (id) {
    return document.getElementById(id);
  };
  var els = {
    title: $("episode-title"),
    btnNew: $("btn-new"),
    speakers: $("speakers"),
    presets: $("presets"),
    btnPreview: $("btn-preview"),
    btnExport: $("btn-export"),
    setupStatus: $("setup-status"),
    setupPanel: $("setup"),
    previewPanel: $("preview"),
    exportPanel: $("export"),
    canvas: $("stage-canvas"),
    btnBack: $("btn-back"),
    btnPlay: $("btn-play"),
    btnExport2: $("btn-export-2"),
    previewStatus: $("preview-status"),
    exportProgress: $("export-progress"),
    exportStatus: $("export-status"),
    downloadLink: $("download-link"),
    exportPreview: $("export-preview"),
  };

  var ctx = els.canvas.getContext("2d");
  var rafId = 0;
  var recording = false;

  // ---- Build setup UI ------------------------------------------------------
  function buildSpeakerCards() {
    M.SPEAKER_SLOTS.forEach(function (slot) {
      var card = document.createElement("div");
      card.className = "speaker-card";
      card.dataset.slot = slot.id;
      card.style.setProperty("--accent", slot.accent);

      card.innerHTML =
        '<div class="speaker-head">' +
        '<span class="dot"></span><strong>' +
        slot.label +
        "</strong>" +
        '<span class="speaker-state" data-role="state">Empty</span>' +
        "</div>" +
        '<div class="dropzone" data-role="dropzone" tabindex="0">' +
        "<p>Drop a video here or</p>" +
        '<label class="file-btn">Choose file' +
        '<input type="file" accept="video/*" data-role="file" hidden /></label>' +
        '<button type="button" class="capture-btn" data-role="capture">Record speaker</button>' +
        "</div>" +
        '<label class="social">Social link' +
        '<input type="text" inputmode="url" placeholder="instagram.com/handle" data-role="social" /></label>';

      els.speakers.appendChild(card);

      var fileInput = card.querySelector('[data-role="file"]');
      var captureBtn = card.querySelector('[data-role="capture"]');
      var social = card.querySelector('[data-role="social"]');
      var dropzone = card.querySelector('[data-role="dropzone"]');

      fileInput.addEventListener("change", function (e) {
        var file = e.target.files && e.target.files[0];
        if (file) attachUpload(slot.id, file);
      });

      captureBtn.addEventListener("click", function () {
        captureSpeaker(slot.id);
      });

      social.addEventListener("input", function () {
        state.speakers[slot.id].social = social.value;
        refreshSetup();
      });

      // Drag and drop a real local file onto the card.
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
        var file =
          e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
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
        " />" +
        '<span class="preset-name">' +
        preset.name +
        "</span>" +
        '<span class="preset-pacing">' +
        preset.pacing +
        " pacing</span>" +
        '<span class="preset-blurb">' +
        preset.blurb +
        "</span>";
      card.querySelector("input").addEventListener("change", function () {
        state.presetId = preset.id;
        markSelectedPreset();
        refreshSetup();
      });
      els.presets.appendChild(card);
    });
    markSelectedPreset();
  }

  function markSelectedPreset() {
    var cards = els.presets.querySelectorAll(".preset-card");
    for (var i = 0; i < cards.length; i++) {
      cards[i].classList.toggle(
        "selected",
        cards[i].dataset.preset === state.presetId
      );
    }
  }

  // ---- Media attachment ----------------------------------------------------
  function ensureVideoEl(slotId) {
    var sp = state.speakers[slotId];
    if (sp.video) return sp.video;
    var v = document.createElement("video");
    v.muted = true; // muted so it can autoplay; export taps audio via WebAudio
    v.playsInline = true;
    v.loop = true;
    v.preload = "auto";
    v.crossOrigin = "anonymous";
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
    sp.stream = null;
    v.srcObject = null;
    v.src = sp.objectUrl;
    // Kick playback; muted playback is allowed without a gesture. Never await it.
    v.load();
    safePlay(v);
    sp.hasMedia = true;
    setCardState(slotId, file.name);
    refreshSetup();
  }

  function captureSpeaker(slotId) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setCardState(slotId, "Recording not supported", true);
      return;
    }
    setCardState(slotId, "Starting camera…");
    navigator.mediaDevices
      .getUserMedia({ video: true, audio: true })
      .then(function (stream) {
        var sp = state.speakers[slotId];
        if (sp.objectUrl) {
          URL.revokeObjectURL(sp.objectUrl);
          sp.objectUrl = null;
        }
        var v = ensureVideoEl(slotId);
        sp.source = "capture";
        sp.stream = stream;
        sp.fileName = "Live recording";
        v.src = "";
        v.srcObject = stream;
        safePlay(v);
        sp.hasMedia = true;
        setCardState(slotId, "Recording (live)");
        refreshSetup();
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
      if (p && typeof p.catch === "function") {
        p.catch(function () {
          /* autoplay can be deferred; the render loop still draws frames */
        });
      }
    } catch (e) {
      /* ignore */
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

  // ---- Setup readiness -----------------------------------------------------
  function snapshot() {
    return { title: state.title, presetId: state.presetId, speakers: state.speakers };
  }

  function refreshSetup() {
    state.title = els.title.value;
    var canPreview = M.isReadyToPreview(snapshot());
    var canExport = M.isReadyToExport(snapshot());
    els.btnPreview.disabled = !canPreview;
    els.btnExport.disabled = !canExport;
    var reasons = M.blockingReasons(snapshot());
    if (reasons.length) {
      els.setupStatus.textContent = reasons.join(" ");
    } else {
      els.setupStatus.textContent =
        "Ready — preview the composition or export the episode.";
    }
  }

  // ---- Preview render loop (never blocks) ----------------------------------
  function startPreview() {
    if (!M.isReadyToPreview(snapshot())) return;
    state.title = els.title.value;
    els.setupPanel.hidden = true;
    els.previewPanel.hidden = false;
    els.exportPanel.hidden = true;
    // Make sure every assigned source is playing for live frames.
    M.SPEAKER_SLOTS.forEach(function (slot) {
      var sp = state.speakers[slot.id];
      if (sp.hasMedia && sp.video) safePlay(sp.video);
    });
    els.previewStatus.textContent =
      "Live preview composed from your real speaker videos.";
    startRenderLoop();
  }

  function startRenderLoop() {
    cancelAnimationFrame(rafId);
    var loop = function () {
      drawFrame();
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);
  }

  function stopRenderLoop() {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }

  function drawFrame() {
    var assigned = M.assignedSlotIds(snapshot());
    var layout = M.computeLayout(
      state.presetId,
      assigned,
      els.canvas.width,
      els.canvas.height
    );

    // Background.
    ctx.fillStyle = layout.background || "#0f172a";
    ctx.fillRect(0, 0, els.canvas.width, els.canvas.height);

    // Title bar.
    var title = state.title || "Untitled episode";
    ctx.fillStyle = "rgba(255,255,255,0.92)";
    ctx.font = "600 " + Math.round(layout.titleBox.h * 0.5) + "px system-ui, sans-serif";
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.fillText(title, layout.titleBox.x + 8, layout.titleBox.y + layout.titleBox.h / 2);

    // Speaker frames.
    layout.frames.forEach(function (rect) {
      var sp = state.speakers[rect.id];
      drawSpeaker(sp, rect, rect.id);
    });

    // Lower-third caption built from the active speaker's name (social-derived).
    drawCaption(layout, assigned);
  }

  function drawSpeaker(sp, rect, slotId) {
    var v = sp && sp.video;
    var ready = v && v.readyState >= 2 && v.videoWidth > 0;
    roundRectPath(ctx, rect.x, rect.y, rect.w, rect.h, 14);
    ctx.save();
    ctx.clip();
    if (ready) {
      drawVideoCover(v, rect);
    } else {
      // Labeled placeholder while a source loads — preview still renders.
      ctx.fillStyle = "#1f2937";
      ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
      ctx.fillStyle = "rgba(255,255,255,0.6)";
      ctx.font = "500 22px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(
        sp && sp.hasMedia ? "Loading…" : M.slotLabel(slotId),
        rect.x + rect.w / 2,
        rect.y + rect.h / 2
      );
    }
    ctx.restore();

    // Frame outline + speaker name chip.
    var accent =
      (M.SPEAKER_SLOTS.filter(function (s) {
        return s.id === slotId;
      })[0] || {}).accent || "#38bdf8";
    ctx.lineWidth = 3;
    ctx.strokeStyle = accent;
    roundRectPath(ctx, rect.x, rect.y, rect.w, rect.h, 14);
    ctx.stroke();

    var name = M.speakerDisplayName(slotId, sp);
    var chipH = 30;
    var pad = 10;
    ctx.font = "600 18px system-ui, sans-serif";
    var tw = ctx.measureText(name).width;
    var chipW = tw + pad * 2;
    ctx.fillStyle = "rgba(15,23,42,0.78)";
    roundRectPath(ctx, rect.x + 10, rect.y + rect.h - chipH - 10, chipW, chipH, 8);
    ctx.fill();
    ctx.fillStyle = accent;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(name, rect.x + 10 + pad, rect.y + rect.h - chipH / 2 - 10);
  }

  function drawCaption(layout, assigned) {
    var box = layout.captionBox;
    ctx.fillStyle = "rgba(2,6,23,0.55)";
    roundRectPath(ctx, box.x, box.y, box.w, box.h, 16);
    ctx.fill();
    var leadId = assigned[0];
    var lead = state.speakers[leadId];
    var name = M.speakerDisplayName(leadId, lead);
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    ctx.font = "600 " + Math.round(box.h * 0.34) + "px system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(
      name + " is speaking",
      box.x + 24,
      box.y + box.h / 2
    );
  }

  function drawVideoCover(video, rect) {
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
      /* drawing a not-yet-ready frame can throw; ignored, next frame retries */
    }
  }

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

  // ---- Export (real WebM with mixed audio, bounded duration) ---------------
  var audioCtx = null;

  function exportEpisode() {
    if (recording) return;
    if (!M.isReadyToExport(snapshot())) {
      startPreview();
      return;
    }
    // Ensure the canvas is actively rendering so captureStream has frames.
    els.setupPanel.hidden = true;
    els.previewPanel.hidden = false;
    els.exportPanel.hidden = false;
    if (!rafId) startRenderLoop();

    M.SPEAKER_SLOTS.forEach(function (slot) {
      var sp = state.speakers[slot.id];
      if (sp.hasMedia && sp.video) safePlay(sp.video);
    });

    var fps = 30;
    var canvasStream = els.canvas.captureStream(fps);
    var tracks = canvasStream.getVideoTracks();
    var audioTrack = buildMixedAudioTrack();
    if (audioTrack) tracks.push(audioTrack);
    var mixed = new MediaStream(tracks);

    var mimeType = pickMimeType();
    var recorder;
    try {
      recorder = mimeType
        ? new MediaRecorder(mixed, { mimeType: mimeType })
        : new MediaRecorder(mixed);
    } catch (e) {
      els.exportStatus.textContent =
        "Recording is not supported in this browser.";
      return;
    }

    var chunks = [];
    recorder.ondataavailable = function (e) {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };
    recorder.onstop = function () {
      recording = false;
      var blob = new Blob(chunks, { type: mimeType || "video/webm" });
      finishExport(blob);
    };

    var assigned = M.assignedSlotIds(snapshot());
    var durations = assigned.map(function (id) {
      var v = state.speakers[id].video;
      return v ? v.duration : 0;
    });
    var seconds = M.exportDurationSeconds(durations, 5);

    recording = true;
    els.downloadLink.hidden = true;
    els.exportPreview.hidden = true;
    els.exportProgress.value = 0;
    els.exportStatus.textContent = "Recording your episode…";

    // Restart sources from the top so the export captures full content, and
    // keep them playing so real audio flows into the recording.
    assigned.forEach(function (id) {
      var v = state.speakers[id].video;
      if (!v) return;
      if (state.speakers[id].source === "upload") {
        try {
          v.currentTime = 0;
        } catch (e) {
          /* ignore */
        }
      }
      safePlay(v);
    });

    recorder.start(250);

    var start = Date.now();
    var tick = setInterval(function () {
      var pct = Math.min(100, ((Date.now() - start) / (seconds * 1000)) * 100);
      els.exportProgress.value = pct;
    }, 150);

    // Bounded stop — never relies on a media "ended" event that may not fire.
    setTimeout(function () {
      clearInterval(tick);
      els.exportProgress.value = 100;
      if (recorder.state !== "inactive") recorder.stop();
    }, seconds * 1000);
  }

  function buildMixedAudioTrack() {
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      if (!audioCtx) audioCtx = new AC();
      if (audioCtx.state === "suspended") audioCtx.resume();
      var dest = audioCtx.createMediaStreamDestination();

      // Keep-alive: a silent constant source guarantees the audio track always
      // carries samples. Without it, if a speaker's audio is momentarily silent
      // or can't be tapped, the WebM muxer stalls and the recording drops to
      // zero bytes — even though the video frames are fine.
      var keep = audioCtx.createConstantSource();
      var keepGain = audioCtx.createGain();
      keepGain.gain.value = 0;
      keep.connect(keepGain).connect(dest);
      try {
        keep.start();
      } catch (e) {
        /* already started */
      }

      M.SPEAKER_SLOTS.forEach(function (slot) {
        var sp = state.speakers[slot.id];
        if (!sp.hasMedia) return;
        try {
          if (sp.source === "capture" && sp.stream) {
            if (sp.stream.getAudioTracks().length === 0) return;
            audioCtx.createMediaStreamSource(sp.stream).connect(dest);
          } else if (sp.video) {
            // One MediaElementSource per element, cached.
            if (!sp.audioSource) {
              sp.audioSource = audioCtx.createMediaElementSource(sp.video);
            }
            sp.video.muted = false; // routed into the graph, not to speakers
            sp.audioSource.connect(dest);
          }
        } catch (e) {
          /* a source that can't be tapped is skipped; keep-alive keeps the
             track valid so video still exports cleanly */
        }
      });

      var at = dest.stream.getAudioTracks()[0];
      return at || null;
    } catch (e) {
      return null;
    }
  }

  function pickMimeType() {
    var candidates = [
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm",
    ];
    if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported) {
      return "";
    }
    for (var i = 0; i < candidates.length; i++) {
      if (MediaRecorder.isTypeSupported(candidates[i])) return candidates[i];
    }
    return "";
  }

  function finishExport(blob) {
    // Re-mute element sources so the preview stays quiet.
    M.SPEAKER_SLOTS.forEach(function (slot) {
      var sp = state.speakers[slot.id];
      if (sp.video && sp.source === "upload") sp.video.muted = true;
    });
    if (!blob || blob.size === 0) {
      els.exportStatus.textContent =
        "Export produced no data — try again after the preview is playing.";
      return;
    }
    var url = URL.createObjectURL(blob);
    var name = M.exportFileName(state.title);
    els.downloadLink.href = url;
    els.downloadLink.download = name;
    els.downloadLink.hidden = false;
    els.downloadLink.textContent = "Download " + name;
    els.exportPreview.src = url;
    els.exportPreview.hidden = false;
    var kb = Math.round(blob.size / 1024);
    els.exportStatus.textContent =
      "Episode ready — " + name + " (" + kb + " KB). Click to download.";
  }

  // ---- Navigation ----------------------------------------------------------
  function backToSetup() {
    stopRenderLoop();
    els.previewPanel.hidden = true;
    els.exportPanel.hidden = true;
    els.setupPanel.hidden = false;
  }

  // Start a fresh episode without reloading the page: clear every speaker
  // source, social field, title, and preset, and return to setup. Controls
  // stay visible the whole time — nothing is gated behind this action.
  function resetEpisode() {
    stopRenderLoop();
    M.SPEAKER_SLOTS.forEach(function (slot) {
      var sp = state.speakers[slot.id];
      releaseStream(slot.id);
      if (sp.objectUrl) {
        URL.revokeObjectURL(sp.objectUrl);
        sp.objectUrl = null;
      }
      if (sp.video) {
        try {
          sp.video.pause();
        } catch (e) {
          /* ignore */
        }
        sp.video.removeAttribute("src");
        sp.video.srcObject = null;
      }
      sp.hasMedia = false;
      sp.source = null;
      sp.fileName = "";
      sp.social = "";
      setCardState(slot.id, "Empty");
      var card = els.speakers.querySelector('[data-slot="' + slot.id + '"]');
      if (card) {
        var fileInput = card.querySelector('[data-role="file"]');
        var social = card.querySelector('[data-role="social"]');
        if (fileInput) fileInput.value = "";
        if (social) social.value = "";
      }
    });
    state.presetId = M.PRESETS[0].id;
    var firstRadio = els.presets.querySelector('input[value="' + state.presetId + '"]');
    if (firstRadio) firstRadio.checked = true;
    markSelectedPreset();
    els.title.value = "";
    state.title = "";
    els.previewPanel.hidden = true;
    els.exportPanel.hidden = true;
    els.setupPanel.hidden = false;
    refreshSetup();
  }

  function playFromStart() {
    M.SPEAKER_SLOTS.forEach(function (slot) {
      var sp = state.speakers[slot.id];
      if (sp.hasMedia && sp.video && sp.source === "upload") {
        try {
          sp.video.currentTime = 0;
        } catch (e) {
          /* ignore */
        }
      }
      if (sp.hasMedia && sp.video) safePlay(sp.video);
    });
  }

  // ---- Init ----------------------------------------------------------------
  function init() {
    buildSpeakerCards();
    buildPresetCards();
    els.title.addEventListener("input", refreshSetup);
    els.btnPreview.addEventListener("click", startPreview);
    els.btnExport.addEventListener("click", function () {
      startPreview();
      exportEpisode();
    });
    els.btnExport2.addEventListener("click", exportEpisode);
    els.btnBack.addEventListener("click", backToSetup);
    els.btnPlay.addEventListener("click", playFromStart);
    if (els.btnNew) els.btnNew.addEventListener("click", resetEpisode);
    refreshSetup();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

})();
