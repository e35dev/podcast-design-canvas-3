(function initializePodcastDesignCanvasApp() {
  const {
    PRESETS,
    buildExportFilename,
    formatSocialLabel,
    getBucketLabel,
    getEpisodeDuration,
    getFrames,
    getPresetById,
    validateSetup
  } = window.PodcastDesignCanvasModel;

  const state = {
    slots: {
      host: emptySlot("host"),
      guest1: emptySlot("guest1"),
      guest2: emptySlot("guest2")
    },
    prepared: [],
    renderLoop: 0,
    exportUrl: "",
    exporting: false
  };

  const els = {
    start: document.querySelector("#start-episode"),
    reset: document.querySelector("#reset-episode"),
    title: document.querySelector("#episode-title"),
    fileInputs: Array.from(document.querySelectorAll("[data-file-for]")),
    socialInputs: Array.from(document.querySelectorAll("[data-social-for]")),
    slotStates: Array.from(document.querySelectorAll("[data-state-for]")),
    presetList: document.querySelector("#preset-list"),
    readyList: document.querySelector("#ready-list"),
    status: document.querySelector("#status"),
    nativePreview: document.querySelector("#native-preview"),
    canvas: document.querySelector("#preview-canvas"),
    sample: document.querySelector("#load-sample-media"),
    preview: document.querySelector("#compose-preview"),
    play: document.querySelector("#play-preview"),
    pause: document.querySelector("#pause-preview"),
    export: document.querySelector("#export-episode"),
    download: document.querySelector("#download-export")
  };
  const ctx = els.canvas.getContext("2d");

  els.start.addEventListener("click", resetEpisode);
  els.reset.addEventListener("click", resetEpisode);
  els.title.addEventListener("input", drawPreparedFrame);
  els.presetList.addEventListener("change", drawPreparedFrame);
  els.sample.addEventListener("click", handleLoadSampleMedia);
  els.preview.addEventListener("click", handlePreview);
  els.play.addEventListener("click", () => playPrepared(true));
  els.pause.addEventListener("click", pausePrepared);
  els.export.addEventListener("click", handleExport);

  els.fileInputs.forEach((input) => {
    input.addEventListener("change", () => {
      setSlotFile(input.dataset.fileFor, input.files[0] || null);
    });
  });

  els.socialInputs.forEach((input) => {
    input.addEventListener("input", () => {
      state.slots[input.dataset.socialFor].social = input.value.trim();
      renderReadyList();
      drawPreparedFrame();
    });
  });

  window.addEventListener("pagehide", () => {
    cleanupPrepared();
    Object.values(state.slots).forEach((slot) => revokeSlotUrl(slot));
    revokeExportUrl();
  });

  drawEmptyCanvas("Upload Host and Guest 1 videos, add social links, then preview.");
  renderReadyList();

  function emptySlot(bucket) {
    return {
      bucket,
      file: null,
      url: "",
      social: ""
    };
  }

  function resetEpisode() {
    stopRenderLoop();
    cleanupPrepared();
    Object.keys(state.slots).forEach((bucket) => {
      revokeSlotUrl(state.slots[bucket]);
      state.slots[bucket] = emptySlot(bucket);
    });
    els.fileInputs.forEach((input) => {
      input.value = "";
    });
    els.socialInputs.forEach((input) => {
      input.value = "";
    });
    els.title.value = "Founder roundtable";
    revokeExportUrl();
    setPreviewControls(false);
    renderSlotStates();
    renderReadyList();
    renderNativePreview();
    drawEmptyCanvas("Upload Host and Guest 1 videos, add social links, then preview.");
    setStatus("New episode started. Assign synced local speaker videos to the visible buckets.");
  }

  function setSlotFile(bucket, file) {
    const slot = state.slots[bucket];
    revokeSlotUrl(slot);
    slot.file = file;
    slot.url = file ? URL.createObjectURL(file) : "";
    cleanupPrepared();
    revokeExportUrl();
    setPreviewControls(false);
    renderSlotStates();
    renderReadyList();
    renderNativePreview();
    drawEmptyCanvas(file ? "Click Preview episode to compose the uploaded media." : "Upload Host and Guest 1 videos, add social links, then preview.");
  }

  async function handlePreview() {
    stopRenderLoop();
    cleanupPrepared();
    revokeExportUrl();
    setPreviewControls(false);

    const setup = collectSetup();
    if (!setup.uploads.length) {
      await handleLoadSampleMedia();
      return;
    }

    const errors = validateSetup(setup);
    if (errors.length) {
      setStatus(errors[0], true);
      drawEmptyCanvas(errors[0]);
      return;
    }

    setStatus("Loading uploaded speaker videos for preview.");
    state.prepared = setup.uploads.map((upload) => createPreparedEntry(upload, setup.socials[upload.bucket]));
    renderNativePreview();

    const ready = await Promise.all(state.prepared.map((entry) => waitForVideoReady(entry.video, 5000)));
    const failed = ready.find((result) => !result.ok);
    if (failed) {
      cleanupPrepared();
      renderNativePreview();
      drawEmptyCanvas(`Could not load ${getBucketLabel(failed.bucket)} video.`);
      setStatus(`Could not load ${getBucketLabel(failed.bucket)} video. Choose a playable local video file.`, true);
      return;
    }

    state.prepared.forEach((entry) => {
      entry.duration = Number.isFinite(entry.video.duration) ? entry.video.duration : 1;
    });
    drawPreparedFrame();
    setPreviewControls(true);
    setStatus("Preview ready. The composition is built from the uploaded local videos.");
  }

  async function handleLoadSampleMedia() {
    if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream || !(window.AudioContext || window.webkitAudioContext)) {
      setStatus("This browser cannot create the included sample videos.", true);
      return;
    }

    els.sample.disabled = true;
    setStatus("Creating two real sample speaker videos with audio.");
    try {
      const [hostFile, guestFile] = await Promise.all([
        createSampleVideoFile("host", "Host sample", "#72ddb6", 440),
        createSampleVideoFile("guest1", "Guest sample", "#f6c85f", 660)
      ]);
      setSlotFile("host", hostFile);
      setSlotFile("guest1", guestFile);
      state.slots.host.social = "https://x.com/sample-host";
      state.slots.guest1.social = "https://linkedin.com/in/sample-guest";
      document.querySelector("#social-host").value = state.slots.host.social;
      document.querySelector("#social-guest1").value = state.slots.guest1.social;
      document.querySelector('input[value="conversation-grid"]').checked = true;
      renderSlotStates();
      renderReadyList();
      await handlePreview();
    } catch (error) {
      setStatus(error.message || "Could not create sample videos.", true);
    } finally {
      els.sample.disabled = false;
    }
  }

  async function createSampleVideoFile(bucket, label, color, frequency) {
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 360;
    const sampleCtx = canvas.getContext("2d");
    let frame = 0;
    const draw = () => {
      sampleCtx.fillStyle = color;
      sampleCtx.fillRect(0, 0, canvas.width, canvas.height);
      sampleCtx.fillStyle = "#071013";
      sampleCtx.fillRect(54 + (frame % 84), 82, 210, 118);
      sampleCtx.fillStyle = "#ffffff";
      sampleCtx.font = "bold 42px Arial, sans-serif";
      sampleCtx.fillText(label, 74, 154);
      sampleCtx.font = "600 22px Arial, sans-serif";
      sampleCtx.fillText(`Tone ${frequency} Hz`, 76, 190);
      frame += 1;
    };
    draw();
    const interval = setInterval(draw, 33);
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    const destination = audioContext.createMediaStreamDestination();
    oscillator.frequency.value = frequency;
    gain.gain.value = 0.08;
    oscillator.connect(gain);
    gain.connect(destination);
    oscillator.start();

    const stream = canvas.captureStream(30);
    destination.stream.getAudioTracks().forEach((track) => stream.addTrack(track));
    const mimeType = selectMimeType();
    const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    const chunks = [];
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size) {
        chunks.push(event.data);
      }
    });

    const stopped = new Promise((resolve) => recorder.addEventListener("stop", resolve, { once: true }));
    recorder.start(100);
    await wait(1800);
    recorder.stop();
    await withTimeout(stopped, 3000, "Timed out creating sample video.");
    clearInterval(interval);
    oscillator.stop();
    await audioContext.close();
    stream.getTracks().forEach((track) => track.stop());

    const blob = new Blob(chunks, { type: mimeType || "video/webm" });
    if (!blob.size) {
      throw new Error("The browser produced an empty sample video.");
    }
    return new File([blob], `${bucket}-sample.webm`, { type: blob.type || "video/webm" });
  }

  function createPreparedEntry(upload, social) {
    const video = document.createElement("video");
    video.src = upload.url;
    video.preload = "auto";
    video.playsInline = true;
    video.controls = true;
    video.muted = true;
    video.dataset.bucket = upload.bucket;
    video.load();
    return {
      bucket: upload.bucket,
      file: upload.file,
      social,
      video,
      duration: 0
    };
  }

  function renderNativePreview() {
    els.nativePreview.innerHTML = "";
    if (!state.prepared.length) {
      const placeholder = document.createElement("div");
      placeholder.className = "preview-placeholder";
      placeholder.textContent = "Uploaded speaker videos appear here after preview.";
      els.nativePreview.appendChild(placeholder);
      return;
    }

    state.prepared.forEach((entry) => {
      const card = document.createElement("article");
      card.className = "native-card";
      card.dataset.bucket = entry.bucket;

      const label = document.createElement("div");
      label.className = "native-label";
      const name = document.createElement("strong");
      name.textContent = getBucketLabel(entry.bucket);
      const social = document.createElement("span");
      social.textContent = formatSocialLabel(entry.social);
      label.append(name, social);

      card.append(entry.video, label);
      els.nativePreview.appendChild(card);
    });
  }

  async function playPrepared(fromStart) {
    if (!state.prepared.length || state.exporting) {
      return false;
    }
    try {
      if (fromStart) {
        await Promise.all(state.prepared.map((entry) => seekVideo(entry.video, 0, 2500)));
      }
      state.prepared.forEach((entry) => {
        entry.video.muted = false;
      });
      await withTimeout(Promise.all(state.prepared.map((entry) => entry.video.play())), 3000, "Preview playback timed out.");
      startRenderLoop();
      setStatus("Preview playing from uploaded speaker videos.");
      return true;
    } catch (error) {
      pausePrepared();
      setStatus(error.message || "Preview playback could not start.", true);
      return false;
    }
  }

  function pausePrepared() {
    stopRenderLoop();
    state.prepared.forEach((entry) => {
      entry.video.pause();
      entry.video.muted = true;
    });
    drawPreparedFrame();
  }

  async function handleExport() {
    if (!state.prepared.length || state.exporting) {
      return;
    }
    if (!window.MediaRecorder || !els.canvas.captureStream) {
      setStatus("This browser cannot record the composed video export.", true);
      return;
    }

    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) {
      setStatus("This browser cannot mix uploaded speaker audio for export.", true);
      return;
    }

    state.exporting = true;
    els.export.disabled = true;
    revokeExportUrl();
    setStatus("Exporting composed video from uploaded media.");

    let audioContext;
    let recorder;
    const chunks = [];
    const cleanups = [];

    try {
      const outputStream = new MediaStream();
      const canvasStream = els.canvas.captureStream(30);
      canvasStream.getVideoTracks().forEach((track) => outputStream.addTrack(track));

      audioContext = new AudioContextCtor();
      const audioDestination = audioContext.createMediaStreamDestination();
      for (const entry of state.prepared) {
        const stream = entry.video.captureStream ? entry.video.captureStream() : entry.video.mozCaptureStream?.();
        if (!stream) {
          throw new Error("This browser cannot capture one of the uploaded videos for export.");
        }
        const audioTracks = stream.getAudioTracks();
        if (!audioTracks.length) {
          continue;
        }
        const source = audioContext.createMediaStreamSource(stream);
        const gain = audioContext.createGain();
        gain.gain.value = 1 / Math.max(1, state.prepared.length);
        source.connect(gain);
        gain.connect(audioDestination);
        cleanups.push(() => {
          source.disconnect();
          gain.disconnect();
        });
      }
      audioDestination.stream.getAudioTracks().forEach((track) => outputStream.addTrack(track));

      const mimeType = selectMimeType();
      recorder = mimeType ? new MediaRecorder(outputStream, { mimeType }) : new MediaRecorder(outputStream);
      recorder.addEventListener("dataavailable", (event) => {
        if (event.data.size) {
          chunks.push(event.data);
        }
      });

      await audioContext.resume();
      await Promise.all(state.prepared.map((entry) => seekVideo(entry.video, 0, 2500)));
      drawPreparedFrame();
      const stopped = new Promise((resolve) => recorder.addEventListener("stop", resolve, { once: true }));
      recorder.start(250);
      state.prepared.forEach((entry) => {
        entry.video.muted = false;
      });
      await withTimeout(Promise.all(state.prepared.map((entry) => entry.video.play())), 3000, "Export playback timed out.");
      startRenderLoop();
      await wait(Math.max(getEpisodeDuration(state.prepared) * 1000, 1000));
      pausePrepared();
      recorder.stop();
      await withTimeout(stopped, 8000, "Timed out waiting for recorder stop.");

      const blob = new Blob(chunks, { type: mimeType || "video/webm" });
      if (!blob.size) {
        throw new Error("Export failed because the browser produced an empty video file.");
      }

      state.exportUrl = URL.createObjectURL(blob);
      els.download.href = state.exportUrl;
      els.download.download = buildExportFilename(els.title.value.trim(), getSelectedPresetId());
      els.download.textContent = `Download export (${formatFileSize(blob.size)})`;
      els.download.hidden = false;
      setStatus("Export ready. Download the composed video file.");
    } catch (error) {
      if (recorder && recorder.state !== "inactive") {
        recorder.stop();
      }
      setStatus(error.message || "Export failed.", true);
    } finally {
      cleanups.forEach((cleanup) => cleanup());
      if (audioContext && audioContext.state !== "closed") {
        await audioContext.close();
      }
      state.exporting = false;
      els.export.disabled = false;
    }
  }

  function collectSetup() {
    const uploads = Object.values(state.slots)
      .filter((slot) => slot.file)
      .map((slot) => ({
        bucket: slot.bucket,
        file: slot.file,
        url: slot.url
      }));
    const socials = Object.values(state.slots).reduce((acc, slot) => {
      acc[slot.bucket] = slot.social;
      return acc;
    }, {});
    return {
      uploads,
      socials,
      presetId: getSelectedPresetId()
    };
  }

  function renderSlotStates() {
    els.slotStates.forEach((node) => {
      const file = state.slots[node.dataset.stateFor].file;
      node.textContent = file ? file.name : "No file";
      node.classList.toggle("ready", Boolean(file));
    });
  }

  function renderReadyList() {
    const setup = collectSetup();
    const buckets = new Set(setup.uploads.map((upload) => upload.bucket));
    const checks = [
      ["Host video assigned", buckets.has("host")],
      ["Guest video assigned", buckets.has("guest1") || buckets.has("guest2")],
      ["Speaker social links added", setup.uploads.every((upload) => setup.socials[upload.bucket]) && setup.uploads.length >= 2],
      [`Preset selected (${getPresetById(setup.presetId).name})`, Boolean(setup.presetId)],
      ["Preview composed from real videos", state.prepared.length >= 2]
    ];
    els.readyList.innerHTML = checks.map(([label, done]) => (
      `<li class="${done ? "done" : ""}">${done ? "Ready" : "Pending"} - ${label}</li>`
    )).join("");
  }

  function drawPreparedFrame() {
    renderReadyList();
    if (!state.prepared.length) {
      return;
    }
    const preset = getPresetById(getSelectedPresetId());
    const width = els.canvas.width;
    const height = els.canvas.height;
    const elapsedMs = Math.max(...state.prepared.map((entry) => entry.video.currentTime * 1000));
    const frames = getFrames(preset.id, state.prepared.map((entry) => entry.bucket), width, height, elapsedMs);

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = preset.background;
    ctx.fillRect(0, 0, width, height);

    frames.forEach((frame) => {
      const entry = state.prepared.find((item) => item.bucket === frame.bucket);
      if (entry) {
        drawVideoFrame(entry, frame, preset);
      }
    });

    ctx.fillStyle = "rgba(5, 9, 10, 0.86)";
    ctx.fillRect(26, 22, 430, 66);
    ctx.fillStyle = "#f8fbfa";
    ctx.font = "600 24px Arial, sans-serif";
    ctx.fillText(els.title.value.trim() || "Podcast episode", 46, 62);
  }

  function drawVideoFrame(entry, frame, preset) {
    ctx.fillStyle = "#05090a";
    ctx.fillRect(frame.x, frame.y, frame.width, frame.height);
    if (entry.video.readyState >= 2 && entry.video.videoWidth && entry.video.videoHeight) {
      const fit = cover(entry.video.videoWidth, entry.video.videoHeight, frame.width, frame.height);
      ctx.drawImage(entry.video, frame.x + fit.x, frame.y + fit.y, fit.width, fit.height);
    }
    ctx.lineWidth = frame.spotlight ? 5 : 3;
    ctx.strokeStyle = frame.spotlight ? preset.accent : "rgba(238, 244, 242, 0.5)";
    ctx.strokeRect(frame.x, frame.y, frame.width, frame.height);
    ctx.fillStyle = "rgba(5, 9, 10, 0.82)";
    ctx.fillRect(frame.x + 14, frame.y + frame.height - 76, Math.min(340, frame.width - 28), 56);
    ctx.fillStyle = "#ffffff";
    ctx.font = "600 21px Arial, sans-serif";
    ctx.fillText(getBucketLabel(entry.bucket), frame.x + 28, frame.y + frame.height - 42);
    ctx.fillStyle = "#c7d4cf";
    ctx.font = "500 15px Arial, sans-serif";
    ctx.fillText(formatSocialLabel(entry.social), frame.x + 28, frame.y + frame.height - 20);
  }

  function drawEmptyCanvas(message) {
    ctx.clearRect(0, 0, els.canvas.width, els.canvas.height);
    ctx.fillStyle = "#05090a";
    ctx.fillRect(0, 0, els.canvas.width, els.canvas.height);
    ctx.fillStyle = "#f8fbfa";
    ctx.font = "600 32px Arial, sans-serif";
    ctx.fillText("Podcast Design Canvas", 56, 120);
    ctx.fillStyle = "#9fb1aa";
    ctx.font = "500 22px Arial, sans-serif";
    ctx.fillText(message, 56, 178);
  }

  function startRenderLoop() {
    stopRenderLoop();
    const draw = () => {
      drawPreparedFrame();
      if (state.prepared.some((entry) => !entry.video.paused && !entry.video.ended)) {
        state.renderLoop = requestAnimationFrame(draw);
      }
    };
    state.renderLoop = requestAnimationFrame(draw);
  }

  function stopRenderLoop() {
    if (state.renderLoop) {
      cancelAnimationFrame(state.renderLoop);
      state.renderLoop = 0;
    }
  }

  function setPreviewControls(enabled) {
    els.play.disabled = !enabled;
    els.pause.disabled = !enabled;
    els.export.disabled = !enabled;
  }

  function cleanupPrepared() {
    stopRenderLoop();
    state.prepared.forEach((entry) => {
      entry.video.pause();
      entry.video.removeAttribute("src");
      entry.video.load();
    });
    state.prepared = [];
  }

  function revokeSlotUrl(slot) {
    if (slot.url) {
      URL.revokeObjectURL(slot.url);
      slot.url = "";
    }
  }

  function revokeExportUrl() {
    if (state.exportUrl) {
      URL.revokeObjectURL(state.exportUrl);
      state.exportUrl = "";
    }
    els.download.hidden = true;
    els.download.removeAttribute("href");
  }

  function waitForVideoReady(video, timeoutMs) {
    return new Promise((resolve) => {
      if (video.readyState >= 2 && video.videoWidth) {
        resolve({ ok: true, bucket: video.dataset.bucket });
        return;
      }
      const done = (ok) => {
        clearTimeout(timer);
        video.removeEventListener("loadeddata", onReady);
        video.removeEventListener("canplay", onReady);
        video.removeEventListener("error", onError);
        resolve({ ok, bucket: video.dataset.bucket });
      };
      const onReady = () => done(true);
      const onError = () => done(false);
      const timer = setTimeout(() => done(false), timeoutMs);
      video.addEventListener("loadeddata", onReady, { once: true });
      video.addEventListener("canplay", onReady, { once: true });
      video.addEventListener("error", onError, { once: true });
    });
  }

  function seekVideo(video, time, timeoutMs) {
    if (!Number.isFinite(video.duration) || Math.abs(video.currentTime - time) < 0.05) {
      return Promise.resolve();
    }
    return withTimeout(new Promise((resolve, reject) => {
      const cleanup = () => {
        video.removeEventListener("seeked", onSeeked);
        video.removeEventListener("error", onError);
      };
      const onSeeked = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error(`Could not seek ${getBucketLabel(video.dataset.bucket)} video.`));
      };
      video.addEventListener("seeked", onSeeked, { once: true });
      video.addEventListener("error", onError, { once: true });
      video.currentTime = time;
    }), timeoutMs, `Timed out seeking ${getBucketLabel(video.dataset.bucket)} video.`);
  }

  function withTimeout(promise, timeoutMs, message) {
    let timer = 0;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  function getSelectedPresetId() {
    return document.querySelector('input[name="preset"]:checked')?.value || PRESETS[0].id;
  }

  function selectMimeType() {
    return [
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm"
    ].find((type) => window.MediaRecorder?.isTypeSupported?.(type)) || "";
  }

  function cover(sourceWidth, sourceHeight, targetWidth, targetHeight) {
    const sourceRatio = sourceWidth / sourceHeight;
    const targetRatio = targetWidth / targetHeight;
    if (sourceRatio > targetRatio) {
      const height = targetHeight;
      const width = height * sourceRatio;
      return { width, height, x: (targetWidth - width) / 2, y: 0 };
    }
    const width = targetWidth;
    const height = width / sourceRatio;
    return { width, height, x: 0, y: (targetHeight - height) / 2 };
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function formatFileSize(size) {
    if (size < 1024 * 1024) {
      return `${Math.max(1, Math.round(size / 1024))} KB`;
    }
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }

  function setStatus(message, error) {
    els.status.textContent = message;
    els.status.dataset.tone = error ? "error" : "default";
  }
}());
