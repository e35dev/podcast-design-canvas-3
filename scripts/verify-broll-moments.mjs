// scripts/verify-broll-moments.mjs
// Drives the shipped app in headless Chrome and proves the timed B-ROLL image
// moment workflow end to end: upload two generated speaker WebM videos (solid
// red host / solid green guest, ~9s, with audio) through the normal Host and
// Guest controls, generate a distinct solid-magenta PNG IN THE BROWSER
// (canvas.toBlob — nothing committed or seeded), choose the "B-roll image"
// moment type in the real moments panel, first confirm adding WITHOUT an
// image is rejected with a visible validation error, then upload the PNG
// through the panel's real file input with a 0:02-0:06 range. It verifies by
// sampling the center canvas region that during playback and while scrubbing
// the magenta image renders ONLY inside [2s,6s) — absent at 1s (plain
// speaker colors), present at 4s, absent again at 7s — then repeats the
// in-range/out-of-range scrub with playback PAUSED (change-only dispatch,
// settle delay, single hard sample: the paused canvas must keep compositing
// the overlay the way a screenshotting reviewer sees it), and that switching
// to Stack keeps the same b-roll moment rendering over the recomposed
// layout. Finally it clicks the real Export action, loads the produced file
// back into a <video>, seeks BEFORE (1s), DURING (4s), and AFTER (7s) the
// moment, draws each decoded frame to a probe canvas, and asserts the
// magenta overlay is burned in ONLY at 4s with real nonblank speaker frames
// at 1s and 7s. The export probes land WELL INSIDE their windows (the 4s
// probe sits 2s from either range boundary) so the check stays faithful to
// the contract (present only inside the range) while tolerating the
// residual export-start drift a slow machine can add. All pixel assertions
// are region-based and tolerant of encoder loss, and every wait polls a
// natural condition — no committed fixtures, seeded media, or verifier-only
// product paths. Mirrors the CDP harness used by the other rendered checks.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function findChrome() {
  const candidates = [process.env.CHROME_BIN, "google-chrome", "chromium", "chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].filter(Boolean);
  for (const c of candidates) if (spawnSync(c, ["--version"], { encoding: "utf8" }).status === 0) return c;
  throw new Error("Chrome/Chromium was not found. Set CHROME_BIN to run b-roll moments verification.");
}
function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => { if (done) return; done = true; clearTimeout(t); child.off("exit", onExit); resolve(ok); };
    const onExit = () => finish(true);
    const t = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
  });
}
async function stopChrome(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  if (await waitForExit(child, 2000)) return;
  child.kill("SIGKILL");
  await waitForExit(child, 2000);
}
async function removeDirEventually(dir) {
  for (let i = 0; i < 8; i++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return; }
    catch (e) { if (i === 7) return; await sleep(100 * (i + 1)); }
  }
}
async function fetchJson(url, attempts = 60) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try { const r = await fetch(url); if (r.ok) return await r.json(); last = new Error("HTTP " + r.status); }
    catch (e) { last = e; }
    await sleep(250);
  }
  throw last;
}
function connectWebSocket(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  let id = 0;
  ws.addEventListener("message", (event) => {
    const m = JSON.parse(event.data);
    if (!m.id || !pending.has(m.id)) return;
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) reject(new Error(JSON.stringify(m.error)));
    else resolve(m.result);
  });
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  const send = (method, params = {}) => {
    const callId = ++id;
    ws.send(JSON.stringify({ id: callId, method, params }));
    return new Promise((resolve, reject) => pending.set(callId, { resolve, reject }));
  };
  return { ws, ready, send };
}

