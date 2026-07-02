// scripts/verify-broll.mjs
// Drives the shipped app in headless Chrome and proves the b-roll image
// overlay workflow end to end: upload two generated speaker WebM videos
// (solid red host / solid green guest, ~8s, with audio) through the normal
// Host and Guest controls, choose Split, then add a B-ROLL IMAGE moment
// (0:01-0:04) through the real moments UI — selecting the "B-roll image"
// type and uploading a generated solid-amber PNG through the real file
// input (no seeded/committed media). It then verifies, by sampling canvas
// pixels in the region where the overlay renders, that during playback and
// while scrubbing the PNG appears ONLY inside 1-4s and is absent before and
// after; that switching to Stack keeps the same moment rendering over the
// recomposed preview; and finally that the real Export action produces a
// playable video in which the overlay is BURNED INTO the frames: the
// exported file is loaded back into a <video>, seeked before/during/after
// the scheduled range, and each decoded frame is region-sampled for the
// amber overlay color. All pixel assertions are region-based and tolerant of
// encoder loss, and every wait polls a natural condition. Mirrors the CDP
// harness used by the other rendered checks (see verify-visual-moments.mjs).
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
  throw new Error("Chrome/Chromium was not found. Set CHROME_BIN to run b-roll verification.");
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
  const waitFor = async (fn, label, tries) => {
    for (let i = 0; i < (tries || 200); i++) { if (fn()) return; await sleep(50); }
    throw new Error(label);
  };

  // ~8.2s solid-color speaker video (uniform frames, no baked-in text) with an
  // audio tone — same generator used by the other rendered checks.
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
    for (let i = 0; i < 82; i++) { ctx.fillStyle = color; ctx.fillRect(0, 0, 320, 180); await sleep(100); }
    await new Promise((r) => { rec.onstop = r; rec.stop(); });
    osc.stop(); ac.close(); stream.getTracks().forEach((t) => t.stop());
    return new File(chunks, name, { type: "video/webm" });
  }

  // A maintainer-owned PNG generated in-browser: solid amber, sized to the
  // same aspect ratio as the overlay's contain-fit box (84% x 54% of a
  // 1280x720 stage) so it fills the box with no letterboxing, keeping the
  // sampled interior unambiguous.
  async function makePng(name, color, width, height) {
    const canvas = document.createElement("canvas");
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, width, height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    return new File([blob], name, { type: "image/png" });
  }

  const uploadTo = (input, file) => { const dt = new DataTransfer(); dt.items.add(file); input.files = dt.files; input.dispatchEvent(new Event("change", { bubbles: true })); };
  const typeInto = (input, v) => { input.value = v; input.dispatchEvent(new Event("input", { bubbles: true })); };

  // Region sampling: the b-roll image renders as a contain-fit card centered
  // in the middle band of the stage. "Present" = mostly amber pixels;
  // "absent" = plain composited speaker video (solid red/green, never amber).
  const IMAGE_REGION = { x0: 15, y0: 24, x1: 85, y1: 68 };
  function amberFraction(canvas, region) {
    const w = canvas.width, h = canvas.height;
    const x0 = Math.floor(region.x0 / 100 * w), x1 = Math.floor(region.x1 / 100 * w);
    const y0 = Math.floor(region.y0 / 100 * h), y1 = Math.floor(region.y1 / 100 * h);
    const data = canvas.getContext("2d").getImageData(x0, y0, x1 - x0, y1 - y0).data;
    let amber = 0;
    const n = data.length / 4;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (r > 200 && g > 100 && g < 200 && b < 100) amber++;
    }
    return amber / n;
  }
  function frameBrightness(canvas) {
    const w = canvas.width, h = canvas.height;
    const data = canvas.getContext("2d").getImageData(0, 0, w, h).data;
    let bright = 0;
    const n = data.length / 4;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > 110 || data[i + 1] > 110 || data[i + 2] > 110) bright++;
    }
    return bright / n;
  }
  const stage = () => document.querySelector("#stage-canvas");
  const imageShown = () => amberFraction(stage(), IMAGE_REGION) > 0.5;
  const imageAbsent = () => amberFraction(stage(), IMAGE_REGION) < 0.05;

  await waitFor(() => window.PDC && window.PDC.moments && document.querySelector('[data-file-bucket="host"]')
    && document.querySelector("#moment-add") && document.querySelector("#moment-image") && document.querySelector("#export") && document.querySelector("#scrub"),
    "shipped moment/image/scrub/export controls should exist");

  // Model semantics: an image moment schedules and clears exactly like the
  // existing types, [start, end) — start inclusive, end exclusive.
  {
    const scratch = window.PDC.episode.createEpisode({});
    const added = window.PDC.moments.addMoment(scratch, {
      type: "image",
      image: { name: "broll.png", type: "image/png" },
      start: "0:01",
      end: "0:04",
    });
    assert(added && added.imageName === "broll.png", "image moment should store the uploaded file's name");
    const at = (t) => window.PDC.moments.activeMoments(scratch, t).map((m) => m.type).join(",");
    assert(at(1) === "image", "image moment should be active at exactly its start (inclusive)");
    assert(at(2.5) === "image", "image moment should be active inside 1-4s");
    assert(at(4) === "" && at(0.9) === "", "image moment should be inactive at/after its end and before its start");
  }

  // Upload two speaker videos through the normal Host and Guest controls.
  const [host, guest] = await Promise.all([
    makeVideo("host.webm", "#b91c1c", 300),
    makeVideo("guest.webm", "#10b981", 520),
  ]);
  uploadTo(document.querySelector('[data-file-bucket="host"]'), host);
  await sleep(100);
  uploadTo(document.querySelector('[data-file-bucket="guest1"]'), guest);
  await waitFor(() => document.querySelectorAll("video[data-speaker]").length === 2, "two decoder videos should exist");
  const vids = [...document.querySelectorAll("video[data-speaker]")];
  await waitFor(
    () => vids.every((v) => v.readyState >= 2 && isFinite(v.duration) && v.duration >= 7.2),
    "uploaded speakers should decode with a real duration covering the moment range", 400,
  );

  // Choose Split.
  document.querySelector('[data-preset="split"]').click();
  await waitFor(() => stage().dataset.preset === "split", "Split preset should be active");

  // Add the b-roll image moment through the real UI: pick the image type
  // (revealing the file field), upload the generated PNG, set the range.
  const broll = await makePng("broll.png", "#f5a623", 830, 300);
  const sel = document.querySelector("#moment-type");
  sel.value = "image"; sel.dispatchEvent(new Event("change", { bubbles: true }));
  assert(document.querySelector("#moment-image").hidden === false, "image file field should be revealed for the image type");
  assert(document.querySelector("#moment-text").hidden === true, "text field should be hidden for the image type");
  uploadTo(document.querySelector("#moment-image"), broll);
  typeInto(document.querySelector("#moment-start"), "0:01");
  typeInto(document.querySelector("#moment-end"), "0:04");
  document.querySelector("#moment-add").click();
  await waitFor(() => document.querySelectorAll("#moment-list li").length === 1, "b-roll moment should appear in the list");
  const listText = document.querySelector("#moment-list").textContent;
  assert(listText.includes("broll.png") && listText.includes("0:01") && listText.includes("0:04"), "list should show the b-roll moment with its file name and range");
  const err = document.querySelector("#moment-error");
  assert(err.hidden || !err.textContent.trim(), "no validation error should be shown for a valid b-roll moment");

  // PLAYBACK: restart from 0 and watch the schedule unfold on the live canvas.
  document.querySelector("#restart").click();
  await waitFor(() => imageAbsent(), "b-roll should be absent before 0:01", 60);
  await waitFor(() => imageShown(), "b-roll should appear during playback inside 1-4s (Split)", 150);
  await waitFor(() => imageAbsent(), "b-roll should disappear once playback passes 0:04", 200);

  // SCRUB: pause, then sample exact times through the real scrub control.
  function pausePreview() {
    const btn = document.querySelector("#play");
    if (btn.textContent.indexOf("Pause") !== -1) btn.click();
  }
  const scrub = document.querySelector("#scrub");
  async function scrubTo(t) {
    await waitFor(() => !scrub.disabled && Number(scrub.max) >= 4, "scrub bar should span the episode", 100);
    scrub.value = String(t);
    scrub.dispatchEvent(new Event("input", { bubbles: true }));
  }
  pausePreview();
  await scrubTo(0.5);
  await waitFor(() => imageAbsent(), "scrubbed to 0.5s: b-roll absent (Split)");
  await scrubTo(2.5);
  await waitFor(() => imageShown(), "scrubbed to 2.5s: b-roll shown (Split)");
  const splitStats = amberFraction(stage(), IMAGE_REGION);
  await scrubTo(4.5);
  await waitFor(() => imageAbsent(), "scrubbed to 4.5s: b-roll absent (Split)");

  // PRESET SWITCH: the moment must stay attached to the episode and render
  // over the recomposed Stack layout.
  document.querySelector('[data-preset="stack"]').click();
  await waitFor(() => stage().dataset.preset === "stack", "Stack preset should apply");
  assert(document.querySelectorAll("#moment-list li").length === 1, "b-roll moment should survive switching to Stack");
  await scrubTo(2.5);
  await waitFor(() => imageShown(), "Stack: b-roll should render over the recomposed layout at 2.5s");
  const stackStats = amberFraction(stage(), IMAGE_REGION);
  await scrubTo(4.5);
  await waitFor(() => imageAbsent(), "Stack: b-roll absent at 4.5s");

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

  // Load the exported file back into a <video>, resolve its real duration,
  // then seek before/during/after the scheduled range and sample the
  // decoded frames for the burned-in amber overlay.
  const v = document.createElement("video");
  v.muted = true; v.src = URL.createObjectURL(blob);
  await new Promise((r) => { v.onloadedmetadata = r; v.onerror = r; setTimeout(r, 5000); });
  assert(v.videoWidth > 0 && v.videoHeight > 0, "exported file should be a playable video with real dimensions");
  if (!isFinite(v.duration)) {
    v.currentTime = 1e7;
    await waitFor(() => isFinite(v.duration), "exported duration should resolve", 200);
  }
  assert(v.duration >= 6, "export should cover the moment range, duration=" + v.duration);

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
    await new Promise((resolve) => {
      let done = false;
      const fin = () => { if (done) return; done = true; resolve(); };
      if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(fin);
      setTimeout(fin, 300);
    });
    probe.getContext("2d").drawImage(v, 0, 0, probe.width, probe.height);
    return { t, amber: amberFraction(probe, IMAGE_REGION), bright: frameBrightness(probe) };
  }
  const before = await seekAndSample(0.5);
  const during = await seekAndSample(2.5);
  const after = await seekAndSample(5);
  assert(before.bright > 0.2, "exported frame at 0.5s should be nonblank");
  assert(before.amber < 0.1, "no b-roll overlay should be burned in before 0:01: " + JSON.stringify(before));
  assert(during.bright > 0.2, "exported frame at 2.5s should be nonblank");
  assert(during.amber > 0.4, "b-roll overlay should be burned into the exported frame at 2.5s: " + JSON.stringify(during));
  assert(after.bright > 0.2, "exported frame at 5s should be nonblank");
  assert(after.amber < 0.1, "no b-roll overlay should be burned in after 0:04: " + JSON.stringify(after));

  return {
    momentsListed: document.querySelectorAll("#moment-list li").length,
    preview: { splitAmberAt2_5: splitStats, stackAmberAt2_5: stackStats },
    exportBytes: blob.size,
    exportDuration: Number(v.duration.toFixed(2)),
    exportSamples: { before, during, after },
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
    // 120s budget: one in-browser media generation, playback + scrub +
    // preset-switch sampling, one full-length export, and three decode-seeks.
    const result = await send("Runtime.evaluate", { expression: browserExpression, awaitPromise: true, returnByValue: true, timeout: 120000 });
    ws.close();
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    console.log("verify-broll: OK — timed b-roll PNG overlay renders only in range in preview and is burned into the export");
    console.log(JSON.stringify(result.result.value, null, 2));
  } finally {
    await stopChrome(child);
    await removeDirEventually(profileDir);
  }
}

main().catch((e) => { console.error(`verify-broll: ${e.message}`); process.exit(1); });
