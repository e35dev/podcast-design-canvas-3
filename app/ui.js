// app/ui.js  (browser entry — classic script, runs last)
// Wires the import -> assign -> style -> preview -> export workflow to the DOM,
// driving the real-frame compositor and the MediaRecorder exporter. Reads all
// logic from the global PDC namespace (no ES modules, so it works over file://).
(function () {
  const PDC = window.PDC;
  const { SPEAKER_BUCKETS, BUCKET_LABELS, PRESETS } = PDC.presets;
  const { createEpisode, assignSpeakerFile, setSocialLink, setPreset, canCompose, readinessReason, assignedBuckets } = PDC.episode;
  const { buildExportPlan } = PDC.exportPlan;
  const { drawComposite } = PDC.compositor;
  const { exportEpisode, downloadBlob } = PDC.exporter;

  const episode = createEpisode({ title: "Episode 1" });
  const videos = {};
  let plan = null;
  let previewRAF = 0;

  const $ = (id) => document.getElementById(id);
  const stage = $("stage");
  const ctx = stage.getContext("2d");

  const bucketsEl = $("buckets");
  for (const bucket of SPEAKER_BUCKETS) {
    const card = document.createElement("div");
    card.className = "bucket";
    card.innerHTML =
      `<div class="bucket-head">${BUCKET_LABELS[bucket]}</div>` +
      `<input type="file" accept="video/*" data-bucket="${bucket}" class="file" />` +
      `<input type="url" placeholder="social link (optional)" data-link="${bucket}" class="link" />` +
      `<div class="bucket-status" data-status="${bucket}">No file</div>`;
    bucketsEl.appendChild(card);
  }

  bucketsEl.addEventListener("change", async (e) => {
    const t = e.target;
    if (t.dataset.bucket && t.files && t.files[0]) await loadSpeakerFile(t.dataset.bucket, t.files[0]);
    else if (t.dataset.link) setSocialLink(episode, t.dataset.link, t.value.trim());
  });

  async function loadSpeakerFile(bucket, file) {
    const url = URL.createObjectURL(file);
    const v = document.createElement("video");
    v.preload = "auto";
    v.src = url;
    v.playsInline = true;
    v.muted = true;
    await new Promise((res) => {
      const ok = () => { if (v.readyState >= 2) res(); };
      v.onloadeddata = ok;
      v.oncanplay = ok;
      v.onerror = res;
      setTimeout(res, 6000);
    });
    await new Promise((res) => {
      v.onseeked = res;
      try { v.currentTime = 0.05; } catch (e) { res(); }
      setTimeout(res, 1500);
    });
    videos[bucket] = v;
    assignSpeakerFile(episode, bucket, { name: file.name, size: file.size, type: file.type, durationSec: isFinite(v.duration) ? v.duration : 0 });
    const st = $(`[data-status="${bucket}"]`);
    st.textContent = `${file.name} · ${isFinite(v.duration) ? v.duration.toFixed(1) + "s" : "loaded"}`;
    st.classList.add("ok");
    refreshReadiness();
  }

  const presetsEl = $("presets");
  for (const p of PRESETS) {
    const b = document.createElement("button");
    b.className = "preset";
    b.dataset.preset = p.id;
    b.innerHTML = `<strong>${p.name}</strong><span>${p.description}</span>`;
    b.addEventListener("click", () => {
      setPreset(episode, p.id);
      [...presetsEl.children].forEach((c) => c.classList.toggle("sel", c.dataset.preset === p.id));
      refreshReadiness();
    });
    presetsEl.appendChild(b);
  }

  function refreshReadiness() {
    const ready = canCompose(episode);
    $("compose").disabled = !ready;
    $("readiness").textContent = ready
      ? `Ready: ${assignedBuckets(episode).length} speakers, “${episode.presetId}” style.`
      : readinessReason(episode) || "";
  }

  function composePreview() {
    if (!canCompose(episode)) return;
    plan = buildExportPlan(episode, { resolution: $("resolution").value, fps: 30 });
    stage.width = plan.width;
    stage.height = plan.height;
    $("canvasEmpty").hidden = true;
    setStep(3);
    drawOnce();
    $("play").disabled = false;
    $("export").disabled = false;
  }

  function drawOnce() { if (plan) drawComposite(ctx, plan, videos, { title: episode.title }); }

  $("compose").addEventListener("click", composePreview);
  $("resolution").addEventListener("change", () => { if (plan) composePreview(); });

  $("play").addEventListener("click", async () => {
    if (!plan) return;
    cancelAnimationFrame(previewRAF);
    for (const b of plan.audioBuckets) {
      const v = videos[b];
      if (!v) continue;
      v.muted = true;
      try { v.currentTime = 0; await v.play(); } catch (e) {}
    }
    const loop = () => {
      drawComposite(ctx, plan, videos, { title: episode.title });
      if (plan.audioBuckets.some((b) => videos[b] && !videos[b].ended)) previewRAF = requestAnimationFrame(loop);
    };
    previewRAF = requestAnimationFrame(loop);
  });

  $("export").addEventListener("click", async () => {
    if (!plan) return;
    cancelAnimationFrame(previewRAF);
    const btn = $("export");
    btn.disabled = true;
    episode.title = $("title").value || episode.title;
    $("progress").hidden = false;
    $("result").hidden = true;
    try {
      const out = await exportEpisode(stage, plan, videos, {
        title: episode.title,
        maxSeconds: plan.durationSec,
        onProgress: (p) => ($("bar").style.width = Math.round(p * 100) + "%"),
      });
      const fname = (episode.title || "episode").replace(/[^\w.-]+/g, "_") + ".webm";
      downloadBlob(out.url, fname);
      $("result").hidden = false;
      $("result").innerHTML =
        `Exported <strong>${fname}</strong> — ${(out.bytes / 1024).toFixed(0)} KB, ${plan.width}×${plan.height}, ~${plan.durationSec}s. ` +
        `<a href="${out.url}" download="${fname}">Download again</a>`;
      window.__exportResult = { bytes: out.bytes, mimeType: out.mimeType, url: out.url, fname };
    } catch (err) {
      $("result").hidden = false;
      $("result").textContent = "Export failed: " + (err && err.message);
    } finally {
      btn.disabled = false;
    }
  });

  function setStep(n) {
    document.querySelectorAll(".step").forEach((s) => s.classList.toggle("is-active", Number(s.dataset.step) <= n));
  }
  $("title").addEventListener("input", (e) => {
    episode.title = e.target.value || "Episode";
    if (plan) drawOnce();
  });

  refreshReadiness();
  window.__pdc = { episode, videos, get plan() { return plan; }, composePreview, drawOnce };
})();