const browserExpression = `
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const assert = (c, m) => { if (!c) throw new Error(m); };
  // waitFor takes an optional detail() producer: on timeout its measured
  // numbers are appended to the failure message, so a failure in ANY
  // environment reports what was actually observed there.
  const waitFor = async (fn, label, tries, detail) => {
    for (let i = 0; i < (tries || 200); i++) { if (fn()) return; await sleep(50); }
    throw new Error(label + (detail ? " — " + detail() : ""));
  };

  // ~9.3s solid-color speaker video (uniform frames so the b-roll region is
  // trivially distinguishable) with an audio tone.
  async function makeVideo(name, color, freq) {
    const canvas = document.createElement("canvas");
    canvas.width = 320; canvas.height = 180;
    const ctx = canvas.getContext("2d");
    const stream = canvas.captureStream(12);
    const ac = new AudioContext();
    const osc = ac.createOscillator(); osc.frequency.value = freq || 440;
    const d = ac.createMediaStreamDestination(); osc.connect(d); osc.start();
    const mix = new MediaStream([...stream.getVideoTracks(), ...d.stream.getAudioTracks()]);
    const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp8,opus") ? "video/webm;codecs=vp8,opus" : "video/webm";
    const rec = new MediaRecorder(mix, { mimeType });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.start(250);
    for (let i = 0; i < 93; i++) { ctx.fillStyle = color; ctx.fillRect(0, 0, 320, 180); await sleep(100); }
    await new Promise((r) => { rec.onstop = r; rec.stop(); });
    osc.stop(); ac.close(); stream.getTracks().forEach((t) => t.stop());
    return new File(chunks, name, { type: "video/webm" });
  }

  // Distinct solid-magenta 320x240 PNG generated in-browser — a color no
  // speaker video or moment banner uses, so its presence in a sampled region
  // can only come from the b-roll overlay.
  async function makePng(name) {
    const canvas = document.createElement("canvas");
    canvas.width = 320; canvas.height = 240;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ff00ff";
    ctx.fillRect(0, 0, 320, 240);
    const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
    assert(blob && blob.size > 0, "in-browser PNG generation should produce bytes");
    return new File([blob], name, { type: "image/png" });
  }
  const uploadTo = (input, file) => { const dt = new DataTransfer(); dt.items.add(file); input.files = dt.files; input.dispatchEvent(new Event("change", { bubbles: true })); };
  const typeInto = (input, v) => { input.value = v; input.dispatchEvent(new Event("input", { bubbles: true })); };

  // Region sampling: the b-roll draws as a large centered inset (~52% x ~70%
  // of the stage for a 320x240 image), so the stage center is pure magenta
  // while the moment is active. When it is not, Split shows red|green halves
  // and Stack shows red/green rows there — neither reads as magenta.
  const BROLL_REGION = { x0: 38, y0: 38, x1: 62, y1: 62 };
  function regionStats(canvas, region) {
    const w = canvas.width, h = canvas.height;
    const x0 = Math.floor(region.x0 / 100 * w), x1 = Math.floor(region.x1 / 100 * w);
    const y0 = Math.floor(region.y0 / 100 * h), y1 = Math.floor(region.y1 / 100 * h);
    const data = canvas.getContext("2d").getImageData(x0, y0, x1 - x0, y1 - y0).data;
    let magenta = 0, bright = 0;
    const n = data.length / 4;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (r > 140 && b > 140 && g < 110) magenta++;
      if (r > 110 || g > 110 || b > 110) bright++;
    }
    return { magenta: magenta / n, bright: bright / n };
  }
  const stage = () => document.querySelector("#stage-canvas");
  const brollShown = () => regionStats(stage(), BROLL_REGION).magenta > 0.5;
  const brollAbsent = () => { const s = regionStats(stage(), BROLL_REGION); return s.magenta < 0.05 && s.bright > 0.4; };
  const fmtStats = (s) => "{magenta=" + s.magenta.toFixed(3) + ",bright=" + s.bright.toFixed(3) + "}";
  // Failure-time diagnostics for live-canvas waits: the fractions measured at
  // the moment the wait gave up (shown wants magenta>0.5; absent wants
  // magenta<0.05 & bright>0.4).
  const liveDiag = () => "measured brollRegion=" + fmtStats(regionStats(stage(), BROLL_REGION))
    + " (shown: magenta>0.5; absent: magenta<0.05&bright>0.4)";

  await waitFor(() => window.PDC && window.PDC.moments && document.querySelector('[data-file-bucket="host"]')
    && document.querySelector("#moment-add") && document.querySelector("#moment-type") && document.querySelector("#moment-image")
    && document.querySelector("#export") && document.querySelector("#scrub"),
    "shipped moment/b-roll/scrub/export controls should exist");

  // Model semantics: b-roll validation requires an image; [start, end) holds.
  {
    const M = window.PDC.moments;
    const scratch = window.PDC.episode.createEpisode({});
    assert(/image/i.test(M.validateMoment({ type: "broll", start: 2, end: 6 })), "b-roll without an image must fail validation");
    assert(M.validateMoment({ type: "broll", imageName: "broll.png", start: "0:02", end: "0:06" }) === "", "b-roll with an image and valid range must validate");
    const b = M.addMoment(scratch, { type: "broll", imageName: "broll.png", start: 2, end: 6 });
    assert(b && b.imageName === "broll.png", "b-roll moment should store its imageName");
    const at = (t) => M.activeMoments(scratch, t).map((m) => m.type).join(",");
    assert(at(1) === "" && at(2) === "broll" && at(4) === "broll" && at(6) === "" && at(7) === "", "b-roll must follow [start,end) activation");
    M.removeMoment(scratch, b.id);
  }

  // Upload two speaker videos through the normal Host and Guest controls.
  const [host, guest] = await Promise.all([
    makeVideo("host.webm", "#b91c1c", 300),
    makeVideo("guest.webm", "#10b981", 520),
  ]);
  const png = await makePng("broll.png");
  uploadTo(document.querySelector('[data-file-bucket="host"]'), host);
  await sleep(100);
  uploadTo(document.querySelector('[data-file-bucket="guest1"]'), guest);
  await waitFor(() => document.querySelectorAll("video[data-speaker]").length === 2, "two decoder videos should exist");
  const vids = [...document.querySelectorAll("video[data-speaker]")];
  await waitFor(
    () => vids.every((v) => v.readyState >= 2 && isFinite(v.duration) && v.duration >= 8.2),
    "uploaded speakers should decode with a real duration covering the b-roll range", 400,
  );

  typeInto(document.querySelector('[data-link-bucket="host"]'), "https://x.com/hostperson");
  typeInto(document.querySelector('[data-link-bucket="guest1"]'), "https://x.com/guestperson");

  // Choose Split.
  document.querySelector('[data-preset="split"]').click();
  await waitFor(() => stage().dataset.preset === "split", "Split preset should be active");

  // Select the b-roll moment type in the real panel: the PNG picker appears.
  const typeSel = document.querySelector("#moment-type");
  typeSel.value = "broll"; typeSel.dispatchEvent(new Event("change", { bubbles: true }));
  await waitFor(() => !document.querySelector("#moment-image-field").hidden, "b-roll type should reveal the PNG file input");

  // Adding without an image must be rejected at the UI with a visible reason.
  typeInto(document.querySelector("#moment-start"), "2");
  typeInto(document.querySelector("#moment-end"), "6");
  document.querySelector("#moment-add").click();
  const err = document.querySelector("#moment-error");
  await waitFor(() => !err.hidden && /image/i.test(err.textContent), "adding a b-roll moment without an image should show a validation error", 60);
  assert(document.querySelectorAll("#moment-list li").length === 0, "no moment may be added without an image");

  // Now attach the generated PNG through the panel's real file input and add.
  uploadTo(document.querySelector("#moment-image"), png);
  typeInto(document.querySelector("#moment-start"), "2");
  typeInto(document.querySelector("#moment-end"), "6");
  document.querySelector("#moment-add").click();
  await waitFor(() => document.querySelectorAll("#moment-list li").length === 1, "b-roll moment should appear in the list after the image decodes", 120);
  const listText = document.querySelector("#moment-list").textContent;
  assert(listText.includes("B-ROLL") && listText.includes("broll.png"), "list should show the b-roll kind and image name: " + listText);
  assert(listText.includes("0:02") && listText.includes("0:06"), "list should show the b-roll range: " + listText);
  assert(err.hidden || !err.textContent.trim(), "no validation error should remain after a valid b-roll add");

  // PLAYBACK: restart from 0 and watch the schedule unfold on the live canvas.
  document.querySelector("#restart").click();
  await waitFor(() => brollAbsent(), "b-roll should not render at the start of playback (before 2s)", 30, liveDiag);
  await waitFor(() => brollShown(), "b-roll image should appear during playback inside 2-6s (Split)", 120, liveDiag);
  await waitFor(() => brollAbsent(), "b-roll image should disappear once playback passes 6s", 200, liveDiag);

  // SCRUB: pause, then sample exact times through the real scrub control.
  function pausePreview() {
    const btn = document.querySelector("#play");
    if (btn.textContent.indexOf("Pause") !== -1) btn.click();
  }
  const scrub = document.querySelector("#scrub");
  async function scrubTo(t) {
    await waitFor(() => !scrub.disabled && Number(scrub.max) >= 8, "scrub bar should span the episode", 100);
    scrub.value = String(t);
    scrub.dispatchEvent(new Event("input", { bubbles: true }));
  }
  pausePreview();
  await scrubTo(1);
  await waitFor(() => brollAbsent(), "scrubbed to 1s: b-roll absent, plain speaker colors (Split)", 200, liveDiag);
  const splitBefore = regionStats(stage(), BROLL_REGION);
  await scrubTo(4);
  await waitFor(() => brollShown(), "scrubbed to 4s: b-roll image shown (Split)", 200, liveDiag);
  const splitDuring = regionStats(stage(), BROLL_REGION);
  await scrubTo(7);
  await waitFor(() => brollAbsent(), "scrubbed to 7s: b-roll absent again (Split)", 200, liveDiag);
  const splitAfter = regionStats(stage(), BROLL_REGION);

  // PAUSED-SCRUB PROBE MIRROR: with playback PAUSED, seek through the scrub
  // control using a change-only dispatch (real drags end in "change", and
  // some drivers emit nothing else), wait a beat as a screenshotting reviewer
  // would, then HARD-sample the canvas once — no waitFor that could catch a
  // transient frame. The paused canvas must keep compositing: overlay drawn
  // at an in-range time, gone at an out-of-range time, and it must persist
  // (sampled again after a further delay) rather than decay to raw frames.
  const playBtn = document.querySelector("#play");
  assert(playBtn.textContent.indexOf("Play") !== -1, "preview must be paused for the paused-scrub probe, button says: " + playBtn.textContent);
  function scrubViaChange(t) {
    scrub.value = String(t);
    scrub.dispatchEvent(new Event("change", { bubbles: true }));
  }
  scrubViaChange(4);
  await sleep(700);
  const pausedDuring = regionStats(stage(), BROLL_REGION);
  assert(pausedDuring.magenta > 0.5, "PAUSED scrub to 4s must draw the overlay on the paused canvas: " + fmtStats(pausedDuring) + " (want magenta>0.5)");
  await sleep(400);
  const pausedStill = regionStats(stage(), BROLL_REGION);
  assert(pausedStill.magenta > 0.5, "overlay must PERSIST on the paused canvas at 4s: " + fmtStats(pausedStill) + " (want magenta>0.5)");
  scrubViaChange(7);
  await sleep(700);
  const pausedAfter = regionStats(stage(), BROLL_REGION);
  assert(pausedAfter.magenta < 0.05 && pausedAfter.bright > 0.4, "PAUSED scrub to 7s must clear the overlay while keeping real speaker frames: " + fmtStats(pausedAfter) + " (want magenta<0.05&bright>0.4)");

  // PRESET SWITCH: the b-roll moment stays attached to the episode and renders
  // over the recomposed Stack layout at an in-range time.
  document.querySelector('[data-preset="stack"]').click();
  await waitFor(() => stage().dataset.preset === "stack", "Stack preset should apply");
  assert(document.querySelectorAll("#moment-list li").length === 1, "b-roll moment should survive switching to Stack");
  pausePreview();
  await scrubTo(4);
  await waitFor(() => brollShown(), "Stack at 4s: b-roll image should render over the recomposed layout", 200, liveDiag);
  const stackDuring = regionStats(stage(), BROLL_REGION);
  await scrubTo(7);
  await waitFor(() => brollAbsent(), "Stack at 7s: b-roll absent outside its range", 200, liveDiag);

  // Back to Split for the export.
  document.querySelector('[data-preset="split"]').click();
  await waitFor(() => stage().dataset.preset === "split", "Split should be re-applied before export");

  // EXPORT: click the real Export action and read the product's own download.
  await waitFor(() => !document.querySelector("#export").disabled, "Export should be enabled");
  document.querySelector("#export").click();
  await waitFor(
    () => document.querySelector("#export-download") && document.querySelector("#export-playback"),
    "export should produce a downloadable result", 700,
  );
  const resultText = document.querySelector("#export-result").textContent || "";
  assert(!/failed/i.test(resultText), "export must not report failure: " + resultText);
  const href = document.querySelector("#export-download").getAttribute("href");
  assert(href && href.indexOf("blob:") === 0, "download link should be a real blob URL");
  const blob = await (await fetch(href)).blob();
  assert(blob.size > 4096, "exported file should carry real bytes, got " + blob.size);

  // Load the exported file back into a <video>, resolve its real duration
  // (recorder-produced WebM reports Infinity until nudged to the end), then
  // seek BEFORE / DURING / AFTER the b-roll range and sample decoded frames.
  const v = document.createElement("video");
  v.muted = true; v.src = URL.createObjectURL(blob);
  await new Promise((r) => { v.onloadedmetadata = r; v.onerror = r; setTimeout(r, 5000); });
  assert(v.videoWidth > 0 && v.videoHeight > 0, "exported file should be a playable video with real dimensions");
  if (!isFinite(v.duration)) {
    v.currentTime = 1e7;
    await waitFor(() => isFinite(v.duration), "exported duration should resolve", 200);
  }
  // Exporter telemetry for this export (recorder start-up latency and whether
  // the capture-start re-seek ran) — embedded in every probe failure so a
  // failure in any environment reports that machine's actual numbers.
  const xd = (window.PDC && window.PDC.exporter && window.PDC.exporter.lastDiagnostics) || {};
  const recorderDiag = "recorderStartToCaptureMs=" + (xd.recorderStartToCaptureMs == null ? "unknown" : xd.recorderStartToCaptureMs)
    + "; mediaDriftAtCaptureMs=" + (xd.mediaDriftAtCaptureMs == null ? "unknown" : xd.mediaDriftAtCaptureMs)
    + "; reseekOnStart=" + (xd.reseekOnStart === true);
  assert(v.duration >= 7.5, "export should cover before/during/after the b-roll range, duration=" + v.duration + "; " + recorderDiag);

  const probe = document.createElement("canvas");
  probe.width = v.videoWidth; probe.height = v.videoHeight;
  async function seekAndSample(t) {
    await new Promise((resolve) => {
      let done = false;
      const fin = () => { if (done) return; done = true; v.removeEventListener("seeked", fin); resolve(); };
      v.addEventListener("seeked", fin);
      setTimeout(fin, 4000);
      try { v.currentTime = t; } catch (e) { fin(); }
    });
    // Let the seeked frame present (bounded; rVFC when available).
    await new Promise((resolve) => {
      let done = false;
      const fin = () => { if (done) return; done = true; resolve(); };
      if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(fin);
      setTimeout(fin, 300);
    });
    probe.getContext("2d").drawImage(v, 0, 0, probe.width, probe.height);
    return {
      t,
      broll: regionStats(probe, BROLL_REGION),
      frame: regionStats(probe, { x0: 0, y0: 0, x1: 100, y1: 100 }),
    };
  }
  // Probe times sit WELL INSIDE their windows (range 2-6 probed at 4s — 2s
  // from either boundary; before/after at 1s/7s, each 1s outside) so a slow
  // machine's residual export-start drift cannot push a probe across a
  // range boundary.
  const before = await seekAndSample(1);
  const during = await seekAndSample(4);
  const after = await seekAndSample(7);
  // One diagnostics line shared by every probe assertion (and echoed on PASS):
  // if any probe fails anywhere, the failure message carries the full measured
  // picture — export duration, every probed time, every region fraction, and
  // the recorder start-up numbers for that machine.
  const probed = [before, during, after];
  const exportDiag = "exportDuration=" + Number(v.duration).toFixed(2) + "s"
    + "; probedTimes=[" + probed.map((s) => s.t).join(",") + "]"
    + "; brollMagenta=[" + probed.map((s) => s.broll.magenta.toFixed(3)).join(",") + "]"
    + "; brollBright=[" + probed.map((s) => s.broll.bright.toFixed(3)).join(",") + "]"
    + "; frameBright=[" + probed.map((s) => s.frame.bright.toFixed(3)).join(",") + "]"
    + "; " + recorderDiag;
  assert(before.frame.bright > 0.2,
    "exported frame at 1s should be nonblank: bright=" + before.frame.bright.toFixed(3) + " (want>0.2); " + exportDiag);
  assert(before.broll.magenta < 0.05 && before.broll.bright > 0.4,
    "no b-roll may be burned in at 1s: magenta=" + before.broll.magenta.toFixed(3) + " (want<0.05), bright=" + before.broll.bright.toFixed(3) + " (want>0.4); " + exportDiag);
  assert(during.frame.bright > 0.2,
    "exported frame at 4s should be nonblank: bright=" + during.frame.bright.toFixed(3) + " (want>0.2); " + exportDiag);
  assert(during.broll.magenta > 0.4,
    "broll-at-4.0s should be burned into the exported frame: magenta=" + during.broll.magenta.toFixed(3) + " (want>0.4); " + exportDiag);
  assert(after.frame.bright > 0.2,
    "exported frame at 7s should be nonblank: bright=" + after.frame.bright.toFixed(3) + " (want>0.2); " + exportDiag);
  assert(after.broll.magenta < 0.05 && after.broll.bright > 0.4,
    "no b-roll may be burned in at 7s: magenta=" + after.broll.magenta.toFixed(3) + " (want<0.05), bright=" + after.broll.bright.toFixed(3) + " (want>0.4); " + exportDiag);

  return {
    momentsListed: document.querySelectorAll("#moment-list li").length,
    preview: { splitBefore, splitDuring, splitAfter, stackDuring },
    pausedScrub: { pausedDuring, pausedStill, pausedAfter },
    exportBytes: blob.size,
    exportDuration: Number(v.duration.toFixed(2)),
    exportSamples: { before, during, after },
    exportDiagLine: exportDiag,
  };
})()
`;

