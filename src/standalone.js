(function () {
  const CANVAS_WIDTH = 1280;
  const CANVAS_HEIGHT = 720;
  const speakerRoles = ["host", "guest1", "guest2"];
  const speakerLabels = {
    host: "Host",
    guest1: "Guest 1",
    guest2: "Guest 2"
  };
  const presets = [
    {
      id: "roundtable",
      name: "Roundtable rhythm",
      description: "Balanced split-screen pacing for panel conversations."
    },
    {
      id: "hostFocus",
      name: "Host spotlight",
      description: "Host-led composition with guest reactions stacked beside it."
    },
    {
      id: "socialStudio",
      name: "Social studio",
      description: "Editorial lower thirds and a warmer branded stage."
    }
  ];

  const state = {
    episodeTitle: "New podcast episode",
    presetId: "roundtable",
    tracks: speakerRoles.map((role) => ({
      role,
      label: speakerLabels[role],
      socialLink: ""
    })),
    previewing: false,
    exporting: false,
    exportProgress: 0,
    exportStatus: ""
  };

  let animationFrame = 0;
  const app = document.querySelector("#app");

  if (!app) {
    throw new Error("App root not found.");
  }

  render();

  function render() {
    app.innerHTML = `
      <section class="workspace">
        <aside class="setup-panel" aria-label="Episode setup">
          <div class="brand-block">
            <p class="eyebrow">Podcast Design Canvas</p>
            <h1>Episode import to export</h1>
          </div>

          <label class="field">
            <span>Episode title</span>
            <input data-action="title" type="text" value="${escapeAttribute(state.episodeTitle)}" />
          </label>

          <div class="section-heading">
            <h2>Speaker buckets</h2>
            <span>${loadedTracksFromState().length}/3 ready</span>
          </div>
          <div class="speaker-list">
            ${state.tracks.map(renderSpeakerBucket).join("")}
          </div>

          <div class="section-heading">
            <h2>Preset</h2>
            <span>Layout and pacing</span>
          </div>
          <div class="preset-grid" role="radiogroup" aria-label="Preset">
            ${presets.map(renderPreset).join("")}
          </div>
        </aside>

        <section class="preview-panel" aria-label="Preview and export">
          <div class="preview-toolbar">
            <div>
              <p class="eyebrow">Live composition</p>
              <h2>${escapeHtml(currentPresetName())}</h2>
            </div>
            <div class="toolbar-actions">
              <button class="secondary" data-action="preview" ${canPreview() ? "" : "disabled"}>
                ${state.previewing ? "Restart preview" : "Preview"}
              </button>
              <button class="primary" data-action="export" ${canExport() ? "" : "disabled"}>
                ${state.exporting ? "Exporting..." : "Export video"}
              </button>
            </div>
          </div>

          <div class="canvas-shell">
            <canvas id="composition-canvas" width="${CANVAS_WIDTH}" height="${CANVAS_HEIGHT}"></canvas>
            ${renderEmptyState()}
          </div>

          <div class="status-row">
            <div>
              <strong>${workflowStatus()}</strong>
              <span>${durationText()}</span>
            </div>
            <progress value="${state.exportProgress}" max="1" ${state.exporting || state.exportUrl ? "" : "hidden"}></progress>
          </div>

          ${state.error ? `<p class="notice error">${escapeHtml(state.error)}</p>` : ""}
          ${state.exportUrl ? renderDownload() : ""}
        </section>
      </section>
    `;

    bindEvents();
    drawCurrentFrame();

    if (state.previewing) {
      startPreviewLoop();
    }
  }

  function renderSpeakerBucket(track) {
    const fileName = track.file ? track.file.name : "Choose synced video";
    const duration =
      track.video && Number.isFinite(track.video.duration) ? formatDuration(track.video.duration) : "No media yet";

    return `
      <article class="speaker-card">
        <div class="speaker-card__head">
          <div>
            <h3>${escapeHtml(track.label)}</h3>
            <p>${escapeHtml(duration)}</p>
          </div>
          <span class="${track.file ? "ready-pill" : "empty-pill"}">${track.file ? "Ready" : "Empty"}</span>
        </div>
        <label class="file-picker">
          <input data-action="file" data-role="${track.role}" type="file" accept="video/*" />
          <span>${escapeHtml(fileName)}</span>
        </label>
        <label class="field compact">
          <span>Social link</span>
          <input data-action="social" data-role="${track.role}" type="url" placeholder="https://..." value="${escapeAttribute(track.socialLink)}" />
        </label>
      </article>
    `;
  }

  function renderPreset(preset) {
    const checked = preset.id === state.presetId;

    return `
      <button class="preset-card ${checked ? "selected" : ""}" data-action="preset" data-preset="${preset.id}" role="radio" aria-checked="${checked}">
        <strong>${escapeHtml(preset.name)}</strong>
        <span>${escapeHtml(preset.description)}</span>
      </button>
    `;
  }

  function renderEmptyState() {
    if (loadedTracksFromState().length > 0) {
      return "";
    }

    return `
      <div class="empty-preview">
        <strong>Add at least two speaker videos</strong>
        <span>The canvas will render the selected preset from the uploaded media.</span>
      </div>
    `;
  }

  function renderDownload() {
    const fileName = state.exportFileName || "podcast-episode-designed.webm";

    return `
      <div class="download-panel">
        <div>
          <strong>Export ready</strong>
          <span>${escapeHtml(fileName)}</span>
        </div>
        <a class="download-link" href="${state.exportUrl}" download="${escapeAttribute(fileName)}">
          Download WebM
        </a>
      </div>
    `;
  }

  function bindEvents() {
    app.querySelector("[data-action='title']")?.addEventListener("input", (event) => {
      state.episodeTitle = event.currentTarget.value;
    });

    app.querySelectorAll("[data-action='file']").forEach((input) => {
      input.addEventListener("change", (event) => {
        const role = event.currentTarget.dataset.role;
        const file = event.currentTarget.files && event.currentTarget.files[0];

        if (file) {
          setTrackFile(role, file);
        }
      });
    });

    app.querySelectorAll("[data-action='social']").forEach((input) => {
      input.addEventListener("input", (event) => {
        const role = event.currentTarget.dataset.role;
        const track = state.tracks.find((candidate) => candidate.role === role);

        if (track) {
          track.socialLink = event.currentTarget.value;
        }
      });
    });

    app.querySelectorAll("[data-action='preset']").forEach((button) => {
      button.addEventListener("click", () => {
        state.presetId = button.dataset.preset;
        state.error = undefined;
        render();
      });
    });

    app.querySelector("[data-action='preview']")?.addEventListener("click", startPreview);
    app.querySelector("[data-action='export']")?.addEventListener("click", startExport);
  }

  async function setTrackFile(role, file) {
    const track = state.tracks.find((candidate) => candidate.role === role);

    if (!track) {
      return;
    }

    if (track.objectUrl) {
      URL.revokeObjectURL(track.objectUrl);
    }

    const objectUrl = URL.createObjectURL(file);
    const video = createPreviewVideo(objectUrl);

    try {
      await waitForMetadata(video);
      track.file = file;
      track.objectUrl = objectUrl;
      track.video = video;
      state.error = undefined;
    } catch (error) {
      URL.revokeObjectURL(objectUrl);
      state.error = getErrorMessage(error);
    }

    state.exportUrl = undefined;
    state.exportFileName = undefined;
    render();
  }

  async function startPreview() {
    const tracks = loadedTracksFromState();

    if (tracks.length < 2) {
      state.error = "Upload at least two synced speaker videos before previewing.";
      render();
      return;
    }

    state.error = undefined;
    state.previewing = true;
    tracks.forEach((track) => {
      track.video.currentTime = 0;
    });

    try {
      await Promise.all(tracks.map((track) => track.video.play()));
    } catch (error) {
      state.previewing = false;
      state.error = getErrorMessage(error);
    }

    render();
  }

  async function startExport() {
    const tracks = loadedTracksFromState();

    if (tracks.length < 2) {
      state.error = "Upload at least two synced speaker videos before exporting.";
      render();
      return;
    }

    stopPreviewLoop();
    state.previewing = false;
    state.exporting = true;
    state.exportProgress = 0;
    state.exportStatus = "Preparing export...";
    state.error = undefined;
    state.exportUrl = undefined;
    render();

    try {
      const blob = await exportEpisodeVideo({
        presetId: state.presetId,
        tracks,
        onProgress: ({ state: exportState, progress }) => {
          state.exportProgress = progress;
          state.exportStatus =
            exportState === "recording"
              ? `Recording composed episode ${Math.round(progress * 100)}%`
              : exportState === "finalizing"
                ? "Finalizing downloadable video..."
                : "Preparing media...";
          updateExportProgress();
        }
      });

      state.exportUrl = URL.createObjectURL(blob);
      state.exportFileName = getExportFileName(state.episodeTitle);
      state.exportStatus = "Download is ready.";
    } catch (error) {
      state.error = getErrorMessage(error);
      state.exportStatus = "Export failed.";
    } finally {
      state.exporting = false;
      state.exportProgress = state.exportUrl ? 1 : 0;
      render();
    }
  }

  function updateExportProgress() {
    const progress = app.querySelector("progress");
    const status = app.querySelector(".status-row strong");

    if (progress) {
      progress.value = state.exportProgress;
      progress.hidden = false;
    }

    if (status) {
      status.textContent = state.exportStatus;
    }
  }

  function startPreviewLoop() {
    stopPreviewLoop();
    const loop = () => {
      drawCurrentFrame();
      animationFrame = requestAnimationFrame(loop);
    };
    loop();
  }

  function stopPreviewLoop() {
    if (animationFrame) {
      cancelAnimationFrame(animationFrame);
      animationFrame = 0;
    }
  }

  function drawCurrentFrame() {
    const canvas = app.querySelector("#composition-canvas");
    const ctx = canvas && canvas.getContext("2d");
    const tracks = loadedTracksFromState();

    if (!canvas || !ctx) {
      return;
    }

    if (tracks.length === 0) {
      ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
      return;
    }

    drawComposition(ctx, {
      presetId: state.presetId,
      tracks,
      time: tracks[0]?.video.currentTime || 0,
      width: CANVAS_WIDTH,
      height: CANVAS_HEIGHT
    });
  }

  async function exportEpisodeVideo(options) {
    options.onProgress?.({ state: "preparing", progress: 0 });

    const exportCanvas = document.createElement("canvas");
    exportCanvas.width = CANVAS_WIDTH;
    exportCanvas.height = CANVAS_HEIGHT;
    const ctx = exportCanvas.getContext("2d");

    if (!ctx) {
      throw new Error("Canvas rendering is not available in this browser.");
    }

    const exportTracks = await createExportTracks(options.tracks);
    const duration = getEpisodeDuration(exportTracks);

    if (duration <= 0) {
      throw new Error("The uploaded videos need readable durations before export can start.");
    }

    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) {
      throw new Error("This browser cannot mix uploaded media audio.");
    }

    const audioContext = new AudioContextCtor();
    const audioDestination = audioContext.createMediaStreamDestination();

    exportTracks.forEach((track) => {
      const source = audioContext.createMediaElementSource(track.video);
      const gain = audioContext.createGain();
      gain.gain.value = 1 / exportTracks.length;
      source.connect(gain).connect(audioDestination);
    });

    if (!exportCanvas.captureStream || !window.MediaRecorder) {
      throw new Error("This browser cannot record the composed canvas video.");
    }

    const canvasStream = exportCanvas.captureStream(30);
    const mixedStream = new MediaStream([
      ...canvasStream.getVideoTracks(),
      ...audioDestination.stream.getAudioTracks()
    ]);
    const recorder = new MediaRecorder(mixedStream, {
      mimeType: chooseMimeType()
    });
    const chunks = [];

    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) {
        chunks.push(event.data);
      }
    });

    const finished = new Promise((resolve, reject) => {
      recorder.addEventListener("stop", () => {
        resolve(new Blob(chunks, { type: recorder.mimeType || "video/webm" }));
      });
      recorder.addEventListener("error", () => {
        reject(new Error("The browser stopped the export recorder."));
      });
    });

    exportTracks.forEach((track) => {
      track.video.currentTime = 0;
    });

    await audioContext.resume();
    await Promise.all(exportTracks.map((track) => track.video.play()));

    const startedAt = performance.now();
    let frameId = 0;
    const renderExportFrame = () => {
      const elapsed = (performance.now() - startedAt) / 1000;
      const time = Math.min(elapsed, duration);
      drawComposition(ctx, {
        presetId: options.presetId,
        tracks: exportTracks,
        time,
        width: CANVAS_WIDTH,
        height: CANVAS_HEIGHT
      });

      options.onProgress?.({
        state: "recording",
        progress: Math.min(time / duration, 1)
      });

      if (time >= duration || exportTracks.every((track) => track.video.ended)) {
        options.onProgress?.({ state: "finalizing", progress: 1 });
        recorder.stop();
        return;
      }

      frameId = requestAnimationFrame(renderExportFrame);
    };

    recorder.start(1000);
    renderExportFrame();

    const blob = await finished.finally(() => {
      cancelAnimationFrame(frameId);
      exportTracks.forEach((track) => track.video.pause());
      mixedStream.getTracks().forEach((track) => track.stop());
      audioContext.close();
    });

    if (blob.size === 0) {
      throw new Error("The export completed without video data.");
    }

    return blob;
  }

  async function createExportTracks(tracks) {
    const exportTracks = tracks.map((track) => {
      const video = document.createElement("video");
      video.src = track.objectUrl;
      video.muted = false;
      video.playsInline = true;
      video.preload = "auto";

      return {
        ...track,
        video
      };
    });

    await Promise.all(exportTracks.map((track) => waitForMetadata(track.video)));
    return exportTracks;
  }

  function drawComposition(ctx, compositionState) {
    const frames = computeSpeakerFrames(compositionState);

    drawStage(ctx, compositionState);
    frames.forEach((frame) => {
      const track = compositionState.tracks.find((candidate) => candidate.role === frame.role);
      if (!track) {
        return;
      }

      drawVideoCover(ctx, track.video, frame);
      drawFrameChrome(ctx, frame, compositionState.presetId);
      drawLowerThird(ctx, frame, compositionState.presetId);
    });

    drawEpisodeChrome(ctx, compositionState, frames.length);
  }

  function computeSpeakerFrames(compositionState) {
    const tracks = compositionState.tracks.slice(0, 3);

    if (compositionState.presetId === "hostFocus") {
      return computeHostFocusFrames(tracks, compositionState);
    }

    if (compositionState.presetId === "socialStudio") {
      return computeSocialStudioFrames(tracks, compositionState);
    }

    return computeRoundtableFrames(tracks, compositionState);
  }

  function computeRoundtableFrames(tracks, compositionState) {
    const gap = 24;
    const outer = 48;
    const count = Math.max(tracks.length, 1);
    const frameWidth = (compositionState.width - outer * 2 - gap * (count - 1)) / count;
    const frameHeight = 492;
    const y = 118;

    return tracks.map((track, index) => ({
      role: track.role,
      label: track.label,
      socialLink: track.socialLink,
      emphasized: false,
      x: outer + index * (frameWidth + gap),
      y,
      width: frameWidth,
      height: frameHeight
    }));
  }

  function computeHostFocusFrames(tracks, compositionState) {
    const host = tracks.find((track) => track.role === "host") || tracks[0];
    const guests = tracks.filter((track) => track.role !== host.role);
    const frames = [
      {
        role: host.role,
        label: host.label,
        socialLink: host.socialLink,
        emphasized: true,
        x: 48,
        y: 104,
        width: guests.length > 0 ? 760 : compositionState.width - 96,
        height: 520
      }
    ];

    guests.forEach((track, index) => {
      frames.push({
        role: track.role,
        label: track.label,
        socialLink: track.socialLink,
        emphasized: false,
        x: 840,
        y: 104 + index * 268,
        width: 392,
        height: guests.length === 1 ? 520 : 244
      });
    });

    return frames;
  }

  function computeSocialStudioFrames(tracks, compositionState) {
    const featuredIndex = Math.floor(compositionState.time / 12) % tracks.length;
    const featured = tracks[featuredIndex];
    const others = tracks.filter((_, index) => index !== featuredIndex);
    const frames = [
      {
        role: featured.role,
        label: featured.label,
        socialLink: featured.socialLink,
        emphasized: true,
        x: 58,
        y: 92,
        width: others.length > 0 ? 690 : compositionState.width - 116,
        height: 524
      }
    ];

    others.forEach((track, index) => {
      frames.push({
        role: track.role,
        label: track.label,
        socialLink: track.socialLink,
        emphasized: false,
        x: 790 + index * 214,
        y: 164,
        width: others.length === 1 ? 432 : 198,
        height: 378
      });
    });

    return frames;
  }

  function drawStage(ctx, compositionState) {
    const gradient = ctx.createLinearGradient(0, 0, compositionState.width, compositionState.height);

    if (compositionState.presetId === "socialStudio") {
      gradient.addColorStop(0, "#13211d");
      gradient.addColorStop(0.54, "#20332d");
      gradient.addColorStop(1, "#473322");
    } else if (compositionState.presetId === "hostFocus") {
      gradient.addColorStop(0, "#151a22");
      gradient.addColorStop(0.55, "#26303d");
      gradient.addColorStop(1, "#1f2d34");
    } else {
      gradient.addColorStop(0, "#111827");
      gradient.addColorStop(0.5, "#1f2937");
      gradient.addColorStop(1, "#26333d");
    }

    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, compositionState.width, compositionState.height);
    ctx.fillStyle = "rgba(255,255,255,0.05)";
    ctx.fillRect(0, 642, compositionState.width, 78);
  }

  function drawVideoCover(ctx, video, rect) {
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      drawPendingVideo(ctx, rect);
      return;
    }

    const videoWidth = video.videoWidth || 16;
    const videoHeight = video.videoHeight || 9;
    const scale = Math.max(rect.width / videoWidth, rect.height / videoHeight);
    const sourceWidth = rect.width / scale;
    const sourceHeight = rect.height / scale;
    const sourceX = (videoWidth - sourceWidth) / 2;
    const sourceY = (videoHeight - sourceHeight) / 2;

    ctx.save();
    roundedRect(ctx, rect.x, rect.y, rect.width, rect.height, 18);
    ctx.clip();
    ctx.drawImage(video, sourceX, sourceY, sourceWidth, sourceHeight, rect.x, rect.y, rect.width, rect.height);
    ctx.restore();
  }

  function drawPendingVideo(ctx, rect) {
    ctx.save();
    roundedRect(ctx, rect.x, rect.y, rect.width, rect.height, 18);
    ctx.clip();
    ctx.fillStyle = "#17202a";
    ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
    ctx.fillStyle = "rgba(255,255,255,0.12)";
    for (let x = rect.x - rect.height; x < rect.x + rect.width; x += 56) {
      ctx.fillRect(x, rect.y, 24, rect.height * 1.6);
    }
    ctx.restore();
  }

  function drawFrameChrome(ctx, frame, presetId) {
    ctx.save();
    roundedRect(ctx, frame.x, frame.y, frame.width, frame.height, 18);
    ctx.lineWidth = frame.emphasized ? 6 : 3;
    ctx.strokeStyle = presetId === "socialStudio" ? "#f6c177" : frame.emphasized ? "#7dd3fc" : "rgba(255,255,255,0.45)";
    ctx.stroke();
    ctx.restore();
  }

  function drawLowerThird(ctx, frame, presetId) {
    const pad = 18;
    const boxHeight = frame.socialLink ? 78 : 56;
    const x = frame.x + pad;
    const y = frame.y + frame.height - boxHeight - pad;
    const width = Math.min(frame.width - pad * 2, frame.emphasized ? 390 : 270);

    ctx.save();
    roundedRect(ctx, x, y, width, boxHeight, 14);
    ctx.fillStyle = presetId === "socialStudio" ? "rgba(19, 33, 29, 0.82)" : "rgba(15, 23, 42, 0.78)";
    ctx.fill();

    ctx.fillStyle = "#ffffff";
    ctx.font = "700 24px Inter, system-ui, sans-serif";
    ctx.fillText(frame.label, x + 18, y + 34);

    if (frame.socialLink) {
      ctx.fillStyle = presetId === "socialStudio" ? "#f6c177" : "#93c5fd";
      ctx.font = "500 17px Inter, system-ui, sans-serif";
      ctx.fillText(shortenSocial(frame.socialLink), x + 18, y + 61, width - 36);
    }

    ctx.restore();
  }

  function drawEpisodeChrome(ctx, compositionState, speakerCount) {
    ctx.fillStyle = "rgba(255,255,255,0.88)";
    ctx.font = "700 26px Inter, system-ui, sans-serif";
    ctx.fillText("Podcast Design Canvas", 48, 58);

    ctx.fillStyle = "rgba(255,255,255,0.58)";
    ctx.font = "500 18px Inter, system-ui, sans-serif";
    const preset = presets.find((candidate) => candidate.id === compositionState.presetId);
    ctx.fillText(`${preset?.name || "Preset"} - ${speakerCount} synced speaker tracks`, 48, 86);
  }

  function createPreviewVideo(url) {
    const video = document.createElement("video");
    video.src = url;
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.preload = "metadata";
    return video;
  }

  function waitForMetadata(video) {
    if (video.readyState >= HTMLMediaElement.HAVE_METADATA) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const onLoaded = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error("The selected video file could not be loaded."));
      };
      const cleanup = () => {
        video.removeEventListener("loadedmetadata", onLoaded);
        video.removeEventListener("error", onError);
      };

      video.addEventListener("loadedmetadata", onLoaded);
      video.addEventListener("error", onError);
    });
  }

  function chooseMimeType() {
    const supportedType = [
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm"
    ].find((type) => MediaRecorder.isTypeSupported(type));

    if (!supportedType) {
      throw new Error("This browser cannot export WebM video with MediaRecorder.");
    }

    return supportedType;
  }

  function loadedTracksFromState() {
    return state.tracks.filter((track) => Boolean(track.file && track.objectUrl && track.video));
  }

  function hasEnoughTracks(tracks) {
    return tracks.filter((track) => track.file).length >= 2;
  }

  function getEpisodeDuration(tracks) {
    const finiteDurations = tracks
      .map((track) => track.video.duration)
      .filter((duration) => Number.isFinite(duration) && duration > 0);

    if (finiteDurations.length === 0) {
      return 0;
    }

    return Math.min(...finiteDurations);
  }

  function getExportFileName(episodeTitle) {
    const slug = episodeTitle
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");

    return `${slug || "podcast-episode"}-designed.webm`;
  }

  function canPreview() {
    return hasEnoughTracks(state.tracks) && !state.exporting;
  }

  function canExport() {
    return hasEnoughTracks(state.tracks) && !state.exporting;
  }

  function workflowStatus() {
    if (state.exportStatus) {
      return state.exportStatus;
    }

    if (state.previewing) {
      return "Previewing real uploaded media.";
    }

    if (loadedTracksFromState().length >= 2) {
      return "Ready to preview and export.";
    }

    return "Waiting for synced speaker uploads.";
  }

  function durationText() {
    const tracks = loadedTracksFromState();
    const duration = getEpisodeDuration(tracks);

    if (duration <= 0) {
      return "Export duration appears after media metadata loads.";
    }

    return `Export length: ${formatDuration(duration)} from the synced uploaded files.`;
  }

  function currentPresetName() {
    return presets.find((preset) => preset.id === state.presetId)?.name || "Preset";
  }

  function formatDuration(duration) {
    const totalSeconds = Math.floor(duration);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
    }

    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
  }

  function shortenSocial(value) {
    return value
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .replace(/\/$/, "");
  }

  function roundedRect(ctx, x, y, width, height, radius) {
    const safeRadius = Math.min(radius, width / 2, height / 2);
    ctx.beginPath();
    ctx.moveTo(x + safeRadius, y);
    ctx.arcTo(x + width, y, x + width, y + height, safeRadius);
    ctx.arcTo(x + width, y + height, x, y + height, safeRadius);
    ctx.arcTo(x, y + height, x, y, safeRadius);
    ctx.arcTo(x, y, x + width, y, safeRadius);
    ctx.closePath();
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (character) => {
      const entities = {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;"
      };
      return entities[character];
    });
  }

  function escapeAttribute(value) {
    return escapeHtml(value);
  }

  function getErrorMessage(error) {
    return error instanceof Error ? error.message : "Something went wrong.";
  }
})();
