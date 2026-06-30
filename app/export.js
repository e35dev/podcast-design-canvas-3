// app/export.js
// Export the composed preview as a real, downloadable episode video.
//
// The export deliberately REUSES the live preview canvas (app/preview.js draws
// each uploaded <video>'s current frame into the active preset's rects every
// requestAnimationFrame). We capture that same canvas with captureStream(30) so
// the recorded file contains the ACTUAL uploaded footage in the selected preset
// layout with the correct derived speaker names — and because the preview draws
// to a <canvas>, the frames are screenshot-safe (never black in rendered review).
//
// Audio is the real uploaded audio, mixed live via WebAudio: one
// MediaElementAudioSourceNode per speaker video feeding a single
// MediaStreamAudioDestinationNode, whose audio track is added to the canvas
// stream. MediaRecorder muxes video+audio into video/webm.
//
// Two parts:
//   1. buildExportPlan(...)  — pure, DOM-free model: ties each assigned media ref
//      + derived name to the active preset's rect. Unit-tested under plain Node.
//   2. createExporter(...)   — browser-only recorder built on the plan + canvas.
//
// Classic script — exposed on window.PDC.exporter.
(function () {
  const PDC = (window.PDC = window.PDC || {});

  // Default recording window. Kept SHORT and bounded so the export always
  // finishes in a few seconds and never hangs (prior export attempts timed out).
  const DEFAULT_DURATION_MS = 2800;

  // Pick a MediaRecorder mime type the browser actually supports, preferring
  // VP8+Opus (broadest playback support) and degrading gracefully.
  const EXPORT_MIME_CANDIDATES = [
    "video/webm;codecs=vp8,opus",
    "video/webm;codecs=vp8",
    "video/webm;codecs=vp9,opus",
    "video/webm",
  ];

  // Pure: which uploaded media ref + derived name lands in which preset rect.
  // `episode` is the DOM-free model; `presetsApi` and `episodeApi` are injected
  // so this stays testable under Node with the same modules the UI uses.
  function buildExportPlan(episode, presetsApi, episodeApi) {
    const presets = presetsApi || (PDC.presets);
    const ep = episodeApi || (PDC.episode);
    const buckets = ep.assignedBuckets(episode);
    const preset = presets.getPreset(episode.presetId) || presets.PRESETS[0];
    const rects = preset.layout(buckets.length);
    const tiles = buckets.map(function (bucket, i) {
      const rect = rects[i] || rects[rects.length - 1];
      const media = episode.media[bucket] || null;
      return {
        bucket: bucket,
        name: ep.speakerName(episode, bucket),
        mediaName: media ? media.name : null,
        rect: { x: rect.x, y: rect.y, w: rect.w, h: rect.h },
      };
    });
    return {
      presetId: preset.id,
      presetName: preset.name,
      speakerCount: buckets.length,
      tiles: tiles,
    };
  }

  // Pick the first supported recorder mime type, or null if none.
  function pickMimeType(candidates) {
    const list = candidates || EXPORT_MIME_CANDIDATES;
    if (!list.length) return null;
    if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported) {
      return list[list.length - 1];
    }
    for (let i = 0; i < list.length; i++) {
      if (MediaRecorder.isTypeSupported(list[i])) return list[i];
    }
    return null;
  }

  // A short, descriptive filename derived from the episode + preset.
  function exportFileName(episode, plan) {
    const safe = String((episode && episode.title) || "episode")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "episode";
    return safe + "-" + (plan ? plan.presetId : "export") + ".webm";
  }

  // Browser-only exporter. `deps` supplies the live pieces:
  //   canvas        : the #stage-canvas the preview already draws to
  //   getMediaElements(): () => HTMLVideoElement[]  (the uploaded decoder videos)
  //   getEpisode()  : () => episode model (for the plan + filename)
  // Returns { record() } where record(opts) resolves to a real Blob.
  function createExporter(deps) {
    const canvas = deps.canvas;
    const getMediaElements = deps.getMediaElements;
    const getEpisode = deps.getEpisode;

    // Lazily create one shared AudioContext + destination; reuse element sources
    // (a media element can only be wired into ONE MediaElementSourceNode ever).
    let audioCtx = null;
    let audioDest = null;
    const wiredSources = new WeakMap();

    function ensureAudioGraph() {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      if (!audioCtx) {
        audioCtx = new AC();
        audioDest = audioCtx.createMediaStreamDestination();
      }
      return audioCtx;
    }

    // Wire every uploaded video's real audio into the shared destination. Routes
    // through a gain node so the recorded mix doesn't clip with multiple speakers.
    function buildAudioStream() {
      const els = (getMediaElements && getMediaElements()) || [];
      if (!els.length) return null;
      const ctx = ensureAudioGraph();
      if (!ctx) return null;
      if (ctx.state === "suspended") {
        try {
          ctx.resume();
        } catch (e) {
          /* resume is best-effort */
        }
      }
      els.forEach(function (el) {
        if (wiredSources.has(el)) return;
        try {
          const src = ctx.createMediaElementSource(el);
          const gain = ctx.createGain();
          gain.gain.value = 1 / Math.max(1, els.length);
          src.connect(gain);
          gain.connect(audioDest);
          wiredSources.set(el, src);
        } catch (e) {
          // Element may already be wired in another graph; skip it rather than
          // aborting the whole export.
        }
      });
      return audioDest ? audioDest.stream : null;
    }

    // Record the live canvas (+ mixed audio) into a real WebM blob. Bounded by
    // durationMs; never waits on natural media end, so it can't hang.
    function record(opts) {
      const options = opts || {};
      const durationMs = options.durationMs || DEFAULT_DURATION_MS;
      const fps = options.fps || 30;
      const onProgress = typeof options.onProgress === "function" ? options.onProgress : function () {};

      return new Promise(function (resolve, reject) {
        if (typeof MediaRecorder === "undefined") {
          reject(new Error("MediaRecorder is not supported in this browser."));
          return;
        }
        if (!canvas || typeof canvas.captureStream !== "function") {
          reject(new Error("Canvas captureStream is not available."));
          return;
        }

        const mimeType = pickMimeType(options.mimeTypes);
        if (!mimeType) {
          reject(new Error("No supported WebM recorder mime type."));
          return;
        }

        let stream;
        try {
          stream = canvas.captureStream(fps);
        } catch (e) {
          reject(new Error("Failed to capture the preview canvas: " + e.message));
          return;
        }

        // Mix in the real uploaded audio when available. The export is still a
        // valid video-only WebM if a browser declines audio capture.
        let audioStream = null;
        try {
          audioStream = buildAudioStream();
        } catch (e) {
          audioStream = null;
        }
        if (audioStream) {
          audioStream.getAudioTracks().forEach(function (track) {
            try {
              stream.addTrack(track);
            } catch (e) {
              /* track may already be present */
            }
          });
        }

        let recorder;
        try {
          recorder = new MediaRecorder(stream, { mimeType: mimeType });
        } catch (e) {
          // Fall back to letting the browser choose the container.
          try {
            recorder = new MediaRecorder(stream);
          } catch (e2) {
            reject(new Error("Could not start MediaRecorder: " + e2.message));
            return;
          }
        }

        const chunks = [];
        let settled = false;
        let stopTimer = 0;
        let progressTimer = 0;
        const started = Date.now();

        function cleanup() {
          if (stopTimer) clearTimeout(stopTimer);
          if (progressTimer) clearInterval(progressTimer);
          // Only stop tracks WE added/own from the canvas capture; leave the
          // shared audio destination alive for the next export.
          stream.getVideoTracks().forEach(function (t) {
            t.stop();
          });
        }

        recorder.ondataavailable = function (event) {
          if (event.data && event.data.size) chunks.push(event.data);
        };

        recorder.onerror = function (event) {
          if (settled) return;
          settled = true;
          cleanup();
          reject(new Error("Recorder error: " + (event.error && event.error.message ? event.error.message : "unknown")));
        };

        recorder.onstop = function () {
          if (settled) return;
          settled = true;
          cleanup();
          const blob = new Blob(chunks, { type: (recorder.mimeType || mimeType).split(";")[0] || "video/webm" });
          onProgress(1);
          resolve({ blob: blob, mimeType: recorder.mimeType || mimeType, durationMs: Date.now() - started });
        };

        try {
          recorder.start();
        } catch (e) {
          settled = true;
          cleanup();
          reject(new Error("Recorder failed to start: " + e.message));
          return;
        }

        onProgress(0);
        progressTimer = setInterval(function () {
          const pct = Math.min(0.99, (Date.now() - started) / durationMs);
          onProgress(pct);
        }, 120);

        // Bounded stop — guarantees the export finishes promptly.
        stopTimer = setTimeout(function () {
          try {
            // Flush a final chunk before stopping so short recordings aren't empty.
            if (recorder.state === "recording") {
              recorder.requestData();
              recorder.stop();
            }
          } catch (e) {
            if (!settled) {
              settled = true;
              cleanup();
              reject(new Error("Failed to stop recorder: " + e.message));
            }
          }
        }, durationMs);
      });
    }

    return {
      record: record,
      buildPlan: function () {
        return buildExportPlan(getEpisode());
      },
    };
  }

  PDC.exporter = {
    DEFAULT_DURATION_MS: DEFAULT_DURATION_MS,
    EXPORT_MIME_CANDIDATES: EXPORT_MIME_CANDIDATES,
    buildExportPlan: buildExportPlan,
    pickMimeType: pickMimeType,
    exportFileName: exportFileName,
    createExporter: createExporter,
  };
})();
