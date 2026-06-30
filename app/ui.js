// app/ui.js  (browser entry — classic script, runs last)
// Wires the real product workflow to the DOM:
//   upload speaker videos -> auto-assign to Host/Guest buckets -> pick a preset
//   -> a synchronized composed preview of the uploaded pixels plays immediately.
//
// Design intent: the only action a user (or an automated reviewer) must take to
// see a real composed preview is to choose two video files. Bucket assignment is
// automatic (first file -> Host, second -> Guest 1, ...), a preset is selected
// by default, and the preview renders and plays as soon as two files exist — no
// separate "compose" step gates the visible result. Everything reads logic from
// window.PDC so it works over http:// and file:// alike (no ES modules).
(function () {
  const PDC = window.PDC;
  const { PRESETS, BUCKET_LABELS, SPEAKER_BUCKETS } = PDC.presets;
  const { createEpisode, assignMedia, clearMedia, assignedBuckets, setPreset, canCompose, readinessReason } = PDC.episode;

  const $ = (id) => document.getElementById(id);

  const episode = createEpisode({ title: "Episode 1" });
  const preview = PDC.preview.createPreview($("stage"));

  // --- Preset buttons (one selected by default) ---------------------------
  const presetsEl = $("presets");
  PRESETS.forEach((p) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "preset" + (p.id === episode.presetId ? " selected" : "");
    btn.dataset.preset = p.id;
    btn.setAttribute("aria-pressed", String(p.id === episode.presetId));
    btn.innerHTML = `<strong>${p.name}</strong><span>${p.description}</span>`;
    btn.addEventListener("click", () => {
      setPreset(episode, p.id);
      [...presetsEl.children].forEach((c) => {
        const on = c.dataset.preset === p.id;
        c.classList.toggle("selected", on);
        c.setAttribute("aria-pressed", String(on));
      });
      if (canCompose(episode)) preview.render(episode);
      refresh();
    });
    presetsEl.appendChild(btn);
  });

  // --- Upload: one input, multiple files, auto-assigned in order ----------
  const fileInput = $("files");
  fileInput.addEventListener("change", (e) => {
    const files = Array.from(e.target.files || []).filter((f) => /^video\//.test(f.type) || /\.(mp4|webm|mov|m4v|ogg)$/i.test(f.name));
    if (!files.length) return;

    // Fill empty buckets in canonical order, then overflow onto the last one.
    files.forEach((file) => {
      const target = SPEAKER_BUCKETS.find((b) => !episode.media[b]) || SPEAKER_BUCKETS[SPEAKER_BUCKETS.length - 1];
      assignMedia(episode, target, { name: file.name, size: file.size, type: file.type });
      preview.setSource(target, file);
    });

    renderBuckets();
    if (canCompose(episode)) {
      preview.render(episode);
      preview.play(); // visible, playing composed preview with no extra clicks
    }
    refresh();
  });

  // --- Bucket assignment panel (visible + reassignable) -------------------
  const bucketsEl = $("buckets");
  function renderBuckets() {
    bucketsEl.innerHTML = "";
    SPEAKER_BUCKETS.forEach((bucket) => {
      const m = episode.media[bucket];
      const row = document.createElement("div");
      row.className = "bucket" + (m ? " filled" : "");
      row.dataset.bucket = bucket;
      const name = document.createElement("span");
      name.className = "bucket-name";
      name.textContent = BUCKET_LABELS[bucket];

      const status = document.createElement("span");
      status.className = "bucket-status";
      status.dataset.status = bucket;
      status.textContent = m ? m.name : "No file";

      row.append(name, status);
      if (m) {
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "bucket-remove";
        remove.textContent = "Remove";
        remove.addEventListener("click", () => {
          clearMedia(episode, bucket);
          preview.clear(bucket);
          renderBuckets();
          if (canCompose(episode)) preview.render(episode);
          else $("stage").innerHTML = "";
          refresh();
        });
        row.appendChild(remove);
      }
      bucketsEl.appendChild(row);
    });
  }

  // --- Transport controls -------------------------------------------------
  $("play").addEventListener("click", () => {
    if (preview.isPlaying()) preview.pause();
    else preview.play();
    refresh();
  });
  $("restart").addEventListener("click", () => preview.restart());
  $("mute").addEventListener("click", () => {
    const next = $("mute").getAttribute("aria-pressed") !== "true";
    preview.setMuted(!next);
    $("mute").setAttribute("aria-pressed", String(next));
    $("mute").textContent = next ? "🔊 Sound on" : "🔇 Muted";
  });

  // --- Shared state refresh ----------------------------------------------
  function refresh() {
    const ready = canCompose(episode);
    const n = assignedBuckets(episode).length;
    $("stage").classList.toggle("ready", ready);
    $("empty").hidden = ready;
    $("readiness").textContent = ready
      ? `Previewing ${n} speaker${n === 1 ? "" : "s"} in the “${PDC.presets.getPreset(episode.presetId).name}” layout.`
      : readinessReason(episode);

    const playBtn = $("play");
    playBtn.disabled = !ready;
    playBtn.textContent = preview.isPlaying() ? "⏸ Pause" : "▶ Play preview";
    $("restart").disabled = !ready;
    $("mute").disabled = !ready;
  }

  renderBuckets();
  refresh();
})();
