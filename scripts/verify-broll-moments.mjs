// scripts/verify-broll-moments.mjs
// Drives the shipped app in headless Chrome and proves the b-roll image
// overlay workflow end to end (issue #130): upload two generated speaker
// WebM videos (solid red host / solid green guest, ~8s, with audio) through
// the normal Host and Guest controls, choose Split, then add a B-ROLL IMAGE
// moment (0:02-0:05) through the real moments UI — generating a distinct
// magenta PNG in-browser and attaching it through the real file input. An
// imageless "B-roll image" add is first confirmed to be rejected with a
// visible error, and picking a file before selecting the type is confirmed
// to auto-switch the type to "B-roll image" (both from lessons of prior
// attempts at this issue). It then verifies, by sampling canvas pixels
// during playback and while scrubbing, that the overlay renders ONLY inside
// 2-5s (absent before and after); that switching to Stack and Spotlight
// keeps the same moment rendering over the recomposed preview; and finally
// that the real Export action produces a playable video in which the image
// is BURNED INTO the frames: the exported file is loaded back into a
// <video>, seeked to 1s / 3.5s / 6s, and each decoded frame is sampled
// (dark backing + magenta content = present; plain bright video = absent).
// All pixel assertions are region-based and tolerant of encoder loss, and
// every wait polls a natural condition — no committed fixtures, seeded
// media, or verifier-only product paths. Mirrors the CDP harness used by the
// other rendered checks (see scripts/verify-visual-moments.mjs).
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
  throw new Error("Chrome/Chromium was not found. Set CHROME_BIN to run b-roll-moments verification.");
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

  // ~8.2s solid-color speaker video (uniform frames — no baked-in text — so the
  // b-roll region is trivially distinguishable) with an audio tone.
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

  // A solid-magenta PNG generated in-browser — a color neither the red host nor
  // the green guest video ever produces, so its presence in a sampled region is
  // unambiguous evidence of the overlay (not a coincidence of the base frame).
  function makePng(name, color) {
    return new Promise((resolve) => {
      const c = document.createElement("canvas");
      c.width = 240; c.height = 135;
      const cx = c.getContext("2d");
      cx.fillStyle = color;
      cx.fillRect(0, 0, c.width, c.height);
      c.toBlob((blob) => resolve(new File([blob], name, { type: "image/png" })), "image/png");
    });
  }

  const uploadTo = (input, file) => { const dt = new DataTransfer(); dt.items.add(file); input.files = dt.files; input.dispatchEvent(new Event("change", { bubbles: true })); };
  const typeInto = (input, v) => { input.value = v; input.dispatchEvent(new Event("input", { bubbles: true })); };

  // Region sampling: the b-roll inset renders as a centered box (46% of the
  // stage) with a dark backing behind the magenta image. "Present" = mostly
  // dark backing plus a solid fraction of magenta pixels; "absent" = plain
  // bright video (the generated speakers are solid red/green, neither of
  // which is dark or magenta).
  const IMAGE_REGION = { x0: 27, y0: 27, x1: 73, y1: 73 };
  function regionStats(canvas, region) {
    const w = canvas.width, h = canvas.height;
    const x0 = Math.floor(region.x0 / 100 * w), x1 = Math.floor(region.x1 / 100 * w);
    const y0 = Math.floor(region.y0 / 100 * h), y1 = Math.floor(region.y1 / 100 * h);
    const data = canvas.getContext("2d").getImageData(x0, y0, x1 - x0, y1 - y0).data;
    let dark = 0, magenta = 0, bright = 0;
    const n = data.length / 4;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (r < 70 && g < 70 && b < 70) dark++;
      if (r > 170 && b > 170 && g < 110) magenta++;
      if (r > 110 || g > 110 || b > 110) bright++;
    }
    return { dark: dark / n, magenta: magenta / n, bright: bright / n };
  }
  // The magenta image nearly fills the inset (thin backing/border only), so
  // presence is judged mainly on the magenta fraction, not the dark fraction.
  const stage = () => document.querySelector("#stage-canvas");
  const imageShown = () => regionStats(stage(), IMAGE_REGION).magenta > 0.5;
  const imageAbsent = () => regionStats(stage(), IMAGE_REGION).magenta < 0.05;

  await waitFor(() => window.PDC && window.PDC.moments && window.PDC.momentImages && document.querySelector('[data-file-bucket="host"]')
    && document.querySelector("#moment-add") && document.querySelector("#moment-image") && document.querySelector("#export") && document.querySelector("#scrub"),
    "shipped moment/image/scrub/export controls should exist");

  // Model semantics: an image moment needs an imageName (not text), carries
  // no text, and is active on [start, end) like every other moment type.
  {
    const scratch = window.PDC.episode.createEpisode({});
    assert(/image/i.test(window.PDC.moments.validateMoment({ type: "image", start: 0, end: 3 })), "an image moment without a file should be rejected");
    const m = window.PDC.moments.addMoment(scratch, { type: "image", imageName: "x.png", start: "0:02", end: "0:05" });
    assert(m && m.imageName === "x.png" && m.text === "", "image moment should store imageName, not text");
    assert(window.PDC.moments.activeMoments(scratch, 3).map((x) => x.type).join(",") === "image", "image moment should be active inside its range");
    assert(window.PDC.moments.activeMoments(scratch, 5).length === 0, "image moment should be gone at its end (exclusive)");
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

  // An imageless "B-roll image" add must be rejected with a visible error —
  // this is the exact first-attempt failure mode a prior try at this issue hit.
  const typeSel = document.querySelector("#moment-type");
  typeSel.value = "image";
  typeSel.dispatchEvent(new Event("change", { bubbles: true }));
  typeInto(document.querySelector("#moment-start"), "2");
  typeInto(document.querySelector("#moment-end"), "5");
  document.querySelector("#moment-add").click();
  const err = document.querySelector("#moment-error");
  assert(!err.hidden && /image/i.test(err.textContent), "an imageless b-roll add should show a visible error: " + JSON.stringify(err.textContent));
  assert(document.querySelectorAll("#moment-list li").length === 0, "the rejected imageless moment must not be added");

  // Picking a file BEFORE selecting the type must auto-switch the type to
  // "image" — the other first-attempt failure mode a prior try hit.
  typeSel.value = "title";
  typeSel.dispatchEvent(new Event("change", { bubbles: true }));
  const png = await makePng("broll.png", "#ff00ff");
  uploadTo(document.querySelector("#moment-image"), png);
  await waitFor(() => document.querySelector("#moment-type").value === "image", "choosing a b-roll image should auto-switch the moment type to image");

  // Add the b-roll moment through the real UI (start/end already filled above).
  document.querySelector("#moment-add").click();
  await waitFor(() => document.querySelectorAll("#moment-list li").length === 1, "b-roll moment should appear in the list");
  const listText = document.querySelector("#moment-list").textContent;
  assert(listText.includes("broll.png") && listText.includes("0:02") && listText.includes("0:05"), "list should show the b-roll moment with its file name and range: " + listText);
  assert(err.hidden || !err.textContent.trim(), "no validation error should be shown once the image is attached");
  const momentId = document.querySelector("#moment-list li").dataset.momentId;
  await waitFor(() => !!window.PDC.momentImages.get(momentId), "uploaded b-roll PNG should decode and register within a few seconds", 200);
  const decoded = window.PDC.momentImages.get(momentId);
  assert(decoded.naturalWidth > 0 && decoded.naturalHeight > 0, "decoded b-roll image should have real dimensions");

  // PLAYBACK: restart from 0 and watch the schedule unfold on the live canvas.
  document.querySelector("#restart").click();
  await waitFor(() => imageAbsent(), "no b-roll before 0:02 during playback", 60);
  await waitFor(() => imageShown(), "b-roll should appear during playback inside 2-5s", 150);
  await waitFor(() => imageAbsent(), "b-roll should disappear once playback passes 0:05", 200);

  // SCRUB: pause, then sample exact times through the real scrub control.
  function pausePreview() {
    const btn = document.querySelector("#play");
    if (btn.textContent.indexOf("Pause") !== -1) btn.click();
  }
  const scrub = document.querySelector("#scrub");
  async function scrubTo(t) {
    await waitFor(() => !scrub.disabled && Number(scrub.max) >= 6, "scrub bar should span the episode", 100);
    scrub.value = String(t);
    scrub.dispatchEvent(new Event("input", { bubbles: true }));
  }
  pausePreview();
  await scrubTo(1);
  await waitFor(() => imageAbsent(), "scrubbed to 1s: b-roll absent (Split)");
  await scrubTo(3.5);
  await waitFor(() => imageShown(), "scrubbed to 3.5s: b-roll shown (Split)");
  const splitStats = regionStats(stage(), IMAGE_REGION);
  await scrubTo(6);
  await waitFor(() => imageAbsent(), "scrubbed to 6s: b-roll absent (Split)");

  // PRESET SWITCHES: the same moment must stay attached to the episode and
  // render over the recomposed Stack and Spotlight layouts.
  const presetStats = {};
  for (const presetId of ["stack", "spotlight"]) {
    document.querySelector('[data-preset="' + presetId + '"]').click();
    await waitFor(() => stage().dataset.preset === presetId, presetId + " preset should apply");
    assert(document.querySelectorAll("#moment-list li").length === 1, "b-roll moment should survive switching to " + presetId);
    pausePreview();
    await scrubTo(1);
    await waitFor(() => imageAbsent(), presetId + ": b-roll absent at 1s");
    await scrubTo(3.5);
    await waitFor(() => imageShown(), presetId + ": b-roll shown at 3.5s over the recomposed layout");
    presetStats[presetId] = regionStats(stage(), IMAGE_REGION);
  }

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
  // seek before/during/after the b-roll range and sample the decoded frames.
  const v = document.createElement("video");
  v.muted = true; v.src = URL.createObjectURL(blob);
  await new Promise((r) => { v.onloadedmetadata = r; v.onerror = r; setTimeout(r, 5000); });
  assert(v.videoWidth > 0 && v.videoHeight > 0, "exported file should be a playable video with real dimensions");
  if (!isFinite(v.duration)) {
    v.currentTime = 1e7;
    await waitFor(() => isFinite(v.duration), "exported duration should resolve", 200);
  }
  assert(v.duration >= 5.2, "export should cover the b-roll range, duration=" + v.duration);

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
      region: regionStats(probe, IMAGE_REGION),
      frame: regionStats(probe, { x0: 0, y0: 0, x1: 100, y1: 100 }),
    };
  }
  const before = await seekAndSample(1);
  const during = await seekAndSample(3.5);
  const after = await seekAndSample(6);
  const burnedIn = (s) => s.magenta > 0.4;
  const plainVideo = (s) => s.magenta < 0.1;
  assert(before.frame.bright > 0.2, "exported frame at 1s should be nonblank");
  assert(plainVideo(before.region), "no b-roll should be burned in at 1s: " + JSON.stringify(before.region));
  assert(during.frame.bright > 0.2, "exported frame at 3.5s should be nonblank");
  assert(burnedIn(during.region), "b-roll overlay should be burned into the exported frame at 3.5s: " + JSON.stringify(during.region));
  assert(after.frame.bright > 0.2, "exported frame at 6s should be nonblank");
  assert(plainVideo(after.region), "no b-roll should be burned in at 6s: " + JSON.stringify(after.region));

  return {
    momentsListed: document.querySelectorAll("#moment-list li").length,
    preview: {
      splitAt3_5: splitStats,
      stackAt3_5: presetStats.stack,
      spotlightAt3_5: presetStats.spotlight,
    },
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
    // 120s budget: two ~8s in-browser media generations, playback + scrub +
    // preset-switch sampling, one full-length export, and three decode-seeks.
    const result = await send("Runtime.evaluate", { expression: browserExpression, awaitPromise: true, returnByValue: true, timeout: 120000 });
    ws.close();
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    console.log("verify-broll-moments: OK — timed b-roll image overlay renders only in range across Split/Stack/Spotlight and is burned into the export");
    console.log(JSON.stringify(result.result.value, null, 2));
  } finally {
    await stopChrome(child);
    await removeDirEventually(profileDir);
  }
}

main().catch((e) => { console.error(`verify-broll-moments: ${e.message}`); process.exit(1); });
