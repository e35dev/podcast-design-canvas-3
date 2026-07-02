// scripts/verify-broll-moments.mjs
// Drives the shipped app in headless Chrome and proves the b-roll IMAGE moment
// workflow end to end (issue #130): upload two generated speaker WebM videos
// (solid red host / solid green guest, ~8s, with audio) through the normal Host
// and Guest controls, enter social links, choose Split, then add a B-ROLL
// moment (0:02-0:06) carrying a generated PNG through the real moments UI (pick
// type "B-roll image", attach the PNG file to the shipped file input, set the
// range, click Add). It then verifies, by sampling canvas pixels in the centre
// inset where the b-roll panel renders, that during playback and while scrubbing
// the image appears ONLY inside 2-6s and not before/after; that switching to
// Stack and Spotlight keeps the same b-roll rendering over the recomposed
// preview; and finally that the real Export action produces a playable video in
// which the overlay is BURNED INTO the frames: the exported file is loaded back
// into a <video>, seeked to 1s / 4s / 7s, and each decoded frame is drawn to a
// probe canvas and region-sampled (dark backing card + bright image pixels =
// present; plain video = absent). The generated PNG is a distinctive
// blue-and-yellow checker so its pixels are trivially separable from the solid
// red/green speaker video. All pixel assertions are region-based and tolerant of
// encoder loss, and every wait polls a natural condition — no committed
// fixtures, seeded media, or verifier-only product paths. Mirrors the CDP
// harness used by the other rendered checks.
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
  // b-roll inset region is trivially distinguishable) with an audio tone.
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

  // A distinctive blue/yellow checker PNG so the b-roll pixels are trivially
  // separable from the solid red/green speaker video (never red/green).
  async function makePng(name) {
    const c = document.createElement("canvas");
    c.width = 240; c.height = 160;
    const g = c.getContext("2d");
    const tile = 20;
    for (let y = 0; y < c.height; y += tile) {
      for (let x = 0; x < c.width; x += tile) {
        g.fillStyle = ((x / tile + y / tile) % 2 === 0) ? "#1d4ed8" : "#facc15";
        g.fillRect(x, y, tile, tile);
      }
    }
    const blob = await new Promise((r) => c.toBlob(r, "image/png"));
    return new File([blob], name, { type: "image/png" });
  }

  const uploadTo = (input, file) => { const dt = new DataTransfer(); dt.items.add(file); input.files = dt.files; input.dispatchEvent(new Event("change", { bubbles: true })); };
  const typeInto = (input, v) => { input.value = v; input.dispatchEvent(new Event("input", { bubbles: true })); };
  const setSelect = (sel, v) => { sel.value = v; sel.dispatchEvent(new Event("change", { bubbles: true })); };

  // Region sampling: the b-roll panel renders as a centred inset (~50% of the
  // stage). "Present" = a dark backing card plus bright (non-red/green) image
  // pixels; "absent" = plain solid video in that centre region. Bounds are inset
  // so the checks stay tolerant of encoder loss and rounding.
  const BROLL_REGION = { x0: 35, y0: 32, x1: 65, y1: 60 };
  function regionStats(canvas, region) {
    const w = canvas.width, h = canvas.height;
    const x0 = Math.floor(region.x0 / 100 * w), x1 = Math.floor(region.x1 / 100 * w);
    const y0 = Math.floor(region.y0 / 100 * h), y1 = Math.floor(region.y1 / 100 * h);
    const data = canvas.getContext("2d").getImageData(x0, y0, x1 - x0, y1 - y0).data;
    let dark = 0, blue = 0, yellow = 0, bright = 0;
    const n = data.length / 4;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], gg = data[i + 1], b = data[i + 2];
      if (r < 70 && gg < 70 && b < 70) dark++;
      // checker colors: blue tile (low R, high B) and yellow tile (high R+G, low B)
      if (b > 130 && r < 120) blue++;
      if (r > 170 && gg > 150 && b < 130) yellow++;
      if (r > 110 || gg > 110 || b > 110) bright++;
    }
    return { dark: dark / n, blue: blue / n, yellow: yellow / n, bright: bright / n };
  }
  const stage = () => document.querySelector("#stage-canvas");
  // b-roll shown = clear checker signal (both tile colors) somewhere in the inset.
  const brollShown = (canvas) => { const s = regionStats(canvas || stage(), BROLL_REGION); return s.blue > 0.03 && s.yellow > 0.03; };
  const brollAbsent = (canvas) => { const s = regionStats(canvas || stage(), BROLL_REGION); return s.blue < 0.01 && s.yellow < 0.01; };

  await waitFor(() => window.PDC && window.PDC.moments && document.querySelector('[data-file-bucket="host"]')
    && document.querySelector("#moment-add") && document.querySelector("#moment-image") && document.querySelector("#export") && document.querySelector("#scrub"),
    "shipped moment/image/scrub/export controls should exist");

  // Model semantics: broll is a real type with [start, end) activation.
  {
    const scratch = window.PDC.episode.createEpisode({});
    window.PDC.moments.addMoment(scratch, { type: "broll", imageId: "x", start: "0:02", end: "0:06" });
    const at = (t) => window.PDC.moments.activeMoments(scratch, t).map((m) => m.type).join(",");
    assert(at(1.9) === "", "b-roll should not be active before its start");
    assert(at(2) === "broll" && at(5.9) === "broll", "b-roll should be active inside 2-6s");
    assert(at(6) === "" && at(7) === "", "b-roll should be gone at/after its end (exclusive)");
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
    "uploaded speakers should decode with a real duration covering the b-roll range", 400,
  );

  typeInto(document.querySelector('[data-link-bucket="host"]'), "https://x.com/hostperson");
  typeInto(document.querySelector('[data-link-bucket="guest1"]'), "https://x.com/guestperson");

  // Choose Split.
  document.querySelector('[data-preset="split"]').click();
  await waitFor(() => stage().dataset.preset === "split", "Split preset should be active");

  // Add a B-ROLL moment (0:02-0:06) with a generated PNG through the real UI:
  // pick the type, which reveals the image picker; attach the PNG file to the
  // shipped file input; set the range; click Add.
  const png = await makePng("broll.png");
  setSelect(document.querySelector("#moment-type"), "broll");
  await waitFor(() => !document.querySelector("#moment-image-label").hidden, "b-roll image picker should appear for b-roll moments");
  uploadTo(document.querySelector("#moment-image"), png);
  typeInto(document.querySelector("#moment-text"), "Reference slide");
  typeInto(document.querySelector("#moment-start"), "0:02");
  typeInto(document.querySelector("#moment-end"), "0:06");
  document.querySelector("#moment-add").click();
  await waitFor(() => document.querySelectorAll("#moment-list li").length === 1, "b-roll moment should appear in the list");
  const li = document.querySelector("#moment-list li");
  assert(li.dataset.momentType === "broll", "list item should be a b-roll moment");
  assert(/2:|0:02/.test(li.textContent) || li.textContent.includes("0:02"), "list should show the b-roll range start");
  assert(li.textContent.includes("0:06"), "list should show the b-roll range end");
  const err = document.querySelector("#moment-error");
  assert(err.hidden || !err.textContent.trim(), "no validation error should be shown for a valid b-roll moment");
  // Let the picked image decode into the preview.
  await sleep(150);

  // PLAYBACK: restart from 0 and watch the schedule unfold on the live canvas.
  document.querySelector("#restart").click();
  await waitFor(() => brollAbsent(), "b-roll should be absent right after restart (before 0:02)", 60);
  await waitFor(() => brollShown(), "b-roll image should appear during playback inside 2-6s (Split)", 200);
  await waitFor(() => brollAbsent(), "b-roll image should disappear once playback passes 0:06", 300);

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
  await waitFor(() => brollAbsent(), "scrubbed to 1s: b-roll absent (before start)");
  assert(regionStats(stage(), BROLL_REGION).bright > 0.5, "at 1s the centre region should show plain bright video");
  await scrubTo(4);
  await waitFor(() => brollShown(), "scrubbed to 4s: b-roll image shown (Split)");
  const splitBrollStats = regionStats(stage(), BROLL_REGION);
  await scrubTo(7);
  await waitFor(() => brollAbsent(), "scrubbed to 7s: b-roll absent (after end)");

  // PRESET SWITCHES: the same b-roll must stay attached to the episode and
  // render over the recomposed Stack and Spotlight layouts.
  const presetStats = {};
  for (const presetId of ["stack", "spotlight"]) {
    document.querySelector('[data-preset="' + presetId + '"]').click();
    await waitFor(() => stage().dataset.preset === presetId, presetId + " preset should apply");
    assert(document.querySelectorAll("#moment-list li").length === 1, "b-roll moment should survive switching to " + presetId);
    await scrubTo(4);
    await waitFor(() => brollShown(), presetId + ": b-roll should render over the recomposed layout at 4s");
    presetStats[presetId] = regionStats(stage(), BROLL_REGION);
    await scrubTo(7);
    await waitFor(() => brollAbsent(), presetId + ": b-roll absent at 7s");
  }

  // Back to Split for the export.
  document.querySelector('[data-preset="split"]').click();
  await waitFor(() => stage().dataset.preset === "split", "Split should be re-applied before export");

  // EXPORT: click the real Export action and read the product's own download.
  await waitFor(() => !document.querySelector("#export").disabled, "Export should be enabled");
  document.querySelector("#export").click();
  await waitFor(
    () => document.querySelector("#export-download") && document.querySelector("#export-playback"),
    "export should produce a downloadable result", 900,
  );
  const resultText = document.querySelector("#export-result").textContent || "";
  assert(!/failed/i.test(resultText), "export must not report failure: " + resultText);
  const href = document.querySelector("#export-download").getAttribute("href");
  assert(href && href.indexOf("blob:") === 0, "download link should be a real blob URL");
  const blob = await (await fetch(href)).blob();
  assert(blob.size > 4096, "exported file should carry real bytes, got " + blob.size);

  // Load the exported file back into a <video>, resolve its real duration
  // (recorder-produced WebM reports Infinity until nudged to the end), then
  // seek into and outside the b-roll range and sample the decoded frames.
  const v = document.createElement("video");
  v.muted = true; v.src = URL.createObjectURL(blob);
  await new Promise((r) => { v.onloadedmetadata = r; v.onerror = r; setTimeout(r, 5000); });
  assert(v.videoWidth > 0 && v.videoHeight > 0, "exported file should be a playable video with real dimensions");
  if (!isFinite(v.duration)) {
    v.currentTime = 1e7;
    await waitFor(() => isFinite(v.duration), "exported duration should resolve", 200);
  }
  assert(v.duration >= 6.2, "export should cover the b-roll range, duration=" + v.duration);

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
    return {
      t,
      broll: regionStats(probe, BROLL_REGION),
      frame: regionStats(probe, { x0: 0, y0: 0, x1: 100, y1: 100 }),
    };
  }
  const beforeMoment = await seekAndSample(1);
  const inMoment = await seekAndSample(4);
  const afterMoment = await seekAndSample(7);
  // The b-roll panel fills its centre inset edge-to-edge with the decoded PNG,
  // so the burn-in proof is the checker pattern itself — BOTH tile colours
  // (blue AND yellow) present in force. A solid red/green speaker frame can
  // never produce both, so this is unambiguous and far stronger than a mere
  // "something dark is drawn" check (the dark backing card sits in the thin
  // pad border, outside this interior sample region).
  const burnedIn = (s) => s.blue > 0.1 && s.yellow > 0.1;
  const plainVideo = (s) => s.blue < 0.01 && s.yellow < 0.01;
  assert(beforeMoment.frame.bright > 0.2, "exported frame at 1s should be nonblank");
  assert(plainVideo(beforeMoment.broll), "no b-roll should be burned in at 1s (before start): " + JSON.stringify(beforeMoment.broll));
  assert(inMoment.frame.bright > 0.2, "exported frame at 4s should be nonblank");
  assert(burnedIn(inMoment.broll), "b-roll image should be burned into the exported frame at 4s: " + JSON.stringify(inMoment.broll));
  assert(afterMoment.frame.bright > 0.2, "exported frame at 7s should be nonblank");
  assert(plainVideo(afterMoment.broll), "no b-roll should be burned in at 7s (after end): " + JSON.stringify(afterMoment.broll));

  return {
    momentsListed: document.querySelectorAll("#moment-list li").length,
    preview: {
      splitBrollAt4: splitBrollStats,
      stackBrollAt4: presetStats.stack,
      spotlightBrollAt4: presetStats.spotlight,
    },
    exportBytes: blob.size,
    exportDuration: Number(v.duration.toFixed(2)),
    exportSamples: { beforeMoment, inMoment, afterMoment },
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
    // 120s budget: two ~8s in-browser media generations, a PNG generation,
    // playback + scrub + preset-switch sampling, one full-length export, and
    // three decode-seeks.
    const result = await send("Runtime.evaluate", { expression: browserExpression, awaitPromise: true, returnByValue: true, timeout: 120000 });
    ws.close();
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    console.log("verify-broll-moments: OK — a timed b-roll PNG renders only in range across Split/Stack/Spotlight and is burned into the export");
    console.log(JSON.stringify(result.result.value, null, 2));
  } finally {
    await stopChrome(child);
    await removeDirEventually(profileDir);
  }
}

main().catch((e) => { console.error(`verify-broll-moments: ${e.message}`); process.exit(1); });
