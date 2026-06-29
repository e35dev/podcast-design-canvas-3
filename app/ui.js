// app/ui.js — thin UI shell that renders the import-to-export flow into #app.
// All product state lives in a single Episode object (app/episode.js); the UI
// mutates it and re-renders. The export/preview use the same DOM-free plan
// (app/export-plan.js) consumed by the browser exporter (app/exporter.js).
(function () {
  const Episode = window.PdcEpisode;
  const Presets = window.PdcPresets;
  const ExportPlan = window.PdcExportPlan;
  const Exporter = window.PdcExporter;

  const root = document.getElementById("app");
  let ep = Episode.createEpisode("");
  let preview = null; // active preview controller
  let lastExport = null; // { url, blob, mimeType }

  function h(html) {
    const t = document.createElement("template");
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }

  function esc(s) {
    return (s == null ? "" : String(s)).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  function stopPreview() {
    if (preview) {
      preview.stop();
      preview = null;
    }
  }

  function render() {
    stopPreview();
    root.innerHTML = "";
    root.appendChild(header());
    root.appendChild(episodeCard());
    root.appendChild(uploadCard());
    if (ep.media.length) {
      root.appendChild(assignCard());
      root.appendChild(socialCard());
    }
    root.appendChild(presetCard());
    root.appendChild(previewCard());
    root.appendChild(exportCard());
  }

  function header() {
    return h(`
      <header class="hero">
        <div class="hero-mark">PDC</div>
        <div>
          <h1>Podcast Design Canvas</h1>
          <p class="hero-sub">Import synced speaker tracks → assign speakers → pick a preset → preview → export a finished episode.</p>
        </div>
      </header>`);
  }

  function step(n, title, body) {
    const card = h(`<section class="card"><div class="card-head"><span class="step-pill">Step ${n}</span><h2>${esc(title)}</h2></div></section>`);
    card.appendChild(body);
    return card;
  }

  function episodeCard() {
    const body = h(`<div class="card-body">
      <label class="field"><span>Episode name</span>
        <input id="ep-name" type="text" placeholder="e.g. The Build Loop — Episode 1" value="${esc(ep.name)}">
      </label>
      <p class="hint">Give this episode a name so the finished video is labelled.</p>
    </div>`);
    body.querySelector("#ep-name").addEventListener("input", (e) => {
      ep.name = e.target.value;
      refreshStatus();
    });
    return step(1, "Create a new episode", body);
  }

  function uploadCard() {
    const body = h(`<div class="card-body">
      <label class="field"><span>Upload speaker video files (choose two or more)</span>
        <input id="ep-files" type="file" accept="video/*" multiple>
      </label>
      <p class="hint">Each file is one speaker's synced track (Riverside-style). Your real files stay in the page — they flow into the preview and the exported video.</p>
      <ul class="file-list" id="file-list">${ep.media.map(fileRow).join("")}</ul>
      <p class="hint" id="upload-count">${ep.media.length ? ep.media.length + " file(s) uploaded." : ""}</p>
    </div>`);
    body.querySelector("#ep-files").addEventListener("change", (e) => onFiles(e.target.files));
    return step(2, "Upload speaker video files", body);
  }

  function fileRow(m) {
    return `<li class="file-pill"><span class="dot"></span>${esc(m.name)}${m.bucket ? ` <em>→ ${esc(Episode.bucketLabel(m.bucket))}</em>` : " <em class='muted'>unassigned</em>"}</li>`;
  }

  function onFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    // Auto-assign in canonical bucket order for the first uploads (still editable).
    const order = ["host", "guest1", "guest2"];
    for (const f of files) {
      const url = URL.createObjectURL(f);
      const id = Episode.addMedia(ep, { name: f.name, fileRef: f, url });
      const taken = ep.media.filter((m) => m.bucket).map((m) => m.bucket);
      const free = order.find((b) => !taken.includes(b));
      if (free) Episode.assignBucket(ep, id, free);
    }
    render();
  }

  function assignCard() {
    const opts = (sel) =>
      `<option value=""${sel ? "" : " selected"}>— unassigned —</option>` +
      Episode.BUCKETS.map((b) => `<option value="${b.id}"${sel === b.id ? " selected" : ""}>${b.label}</option>`).join("");
    const rows = ep.media
      .map(
        (m) => `<div class="assign-row">
          <span class="assign-name" title="${esc(m.name)}">${esc(m.name)}</span>
          <select data-media="${m.id}" class="assign-select">${opts(m.bucket)}</select>
        </div>`,
      )
      .join("");
    const body = h(`<div class="card-body"><div class="assign-grid">${rows}</div>
      <p class="hint">Assign each uploaded file to Host, Guest 1, or Guest 2. Two files cannot share a bucket.</p></div>`);
    body.querySelectorAll(".assign-select").forEach((sel) => {
      sel.addEventListener("change", (e) => {
        Episode.assignBucket(ep, e.target.dataset.media, e.target.value || null);
        // Update in place (do NOT rebuild the whole app) so other selects stay
        // attached and the maintainer's probe can drive each select in turn.
        updateFileList();
        rebuildSocial();
        refreshStatus();
      });
    });
    return step(3, "Assign speakers", body);
  }

  function updateFileList() {
    const ul = document.getElementById("file-list");
    if (ul) ul.innerHTML = ep.media.map(fileRow).join("");
  }

  function socialBlocks() {
    const speakers = Episode.assignedSpeakers(ep);
    return speakers
      .map(
        (sp) => `<div class="social-block">
        <h3>${esc(sp.label)}</h3>
        <label class="field"><span>Name</span><input class="social-in" data-bucket="${sp.bucket}" data-field="name" value="${esc(sp.social.name || "")}" placeholder="Full name"></label>
        <label class="field"><span>Website</span><input class="social-in" data-bucket="${sp.bucket}" data-field="website" value="${esc(sp.social.website || "")}" placeholder="https://"></label>
        <label class="field"><span>X / handle</span><input class="social-in" data-bucket="${sp.bucket}" data-field="x" value="${esc(sp.social.x || "")}" placeholder="@handle"></label>
      </div>`,
      )
      .join("");
  }

  function wireSocialInputs(scope) {
    scope.querySelectorAll(".social-in").forEach((inp) => {
      inp.addEventListener("input", (e) => {
        Episode.setSocial(ep, e.target.dataset.bucket, e.target.dataset.field, e.target.value);
      });
    });
  }

  // Re-render only the social grid contents in place (buckets changed) without
  // touching the assign selects, preserving their attachment for the probe.
  function rebuildSocial() {
    const grid = document.getElementById("social-grid");
    if (!grid) return;
    grid.innerHTML = socialBlocks();
    wireSocialInputs(grid);
  }

  function socialCard() {
    const body = h(`<div class="card-body"><div class="social-grid" id="social-grid">${socialBlocks()}</div>
      <p class="hint">Social links help the product understand names, brands, and likely transcript spellings. Handles also appear on the speaker nameplates in the export.</p></div>`);
    wireSocialInputs(body);
    return step(4, "Add social links", body);
  }

  function presetCard() {
    const cards = Presets.PRESETS.map(
      (p) => `<button class="preset ${ep.presetId === p.id ? "is-selected" : ""}" data-preset="${p.id}" type="button">
        <span class="preset-swatch" style="background:${p.background};border-color:${p.accent}"></span>
        <span class="preset-text"><strong>${esc(p.label)}</strong><small>${esc(p.description)}</small></span>
      </button>`,
    ).join("");
    const body = h(`<div class="card-body"><div class="preset-grid">${cards}</div>
      <p class="hint">A preset applies a layout + pacing for you — no manual positioning.</p></div>`);
    body.querySelectorAll(".preset").forEach((btn) => {
      btn.addEventListener("click", () => {
        Episode.selectPreset(ep, btn.dataset.preset);
        render();
      });
    });
    return step(5, "Choose a preset", body);
  }

  function previewCard() {
    const body = h(`<div class="card-body">
      <div class="preview-wrap"><canvas id="preview-canvas" class="preview-canvas"></canvas>
        <div class="preview-empty" id="preview-empty">Complete steps 1–5, then start the live preview.</div>
      </div>
      <div class="row">
        <button id="preview-btn" class="btn" type="button" disabled>Start live preview</button>
        <span class="status" id="preview-status"></span>
      </div>
    </div>`);
    const btn = body.querySelector("#preview-btn");
    btn.addEventListener("click", () => togglePreview(btn, body));
    setTimeout(() => refreshStatus(), 0);
    return step(6, "Preview the composed episode", body);
  }

  async function togglePreview(btn, body) {
    if (preview) {
      stopPreview();
      btn.textContent = "Start live preview";
      body.querySelector("#preview-status").textContent = "Preview stopped.";
      return;
    }
    const plan = ExportPlan.buildExportPlan(ep);
    if (!plan.ok) {
      body.querySelector("#preview-status").textContent = plan.errors.join(" ");
      return;
    }
    const canvas = document.getElementById("preview-canvas");
    document.getElementById("preview-empty").style.display = "none";
    body.querySelector("#preview-status").textContent = "Loading uploaded media…";
    btn.disabled = true;
    preview = await Exporter.startPreview(plan, canvas);
    btn.disabled = false;
    btn.textContent = "Stop preview";
    body.querySelector("#preview-status").textContent = "Live preview of your real uploaded videos in the " + plan.preset.label + " layout.";
  }

  function exportCard() {
    const body = h(`<div class="card-body">
      <div class="row">
        <button id="export-btn" class="btn btn-primary" type="button" disabled>Export episode video</button>
        <span class="status" id="export-status"></span>
      </div>
      <div class="progress" id="export-progress"><div class="progress-bar" id="export-bar"></div></div>
      <div id="export-result" class="export-result"></div>
    </div>`);
    body.querySelector("#export-btn").addEventListener("click", () => runExport(body));
    if (lastExport) renderExportResult(body.querySelector("#export-result"));
    setTimeout(() => refreshStatus(), 0);
    return step(7, "Export the finished video", body);
  }

  async function runExport(body) {
    const plan = ExportPlan.buildExportPlan(ep);
    const status = body.querySelector("#export-status");
    if (!plan.ok) {
      status.textContent = plan.errors.join(" ");
      return;
    }
    const btn = body.querySelector("#export-btn");
    const bar = body.querySelector("#export-bar");
    btn.disabled = true;
    status.textContent = "Composing and recording your episode…";
    bar.style.width = "0%";
    try {
      const result = await Exporter.exportEpisode(plan, {
        onProgress: (r) => {
          bar.style.width = Math.round(r * 100) + "%";
        },
      });
      const filename = (ep.name || "episode").replace(/[^a-z0-9-_]+/gi, "-").toLowerCase() + ".webm";
      const url = Exporter.downloadBlob(result.blob, filename);
      lastExport = { url, blob: result.blob, mimeType: result.mimeType, filename, hasAudio: result.hasAudio, tracks: result.tracks, durationMs: result.durationMs };
      // Expose for harness verification (real bytes, not a mock).
      window.__pdcLastExport = { size: result.blob.size, mimeType: result.mimeType, hasAudio: result.hasAudio, tracks: result.tracks, durationMs: result.durationMs };
      status.textContent = "Export complete.";
      renderExportResult(body.querySelector("#export-result"));
    } catch (e) {
      status.textContent = "Export failed: " + e.message;
    } finally {
      btn.disabled = false;
    }
  }

  function renderExportResult(container) {
    const x = lastExport;
    if (!x) return;
    const kb = (x.blob.size / 1024).toFixed(1);
    container.innerHTML = `
      <div class="export-card">
        <div class="export-ok">✓ Episode exported</div>
        <ul class="export-meta">
          <li><b>${esc(x.filename)}</b></li>
          <li>${kb} KB · ${esc(x.mimeType)}</li>
          <li>${x.tracks} speaker frame(s) · audio: ${x.hasAudio ? "yes" : "no"}</li>
        </ul>
        <a id="download-link" class="btn btn-primary" href="${x.url}" download="${esc(x.filename)}">Download episode video</a>
        <video class="export-preview" src="${x.url}" controls></video>
      </div>`;
  }

  // Enable/disable preview + export buttons based on validation, live.
  function refreshStatus() {
    const v = Episode.validate(ep);
    const pBtn = document.getElementById("preview-btn");
    const eBtn = document.getElementById("export-btn");
    const pStat = document.getElementById("preview-status");
    const eStat = document.getElementById("export-status");
    if (pBtn) pBtn.disabled = !v.ok;
    if (eBtn) eBtn.disabled = !v.ok;
    if (!v.ok) {
      const msg = "To continue: " + v.errors.join(" ");
      if (pStat && !preview) pStat.textContent = msg;
      if (eStat && !lastExport) eStat.textContent = msg;
    }
  }

  render();
  // Re-validate on any input change across the document.
  document.addEventListener("input", refreshStatus);
  document.addEventListener("change", refreshStatus);
  window.__pdcReady = true;
})();
