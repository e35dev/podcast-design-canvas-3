// scripts/verify-audio-quality.mjs
// Drives the shipped app in headless Chrome and proves the creator-facing audio
// quality controls affect export (#112): upload two generated speaker videos with
// DELIBERATELY different volumes (loud 440 Hz host vs quiet 660 Hz guest) plus
// background noise on the quiet one, select the audio quality controls through
// the real UI, click the real Export action, load the produced file back into a
// <video> (playable, real dimensions) AND decode its audio (analysis path) to
// confirm it is non-silent and that speaker loudness is NORMALIZED compared with
// the raw inputs — each speaker's contribution is isolated by measuring its own
// tone frequency in the mixed track, so the loud/quiet spread can be compared
// before and after leveling. A leveling-OFF export first proves the control (not
// some always-on path) causes the convergence. Then a preset switch + re-export
// WITHOUT re-uploading confirms the second file is also playable, non-silent, and
// still carries the same selected audio settings and leveling effect. No fixtures,
// seeded media, or verifier-only paths: media is generated in-browser, controls
// are clicked, and artifacts are read from the product's own download link.
// Mirrors the CDP harness used by the other rendered checks.
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
  throw new Error("Chrome/Chromium was not found. Set CHROME_BIN to run audio quality verification.");
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
  const waitFor = async (fn, label, tries) => { for (let i = 0; i < (tries || 200); i++) { if (fn()) return; await sleep(50); } throw new Error(label); };

  const HOST_HZ = 440, GUEST_HZ = 660;

  // Deterministic pseudo-noise (seeded LCG) so the quiet speaker also carries
  // broadband background noise, per the acceptance scenario.
  function noiseBuffer(ac, seconds, seed) {
    const buf = ac.createBuffer(1, Math.floor(ac.sampleRate * seconds), ac.sampleRate);
    const data = buf.getChannelData(0);
    let s = seed >>> 0;
    for (let i = 0; i < data.length; i++) {
      s = (s * 1664525 + 1013904223) >>> 0;
      data[i] = (s / 4294967296) * 2 - 1;
    }
    return buf;
  }

  async function makeVideo(name, color, toneHz, toneGain, noiseGain) {
    const canvas = document.createElement("canvas");
    canvas.width = 320; canvas.height = 180;
    const ctx = canvas.getContext("2d");
    const stream = canvas.captureStream(12);
    const ac = new AudioContext();
    const d = ac.createMediaStreamDestination();
    const osc = ac.createOscillator(); osc.frequency.value = toneHz;
    const g = ac.createGain(); g.gain.value = toneGain;
    osc.connect(g); g.connect(d); osc.start();
    if (noiseGain > 0) {
      const src = ac.createBufferSource(); src.buffer = noiseBuffer(ac, 1, 1234567); src.loop = true;
      const ng = ac.createGain(); ng.gain.value = noiseGain;
      src.connect(ng); ng.connect(d); src.start();
    }
    const mix = new MediaStream([...stream.getVideoTracks(), ...d.stream.getAudioTracks()]);
    const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp8,opus") ? "video/webm;codecs=vp8,opus" : "video/webm";
    const rec = new MediaRecorder(mix, { mimeType });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.start();
    for (let i = 0; i < 30; i++) { ctx.fillStyle = color; ctx.fillRect(0,0,320,180); ctx.fillStyle="#fff"; ctx.font="26px sans-serif"; ctx.fillText("frame "+i, 20, 100); await sleep(45); }
    await new Promise((r) => { rec.onstop = r; rec.stop(); });
    osc.stop(); ac.close(); stream.getTracks().forEach((t) => t.stop());
    return new File(chunks, name, { type: "video/webm" });
  }
  const uploadTo = (input, file) => { const dt = new DataTransfer(); dt.items.add(file); input.files = dt.files; input.dispatchEvent(new Event("change", { bubbles: true })); };

  // --- audio analysis path: decode a file/blob and measure loudness ----------
  // Each speaker uses its own tone frequency, so its loudness inside the MIXED
  // export can be isolated as the amplitude of that frequency (windowed DFT-bin
  // projection, median across windows so encoder edges/loop seams cannot skew it).
  function toneAmp(data, rate, freq, start, length) {
    const w = 2 * Math.PI * freq / rate;
    let sinSum = 0, cosSum = 0;
    for (let i = 0; i < length; i++) { const s = data[start + i]; sinSum += s * Math.sin(w * i); cosSum += s * Math.cos(w * i); }
    return 2 * Math.sqrt(sinSum * sinSum + cosSum * cosSum) / length;
  }
  async function analyzeAudio(blobOrFile, label) {
    const buf = await blobOrFile.arrayBuffer();
    const off = new OfflineAudioContext(1, 44100, 44100);
    let decoded;
    try { decoded = await off.decodeAudioData(buf); }
    catch (e) { throw new Error(label + ": audio track failed to decode (" + e.name + ")"); }
    const data = decoded.getChannelData(0);
    const rate = decoded.sampleRate;
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
    const rms = data.length ? Math.sqrt(sum / data.length) : 0;
    // Median tone amplitude over 5 windows spanning the middle 70% of the clip.
    const regionStart = Math.floor(data.length * 0.15);
    const regionLen = Math.floor(data.length * 0.7);
    const win = Math.floor(regionLen / 5);
    assert(win > rate * 0.05, label + ": decoded audio too short to analyze (" + data.length + " samples)");
    const median = (freq) => {
      const amps = [];
      for (let k = 0; k < 5; k++) amps.push(toneAmp(data, rate, freq, regionStart + k * win, win));
      amps.sort((a, b) => a - b);
      return amps[2];
    };
    return { rms, host: median(HOST_HZ), guest: median(GUEST_HZ), seconds: Number((decoded.duration).toFixed(2)) };
  }

  await waitFor(() => window.PDC && document.querySelector('[data-file-bucket="host"]') && document.querySelector("#export") && document.querySelector("#audio-leveling"), "shipped controls (incl. audio quality) should exist");

  // 1. Upload two speaker videos with deliberately different volumes; the quiet
  //    one also carries background noise.
  const hostFile = await makeVideo("host.webm", "#b91c1c", HOST_HZ, 0.9, 0);
  const guestFile = await makeVideo("guest.webm", "#047857", GUEST_HZ, 0.12, 0.04);
  uploadTo(document.querySelector('[data-file-bucket="host"]'), hostFile);
  await sleep(100);
  uploadTo(document.querySelector('[data-file-bucket="guest1"]'), guestFile);
  await waitFor(() => {
    const vids = [...document.querySelectorAll("video[data-speaker]")];
    return vids.length === 2 && vids.every((v) => v.readyState >= 2 && isFinite(v.duration) && v.duration > 0);
  }, "both uploaded speaker videos should decode", 400);
  await sleep(500);

  // Raw-input baseline: the two speakers really are unevenly loud.
  const rawHost = await analyzeAudio(hostFile, "raw host input");
  const rawGuest = await analyzeAudio(guestFile, "raw guest input");
  const rawSpread = rawHost.host / Math.max(rawGuest.guest, 1e-6);
  assert(rawHost.host > 0.2 && rawGuest.guest > 0.01, "raw inputs must carry their tones, got " + rawHost.host + " / " + rawGuest.guest);
  assert(rawSpread > 2.5, "raw inputs must be deliberately uneven (>2.5x), got " + rawSpread);

  const pressed = (id) => document.querySelector(id).getAttribute("aria-pressed") === "true";
  const statusText = () => (document.querySelector("#audio-status").textContent || "");

  // 2. The audio quality controls are real UI: leveling defaults on, toggles off
  //    and back on through clicks, and the visible status line follows.
  assert(pressed("#audio-leveling"), "leveling should default on");
  document.querySelector("#audio-leveling").click();
  assert(!pressed("#audio-leveling"), "leveling toggle should turn off via the real UI");
  await waitFor(() => /original speaker volumes/.test(statusText()), "status line should reflect leveling off");

  // Choose a preset so the export reflects a selected composition.
  document.querySelector('[data-preset="stack"]').click();
  await sleep(200);
  assert(document.querySelector("#stage-canvas").dataset.preset === "stack", "selected preset should be active before export");
  await waitFor(() => !document.querySelector("#export").disabled, "Export action should be enabled after upload + preset");

  async function runExport(label) {
    const result = document.querySelector("#export-result");
    result.hidden = true; result.innerHTML = "";
    await waitFor(() => !document.querySelector("#export").disabled, label + ": Export should be enabled");
    document.querySelector("#export").click();
    await waitFor(
      () => document.querySelector("#export-download") && document.querySelector("#export-playback"),
      label + ": export should produce a downloadable result",
      600,
    );
    const link = document.querySelector("#export-download");
    const href = link.getAttribute("href");
    assert(href && href.indexOf("blob:") === 0, label + ": download link should be a real blob URL");
    const blob = await (await fetch(href)).blob();
    assert(blob.size > 2048, label + ": exported file should carry real bytes, got " + blob.size);

    const v = document.createElement("video");
    v.muted = true; v.src = URL.createObjectURL(blob);
    await new Promise((r) => { v.onloadedmetadata = r; v.onerror = r; setTimeout(r, 5000); });
    assert(v.videoWidth > 0 && v.videoHeight > 0, label + ": exported file should be a playable video with real dimensions");

    const audio = await analyzeAudio(blob, label + ": exported audio");
    assert(audio.rms > 1e-3, label + ": exported audio must be non-silent, rms=" + audio.rms);
    assert(audio.host > 5e-3 && audio.guest > 5e-4, label + ": both speakers must be audible in the mix, got " + audio.host + " / " + audio.guest);
    const spread = Math.max(audio.host, audio.guest) / Math.min(audio.host, audio.guest);
    return {
      bytes: blob.size,
      dimensions: v.videoWidth + "x" + v.videoHeight,
      downloadName: link.getAttribute("download"),
      rms: Number(audio.rms.toFixed(4)),
      hostAmp: Number(audio.host.toFixed(4)),
      guestAmp: Number(audio.guest.toFixed(4)),
      spread: Number(spread.toFixed(2)),
      settingsShown: (document.querySelector("#export-audio") || {}).textContent || "",
    };
  }

  // 3. Control OFF: the export keeps the raw imbalance (proves the toggle, not
  //    an always-on path, is what levels the mix).
  const unleveled = await runExport("leveling-off export");
  assert(unleveled.spread > 2, "with leveling off the loud/quiet spread should persist, got " + unleveled.spread);
  assert(/original speaker volumes/.test(unleveled.settingsShown), "export card should show leveling was off");

  // 4. Select the audio quality controls through the real UI: leveling back on,
  //    clarity on, noise reduction on.
  document.querySelector("#audio-leveling").click();
  document.querySelector("#audio-clarity").click();
  document.querySelector("#audio-noise").click();
  assert(pressed("#audio-leveling") && pressed("#audio-clarity") && pressed("#audio-noise"), "all three audio controls should be selected");
  await waitFor(() => /volumes balanced/.test(statusText()) && /clarity on/.test(statusText()) && /noise reduction on/.test(statusText()), "status line should reflect the selected audio settings");

  // 5. Export with leveling ON: loud and quiet speakers converge vs the raw inputs.
  const leveled = await runExport("leveled export");
  assert(leveled.spread < 3, "leveled export should bring speakers close together, spread=" + leveled.spread);
  assert(leveled.spread < rawSpread * 0.55, "leveled spread (" + leveled.spread + ") should be well under the raw input spread (" + rawSpread.toFixed(2) + ")");
  assert(leveled.spread < unleveled.spread * 0.6, "leveling on should measurably converge vs leveling off (" + leveled.spread + " vs " + unleveled.spread + ")");
  assert(/volumes balanced/.test(leveled.settingsShown) && /clarity on/.test(leveled.settingsShown) && /noise reduction on/.test(leveled.settingsShown), "export card should show the selected audio settings");

  // 6. Switch preset and export AGAIN without re-uploading: the audio settings
  //    must survive and keep the same effect.
  document.querySelector('[data-preset="split"]').click();
  await sleep(200);
  assert(document.querySelector("#stage-canvas").dataset.preset === "split", "preset switch to split should apply before the re-export");
  assert(pressed("#audio-leveling") && pressed("#audio-clarity") && pressed("#audio-noise"), "audio settings must survive the preset switch");
  await waitFor(() => /volumes balanced/.test(statusText()) && /clarity on/.test(statusText()) && /noise reduction on/.test(statusText()), "status line should still show the selected settings after the preset switch");

  const releveled = await runExport("post-preset-switch export");
  assert(/split/.test(releveled.downloadName || ""), "second export should reflect the switched (split) layout, got " + releveled.downloadName);
  assert(releveled.spread < 3, "re-export after preset switch should keep the leveling effect, spread=" + releveled.spread);
  assert(releveled.spread < rawSpread * 0.55, "re-export spread (" + releveled.spread + ") should stay well under the raw input spread (" + rawSpread.toFixed(2) + ")");
  assert(/volumes balanced/.test(releveled.settingsShown) && /clarity on/.test(releveled.settingsShown) && /noise reduction on/.test(releveled.settingsShown), "re-export card should still show the same audio settings");

  return {
    rawInputSpread: Number(rawSpread.toFixed(2)),
    unleveledExport: unleveled,
    leveledExport: leveled,
    postPresetSwitchExport: releveled,
  };
})()
`;

async function main() {
  const chrome = findChrome();
  const port = await getFreePort();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdc-audioq-"));
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
    // 120s budget: three full exports (record + decode) plus in-browser media setup.
    const result = await send("Runtime.evaluate", { expression: browserExpression, awaitPromise: true, returnByValue: true, timeout: 120000 });
    ws.close();
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    console.log("verify-audio-quality: OK — leveling converges uneven speakers in export, clarity/noise choices persist across a preset switch and re-export");
    console.log(JSON.stringify(result.result.value, null, 2));
  } finally {
    await stopChrome(child);
    await removeDirEventually(profileDir);
  }
}

main().catch((e) => { console.error(`verify-audio-quality: ${e.message}`); process.exit(1); });
