// scripts/verify-visual-moments.mjs
// Drives the shipped app in headless Chrome and proves the timed visual
// moments workflow end to end: upload two generated speaker WebM videos
// (solid red host / solid green guest, ~8s, with audio) through the normal
// Host and Guest controls, enter social links, choose Split, then add a
// TITLE moment (0:00-0:03) and a CALLOUT moment (0:04-0:07) through the real
// moments UI. It then verifies, by sampling canvas pixels in the regions
// where each banner renders, that during playback and while scrubbing the
// title appears ONLY inside 0-3s, the callout ONLY inside 4-7s, and neither
// appears in the 3-4s gap; that switching to Stack and Spotlight keeps the
// same moments rendering over the recomposed preview; and finally that the
// real Export action produces a playable video in which the moments are
// BURNED INTO the frames: the exported file is loaded back into a <video>,
// seeked to 1.5s / 3.5s / 5.5s, and each decoded frame is drawn to a probe
// canvas and region-sampled (dark backing bar + light text = present; plain
// bright video = absent). All pixel assertions are region-based and tolerant
// of encoder loss, and every wait polls a natural condition — no committed
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
  throw new Error("Chrome/Chromium was not found. Set CHROME_BIN to run visual-moments verification.");
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
  // moment-banner regions are trivially distinguishable) with an audio tone.
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
  const uploadTo = (input, file) => { const dt = new DataTransfer(); dt.items.add(file); input.files = dt.files; input.dispatchEvent(new Event("change", { bubbles: true })); };
  const typeInto = (input, v) => { input.value = v; input.dispatchEvent(new Event("input", { bubbles: true })); };

  // Region sampling: the title bar renders across the top of the stage and the
  // callout as a lower-third banner. "Present" = mostly dark backing pixels
  // plus some light text pixels; "absent" = plain bright video (the generated
  // speakers are solid red/green, so the regions carry no dark/white pixels
  // when no moment is drawn). Bounds are inset from the drawn bars so the
  // checks stay tolerant of encoder loss and rounding.
  const TITLE_REGION = { x0: 10, y0: 7, x1: 90, y1: 17 };
  const CALLOUT_REGION = { x0: 7, y0: 78, x1: 32, y1: 85 };
  function regionStats(canvas, region) {
    const w = canvas.width, h = canvas.height;
    const x0 = Math.floor(region.x0 / 100 * w), x1 = Math.floor(region.x1 / 100 * w);
    const y0 = Math.floor(region.y0 / 100 * h), y1 = Math.floor(region.y1 / 100 * h);
    const data = canvas.getContext("2d").getImageData(x0, y0, x1 - x0, y1 - y0).data;
    let dark = 0, light = 0, bright = 0;
    const n = data.length / 4;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (r < 70 && g < 70 && b < 70) dark++;
      if (r > 180 && g > 180 && b > 180) light++;
      if (r > 110 || g > 110 || b > 110) bright++;
    }
    return { dark: dark / n, light: light / n, bright: bright / n };
  }
  const stage = () => document.querySelector("#stage-canvas");
  const titleShown = () => { const s = regionStats(stage(), TITLE_REGION); return s.dark > 0.45 && s.light > 0.004; };
  const calloutShown = () => { const s = regionStats(stage(), CALLOUT_REGION); return s.dark > 0.45 && s.light > 0.004; };
  const titleAbsent = () => { const s = regionStats(stage(), TITLE_REGION); return s.dark < 0.1 && s.light < 0.01; };
  const calloutAbsent = () => { const s = regionStats(stage(), CALLOUT_REGION); return s.dark < 0.1 && s.light < 0.01; };

  await waitFor(() => window.PDC && window.PDC.moments && document.querySelector('[data-file-bucket="host"]')
    && document.querySelector("#moment-add") && document.querySelector("#export") && document.querySelector("#scrub"),
    "shipped moment/scrub/export controls should exist");

  // Model semantics: [start, end) activation — start inclusive, end exclusive.
  {
    const scratch = window.PDC.episode.createEpisode({});
    window.PDC.moments.addMoment(scratch, { type: "title", text: "EP TITLE", start: "0:00", end: "0:03" });
    window.PDC.moments.addMoment(scratch, { type: "callout", text: "CALLOUT REF", start: "0:04", end: "0:07" });
    const at = (t) => window.PDC.moments.activeMoments(scratch, t).map((m) => m.type).join(",");
    assert(at(0) === "title", "title should be active at exactly its start (inclusive)");
    assert(at(1.5) === "title" && at(2.9) === "title", "title should be active inside 0-3s");
    assert(at(3) === "" && at(3.5) === "", "nothing should be active in the 3-4s gap (end exclusive)");
    assert(at(4) === "callout" && at(5) === "callout", "callout should be active inside 4-7s");
    assert(at(7) === "" && at(8) === "", "callout should be gone at/after its end");
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
    "uploaded speakers should decode with a real duration covering both moment ranges", 400,
  );

  typeInto(document.querySelector('[data-link-bucket="host"]'), "https://x.com/hostperson");
  typeInto(document.querySelector('[data-link-bucket="guest1"]'), "https://x.com/guestperson");

  // Choose Split.
  document.querySelector('[data-preset="split"]').click();
  await waitFor(() => stage().dataset.preset === "split", "Split preset should be active");

  // Add the two timed moments through the real UI.
  function addMomentViaUi(type, text, start, end) {
    const sel = document.querySelector("#moment-type");
    sel.value = type; sel.dispatchEvent(new Event("change", { bubbles: true }));
    typeInto(document.querySelector("#moment-text"), text);
    typeInto(document.querySelector("#moment-start"), start);
    typeInto(document.querySelector("#moment-end"), end);
    document.querySelector("#moment-add").click();
  }
  addMomentViaUi("title", "EP TITLE", "0:00", "0:03");
  await waitFor(() => document.querySelectorAll("#moment-list li").length === 1, "title moment should appear in the list");
  addMomentViaUi("callout", "CALLOUT REF", "0:04", "0:07");
  await waitFor(() => document.querySelectorAll("#moment-list li").length === 2, "callout moment should appear in the list");
  const listText = document.querySelector("#moment-list").textContent;
  assert(listText.includes("EP TITLE") && listText.includes("0:00") && listText.includes("0:03"), "list should show the title moment with its range");
  assert(listText.includes("CALLOUT REF") && listText.includes("0:04") && listText.includes("0:07"), "list should show the callout moment with its range");
  const err = document.querySelector("#moment-error");
  assert(err.hidden || !err.textContent.trim(), "no validation error should be shown for valid moments");

  // PLAYBACK: restart from 0 and watch the schedule unfold on the live canvas.
  document.querySelector("#restart").click();
  await waitFor(() => titleShown() && calloutAbsent(), "title should appear during playback inside 0-3s (Split)", 120);
  await waitFor(() => titleAbsent(), "title should disappear once playback passes 0:03", 200);
  await waitFor(() => calloutShown() && titleAbsent(), "callout should appear during playback inside 4-7s (Split)", 200);

  // SCRUB: pause, then sample exact times through the real scrub control.
  function pausePreview() {
    const btn = document.querySelector("#play");
    if (btn.textContent.indexOf("Pause") !== -1) btn.click();
  }
  const scrub = document.querySelector("#scrub");
  async function scrubTo(t) {
    await waitFor(() => !scrub.disabled && Number(scrub.max) >= 7, "scrub bar should span the episode", 100);
    scrub.value = String(t);
    scrub.dispatchEvent(new Event("input", { bubbles: true }));
  }
  pausePreview();
  await scrubTo(1.5);
  await waitFor(() => titleShown() && calloutAbsent(), "scrubbed to 1.5s: title shown, callout absent (Split)");
  const splitTitleStats = regionStats(stage(), TITLE_REGION);
  await scrubTo(3.5);
  await waitFor(() => titleAbsent() && calloutAbsent(), "scrubbed to 3.5s: neither moment shown (Split)");
  assert(regionStats(stage(), TITLE_REGION).bright > 0.5, "at 3.5s the title region should show plain bright video");
  await scrubTo(5);
  await waitFor(() => calloutShown() && titleAbsent(), "scrubbed to 5s: callout shown, title absent (Split)");
  const splitCalloutStats = regionStats(stage(), CALLOUT_REGION);

  // PRESET SWITCHES: the same moments must stay attached to the episode and
  // render over the recomposed Stack and Spotlight layouts.
  const presetStats = {};
  for (const presetId of ["stack", "spotlight"]) {
    document.querySelector('[data-preset="' + presetId + '"]').click();
    await waitFor(() => stage().dataset.preset === presetId, presetId + " preset should apply");
    assert(document.querySelectorAll("#moment-list li").length === 2, "moments should survive switching to " + presetId);
    await waitFor(() => titleShown(), presetId + ": title should render over the recomposed layout inside 0-3s", 120);
    pausePreview();
    await scrubTo(3.5);
    await waitFor(() => titleAbsent() && calloutAbsent(), presetId + ": neither moment at 3.5s");
    await scrubTo(5);
    await waitFor(() => calloutShown() && titleAbsent(), presetId + ": callout shown (and title absent) at 5s");
    presetStats[presetId] = regionStats(stage(), CALLOUT_REGION);
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
  // seek into and outside each moment range and sample the decoded frames.
  const v = document.createElement("video");
  v.muted = true; v.src = URL.createObjectURL(blob);
  await new Promise((r) => { v.onloadedmetadata = r; v.onerror = r; setTimeout(r, 5000); });
  assert(v.videoWidth > 0 && v.videoHeight > 0, "exported file should be a playable video with real dimensions");
  if (!isFinite(v.duration)) {
    v.currentTime = 1e7;
    await waitFor(() => isFinite(v.duration), "exported duration should resolve", 200);
  }
  assert(v.duration >= 6.2, "export should cover both moment ranges, duration=" + v.duration);

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
      title: regionStats(probe, TITLE_REGION),
      callout: regionStats(probe, CALLOUT_REGION),
      frame: regionStats(probe, { x0: 0, y0: 0, x1: 100, y1: 100 }),
    };
  }
  const inTitle = await seekAndSample(1.5);
  const inGap = await seekAndSample(3.5);
  const inCallout = await seekAndSample(5.5);
  const burnedIn = (s) => s.dark > 0.3 && s.light > 0.0015;
  const plainVideo = (s) => s.dark < 0.15;
  assert(inTitle.frame.bright > 0.2, "exported frame at 1.5s should be nonblank");
  assert(burnedIn(inTitle.title), "title overlay should be burned into the exported frame at 1.5s: " + JSON.stringify(inTitle.title));
  assert(plainVideo(inTitle.callout), "no callout should be burned in at 1.5s: " + JSON.stringify(inTitle.callout));
  assert(inGap.frame.bright > 0.2, "exported frame at 3.5s should be nonblank");
  assert(plainVideo(inGap.title) && inGap.title.light < 0.02, "no title should be burned in at 3.5s: " + JSON.stringify(inGap.title));
  assert(plainVideo(inGap.callout), "no callout should be burned in at 3.5s: " + JSON.stringify(inGap.callout));
  assert(inCallout.frame.bright > 0.2, "exported frame at 5.5s should be nonblank");
  assert(burnedIn(inCallout.callout), "callout overlay should be burned into the exported frame at 5.5s: " + JSON.stringify(inCallout.callout));
  assert(plainVideo(inCallout.title), "no title should be burned in at 5.5s: " + JSON.stringify(inCallout.title));

  return {
    momentsListed: document.querySelectorAll("#moment-list li").length,
    preview: {
      splitTitleAt1_5: splitTitleStats,
      splitCalloutAt5: splitCalloutStats,
      stackCalloutAt5: presetStats.stack,
      spotlightCalloutAt5: presetStats.spotlight,
    },
    exportBytes: blob.size,
    exportDuration: Number(v.duration.toFixed(2)),
    exportSamples: { inTitle, inGap, inCallout },
  };
})()
`;

async function main() {
  const chrome = findChrome();
  const port = await getFreePort();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdc-moments-"));
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
    console.log("verify-visual-moments: OK — timed title/callout render only in range across Split/Stack/Spotlight and are burned into the export");
    console.log(JSON.stringify(result.result.value, null, 2));
  } finally {
    await stopChrome(child);
    await removeDirEventually(profileDir);
  }
}

main().catch((e) => { console.error(`verify-visual-moments: ${e.message}`); process.exit(1); });