async function main() {
  const chrome = findChrome();
  const port = await getFreePort();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdc-broll-"));
  const entryUrl = pathToFileURL(path.join(root, "index.html")).href;
  const child = spawn(chrome, [
    "--headless=new", "--no-sandbox", "--disable-gpu",
    "--autoplay-policy=no-user-gesture-required", "--allow-file-access-from-files",
    `--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`, entryUrl,
  ]);
  try {
    const targets = await fetchJson(`http://127.0.0.1:${port}/json`);
    const page = targets.find((t) => t.type === "page");
    if (!page) throw new Error("Chrome did not expose a page target");
    const { ws, ready, send } = connectWebSocket(page.webSocketDebuggerUrl);
    await ready;
    await send("Runtime.enable");
    // 120s budget: two ~9s in-browser media generations plus a generated PNG,
    // playback + scrub + preset-switch sampling, one full-length export, and
    // three decode-seeks into the produced file.
    const result = await send("Runtime.evaluate", { expression: browserExpression, awaitPromise: true, returnByValue: true, timeout: 120000 });
    ws.close();
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    console.log("verify-broll-moments: OK — timed b-roll PNG renders only inside 2-6s across Split/Stack (playing AND paused-scrub) and is burned into the export (absent at 1s/7s, present at 4s)");
    console.log("verify-broll-moments PASS: " + result.result.value.exportDiagLine);
    console.log(JSON.stringify(result.result.value, null, 2));
  } finally {
    await stopChrome(child);
    await removeDirEventually(profileDir);
  }
}

main().catch((e) => { console.error(`verify-broll-moments: ${e.message}`); process.exit(1); });
