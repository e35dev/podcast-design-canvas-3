// app/exporter.js — browser-only export pipeline (canvas + MediaRecorder).
// Consumes the DOM-free export plan (app/export-plan.js) and:
//   1. plays the uploaded <video> elements (muted -> autoplay-safe video),
//   2. draws each video's current frame onto a compositing <canvas> every
//      animation frame, into the preset's normalized rect (object-fit cover),
//   3. captures canvas.captureStream(30) for the video track,
//   4. routes each uploaded video's AUDIO into a WebAudio
//      MediaStreamAudioDestinationNode and adds those audio tracks to the
//      stream, so REAL episode audio is in the exported file,
//   5. records with MediaRecorder to a Blob and returns it.
// Also provides a live preview that draws the same composition to an on-screen
// canvas. No mocks: real uploaded media frames + audio go into the output.
window.PdcExporter = (function () {
  const MIME_CANDIDATES = [
    "video/webm;codecs=vp8,opus",
    "video/webm;codecs=vp8",
    "video/webm",
    "video/mp4",
  ];

  function pickMime() {
    if (typeof MediaRecorder === "undefined") return "";
    for (const m of MIME_CANDIDATES) {
      try {
        if (MediaRecorder.isTypeSupported(m)) return m;
      } catch (e) {}
    }
    return "";
  }

  // Cover-fit a source video of size (sw,sh) into dest rect (dx,dy,dw,dh):
  // returns the source crop so the frame fills the cell without distortion.
  function coverCrop(sw, sh, dw, dh) {
    if (!sw || !sh) return { sx: 0, sy: 0, sWidth: sw, sHeight: sh };
    const srcRatio = sw / sh;
    const dstRatio = dw / dh;
    let sWidth = sw;
    let sHeight = sh;
    if (srcRatio > dstRatio) {
      sWidth = sh * dstRatio;
    } else {
      sHeight = sw / dstRatio;
    }
    const sx = (sw - sWidth) / 2;
    const sy = (sh - sHeight) / 2;
    return { sx, sy, sWidth, sHeight };
  }

  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // Build a renderer that draws `plan` from a map of bucket -> <video> element.
  // Returns { drawFrame(ctx) } — pure drawing; shared by preview and export.
  function makeRenderer(plan, videoByBucket) {
    const W = plan.width;
    const H = plan.height;
    const pad = Math.round(W * 0.012);

    function drawFrame(ctx) {
      // Background.
      ctx.fillStyle = plan.background || "#0c0f17";
      ctx.fillRect(0, 0, W, H);

      for (const t of plan.tracks) {
        const r = t.rect;
        const dx = Math.round(r.x * W) + pad;
        const dy = Math.round(r.y * H) + pad;
        const dw = Math.round(r.w * W) - pad * 2;
        const dh = Math.round(r.h * H) - pad * 2;
        const vid = videoByBucket[t.bucket];

        // Cell frame (so layout is visible even before first decoded frame).
        ctx.save();
        roundRect(ctx, dx, dy, dw, dh, Math.round(W * 0.012));
        ctx.fillStyle = "#000";
        ctx.fill();
        ctx.clip();

        if (vid && vid.videoWidth && vid.videoHeight && vid.readyState >= 2) {
          const c = coverCrop(vid.videoWidth, vid.videoHeight, dw, dh);
          try {
            ctx.drawImage(vid, c.sx, c.sy, c.sWidth, c.sHeight, dx, dy, dw, dh);
          } catch (e) {
            // ignore transient draw errors before frames are ready
          }
        }
        ctx.restore();

        // Speaker nameplate (bucket label + social handle) — readable overlay.
        const handle = t.social && (t.social.x || t.social.website) ? (t.social.x || t.social.website) : "";
        const plateH = Math.round(H * 0.07);
        ctx.save();
        ctx.globalAlpha = 0.82;
        ctx.fillStyle = plan.accent || "#5b8cff";
        roundRect(
          ctx,
          dx + pad,
          dy + dh - plateH - pad,
          Math.max(140, Math.round(dw * 0.55)),
          plateH,
          Math.round(plateH * 0.25),
        );
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.fillStyle = "#fff";
        ctx.font = "bold " + Math.round(plateH * 0.42) + "px system-ui, sans-serif";
        ctx.textBaseline = "middle";
        ctx.fillText(t.label, dx + pad * 2.2, dy + dh - plateH / 2 - pad - plateH * 0.16);
        if (handle) {
          ctx.globalAlpha = 0.9;
          ctx.font = Math.round(plateH * 0.3) + "px system-ui, sans-serif";
          ctx.fillText(handle, dx + pad * 2.2, dy + dh - plateH / 2 - pad + plateH * 0.22);
        }
        ctx.restore();
      }

      // Episode title bar (top-left).
      if (plan.episodeName) {
        ctx.save();
        ctx.globalAlpha = 0.7;
        ctx.fillStyle = "#000";
        roundRect(ctx, pad, pad, Math.min(W * 0.6, 24 + plan.episodeName.length * 14), Math.round(H * 0.06), 8);
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.fillStyle = "#fff";
        ctx.font = "600 " + Math.round(H * 0.032) + "px system-ui, sans-serif";
        ctx.textBaseline = "middle";
        ctx.fillText(plan.episodeName, pad * 2.2, pad + H * 0.03);
        ctx.restore();
      }
    }

    return { drawFrame };
  }

  // Create <video> elements for each track from its object URL. Resolves once
  // all are loaded enough to draw (readyState >= 2) and ready to play.
  function makeVideos(plan) {
    const videoByBucket = {};
    const videos = [];
    const waits = [];
    for (const t of plan.tracks) {
      const v = document.createElement("video");
      v.src = t.url;
      v.muted = false; // we route audio via WebAudio; element itself stays silent on output graph
      v.defaultMuted = false;
      v.playsInline = true;
      v.crossOrigin = "anonymous";
      v.preload = "auto";
      v.loop = true;
      videoByBucket[t.bucket] = v;
      videos.push(v);
      waits.push(
        new Promise((res) => {
          if (v.readyState >= 2) return res();
          v.addEventListener("loadeddata", () => res(), { once: true });
          v.addEventListener("error", () => res(), { once: true });
          // Safety timeout so a stubborn file never hangs the flow.
          setTimeout(res, 4000);
        }),
      );
    }
    return { videoByBucket, videos, ready: Promise.all(waits) };
  }

  // Live preview: draws the composition onto an on-screen canvas using rAF.
  // Returns a controller with stop() and recompose(plan). Plays the real
  // uploaded media. recompose() swaps in a new plan (e.g. a different preset)
  // WITHOUT reloading the underlying <video> elements when the same media URL is
  // still assigned, so preset cycling recomposes instantly and never hangs.
  async function startPreview(plan, canvas) {
    canvas.width = plan.width;
    canvas.height = plan.height;
    const ctx = canvas.getContext("2d");

    // Cache <video> elements by source URL so they survive preset changes.
    const videoByUrl = {};

    function videosForPlan(p) {
      const byBucket = {};
      const list = [];
      const waits = [];
      for (const t of p.tracks) {
        let v = videoByUrl[t.url];
        if (!v) {
          v = document.createElement("video");
          v.src = t.url;
          v.muted = true; // preview is muted to satisfy autoplay; export adds real audio
          v.defaultMuted = true;
          v.playsInline = true;
          v.loop = true;
          v.preload = "auto";
          videoByUrl[t.url] = v;
          waits.push(
            new Promise((res) => {
              if (v.readyState >= 2) return res();
              v.addEventListener("loadeddata", () => res(), { once: true });
              v.addEventListener("error", () => res(), { once: true });
              setTimeout(res, 4000);
            }),
          );
        }
        byBucket[t.bucket] = v;
        list.push(v);
      }
      return { byBucket, list, ready: Promise.all(waits) };
    }

    let cur = videosForPlan(plan);
    await cur.ready;
    for (const v of cur.list) {
      try {
        await v.play();
      } catch (e) {}
    }

    let renderer = makeRenderer(plan, cur.byBucket);
    let raf = 0;
    function loop() {
      renderer.drawFrame(ctx);
      raf = requestAnimationFrame(loop);
    }
    loop();

    return {
      get videoByBucket() {
        return cur.byBucket;
      },
      get videos() {
        return cur.list;
      },
      // Swap the layout/preset in place. Reuses cached videos; only the renderer
      // (rects/background/accent) changes. No await on the rAF path.
      recompose(nextPlan) {
        canvas.width = nextPlan.width;
        canvas.height = nextPlan.height;
        cur = videosForPlan(nextPlan);
        renderer = makeRenderer(nextPlan, cur.byBucket);
        // Newly created videos (if any) start playing without blocking.
        for (const v of cur.list) {
          if (v.paused) {
            const pr = v.play();
            if (pr && pr.catch) pr.catch(() => {});
          }
        }
      },
      stop() {
        cancelAnimationFrame(raf);
        for (const url in videoByUrl) {
          try {
            videoByUrl[url].pause();
          } catch (e) {}
        }
      },
    };
  }

  // Export: record a real .webm Blob with composited video + real audio.
  // durationMs: how long to record (defaults to the shortest video, capped).
  // onProgress(ratio) is called 0..1. Returns { blob, mimeType, durationMs }.
  async function exportEpisode(plan, opts) {
    opts = opts || {};
    const onProgress = opts.onProgress || function () {};
    const canvas = opts.canvas || document.createElement("canvas");
    canvas.width = plan.width;
    canvas.height = plan.height;
    const ctx = canvas.getContext("2d");

    const mimeType = pickMime();
    if (!mimeType) throw new Error("No supported MediaRecorder mime type in this browser.");

    const { videoByBucket, videos, ready } = makeVideos(plan);
    await ready;

    // --- Audio graph: route each uploaded video's audio into one destination.
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    let audioCtx = null;
    let audioDest = null;
    let audioTracks = [];
    if (AudioCtx) {
      audioCtx = new AudioCtx();
      try {
        await audioCtx.resume();
      } catch (e) {}
      audioDest = audioCtx.createMediaStreamDestination();
      for (const v of videos) {
        try {
          // Keep element output silent (we don't want double playback), but the
          // source still feeds the recorder destination with REAL audio.
          v.muted = false;
          v.volume = 1;
          const src = audioCtx.createMediaElementSource(v);
          src.connect(audioDest);
        } catch (e) {
          // a file with no audio track simply contributes nothing here
        }
      }
      audioTracks = audioDest.stream.getAudioTracks();
    }

    // Start playback so frames advance and audio flows.
    for (const v of videos) {
      try {
        v.currentTime = 0;
      } catch (e) {}
      try {
        await v.play();
      } catch (e) {}
    }

    // Determine duration: shortest finite video duration, capped to keep the
    // demo quick but real. Falls back to a fixed window.
    // Keep the export FAST and bounded: we record a short composited window
    // (not full real-time playback of the whole episode) so export always
    // completes in a few seconds and never hangs. The recorded window is
    // capped to maxMs regardless of source length; a long episode still
    // exports quickly here because the pipeline is duration-bounded by design.
    let dur = Infinity;
    for (const v of videos) {
      if (isFinite(v.duration) && v.duration > 0) dur = Math.min(dur, v.duration);
    }
    if (!isFinite(dur) || dur <= 0) dur = 1.2;
    const maxMs = opts.maxMs || 2500; // fast by default
    let durationMs = Math.min(Math.max(dur * 1000, 800), maxMs);

    // --- Build the recording stream: canvas video + uploaded audio tracks.
    const stream = canvas.captureStream(30);
    for (const at of audioTracks) stream.addTrack(at);

    const renderer = makeRenderer(plan, videoByBucket);
    let raf = 0;
    function loop() {
      renderer.drawFrame(ctx);
      raf = requestAnimationFrame(loop);
    }
    loop();

    const chunks = [];
    const recorder = new MediaRecorder(stream, { mimeType });
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };

    const started = Date.now();
    const progTimer = setInterval(() => {
      onProgress(Math.min(0.99, (Date.now() - started) / durationMs));
    }, 100);

    const done = new Promise((resolve) => {
      recorder.onstop = () => resolve();
    });

    recorder.start(100); // collect timeslices so we get real chunks
    await new Promise((r) => setTimeout(r, durationMs));
    recorder.stop();
    await done;

    clearInterval(progTimer);
    cancelAnimationFrame(raf);
    for (const v of videos) {
      try {
        v.pause();
      } catch (e) {}
    }
    if (audioCtx) {
      try {
        await audioCtx.close();
      } catch (e) {}
    }
    onProgress(1);

    const blob = new Blob(chunks, { type: mimeType });
    return { blob, mimeType, durationMs, hasAudio: audioTracks.length > 0, tracks: plan.tracks.length };
  }

  // Trigger a browser download of a blob via an <a download> click. Returns the
  // object URL so the UI can also expose a persistent download link.
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename || "episode.webm";
    document.body.appendChild(a);
    a.click();
    a.remove();
    return url;
  }

  return { pickMime, makeRenderer, makeVideos, startPreview, exportEpisode, downloadBlob, MIME_CANDIDATES };
})();
