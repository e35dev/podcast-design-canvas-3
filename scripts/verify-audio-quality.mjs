// scripts/verify-audio-quality.mjs
// Drives the shipped app in headless Chrome and proves the audio-quality flow:
// upload two generated WebM speaker videos with intentionally mismatched speaker
// loudness and background hum, choose the real creator-facing audio controls,
// export, decode the product's own WebM output, and confirm leveling makes the
// loud and quiet speaker sections meaningfully closer. Then switch presets and
// export again without re-uploading to prove the settings persist.
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
  throw new Error("Chrome/Chromium was not found. Set CHROME_BIN to run audio-quality verification.");
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
  const waitFor = async (fn, label, tries) => { for (let i = 0; i < (tries || 220); i++) { if (fn()) return; await sleep(50); } throw new Error(label); };

  async function makeSpeakerVideo(name, color, role) {
    const canvas = document.createElement("canvas");
    canvas.width = 320; canvas.height = 180;
    const ctx = canvas.getContext("2d");
    const stream = canvas.captureStream(12);

    const ac = new AudioContext();
    const dest = ac.createMediaStreamDestination();
    const voice = ac.createOscillator();
    voice.frequency.value = role === "host" ? 440 : 660;
    const voiceGain = ac.createGain();
    voiceGain.gain.value = 0.0001;

    const hum = ac.createOscillator();
    hum.frequency.value = role === "host" ? 95 : 115;
    const humGain = ac.createGain();
    humGain.gain.value = 0.005;

    voice.connect(voiceGain).connect(dest);
    hum.connect(humGain).connect(dest);
    const now = ac.currentTime;
    if (role === "host") {
      voiceGain.gain.setValueAtTime(0.92, now);
      voiceGain.gain.setValueAtTime(0.0001, now + 1.25);
    } else {
      voiceGain.gain.setValueAtTime(0.0001, now);
      voiceGain.gain.setValueAtTime(0.085, now + 1.25);
    }
    voice.start();
    hum.start();

    const mix = new MediaStream([...stream.getVideoTracks(), ...dest.stream.getAudioTracks()]);
    const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp8,opus") ? "video/webm;codecs=vp8,opus" : "video/webm";
    const rec = new MediaRecorder(mix, { mimeType });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.start();
    for (let i = 0; i < 64; i++) {
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 320, 180);
      ctx.fillStyle = "#fff";
      ctx.font = "24px sans-serif";
      ctx.fillText(role + " frame " + i, 20, 98);
      await sleep(40);
    }
    await new Promise((r) => { rec.onstop = r; rec.stop(); });
    voice.stop(); hum.stop(); ac.close(); stream.getTracks().forEach((t) => t.stop());
    return new File(chunks, name, { type: "video/webm" });
  }

  async function decodeBlob(blob) {
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    try {
      return await ac.decodeAudioData(await blob.arrayBuffer());
    } finally {
      ac.close();
    }
  }

  function rms(decoded, startPct, endPct) {
    const start = Math.max(0, Math.floor(decoded.length * startPct));
    const end = Math.min(decoded.length, Math.floor(decoded.length * endPct));
    let sum = 0, count = 0;
    for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
      const data = decoded.getChannelData(ch);
      for (let i = start; i < end; i += 19) {
        sum += data[i] * data[i];
        count++;
      }
    }
    return Math.sqrt(sum / Math.max(1, count));
  }

  function loudnessReport(decoded) {
    const loudSection = rms(decoded, 0.12, 0.42);
    const quietSection = rms(decoded, 0.62, 0.92);
    const ratio = Math.max(loudSection, quietSection) / Math.max(1e-6, Math.min(loudSection, quietSection));
    return { loudSection, quietSection, ratio: Number(ratio.toFixed(3)) };
  }

  const uploadTo = (input, file) => { const dt = new DataTransfer(); dt.items.add(file); input.files = dt.files; input.dispatchEvent(new Event("change", { bubbles: true })); };
  const selectValue = (el, value) => { el.value = value; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); };

  await waitFor(() => window.PDC && document.querySelector('[data-file-bucket="host"]') && document.querySelector("#audio-leveling"), "audio quality controls should exist");

  const hostFile = await makeSpeakerVideo("host-loud.webm", "#b91c1c", "host");
  const guestFile = await makeSpeakerVideo("guest-quiet.webm", "#047857", "guest");
  const hostDecoded = await decodeBlob(hostFile);
  const guestDecoded = await decodeBlob(guestFile);
  const rawLoud = rms(hostDecoded, 0.12, 0.42);
  const rawQuiet = rms(guestDecoded, 0.62, 0.92);
  const rawRatio = rawLoud / Math.max(1e-6, rawQuiet);
  assert(rawRatio > 5, "generated raw speakers should start mismatched, ratio=" + rawRatio);

  uploadTo(document.querySelector('[data-file-bucket="host"]'), hostFile);
  await sleep(120);
  uploadTo(document.querySelector('[data-file-bucket="guest1"]'), guestFile);
  await sleep(1300);

  document.querySelector('[data-preset="stack"]').click();
  await sleep(220);
  assert(document.querySelector("#stage-canvas").dataset.preset === "stack", "Stack should be selected before audio export");

  const leveling = document.querySelector("#audio-leveling");
  if (!leveling.checked) leveling.click();
  selectValue(document.querySelector("#audio-clarity"), "clear");
  selectValue(document.querySelector("#audio-noise-reduction"), "gentle");
  await sleep(100);
  assert(leveling.checked, "leveling control should be selected");
  assert(document.querySelector("#audio-clarity").value === "clear", "clarity selection should be stored");
  assert(document.querySelector("#audio-noise-reduction").value === "gentle", "noise reduction selection should be stored");
  assert(/Balanced loudness/.test(document.querySelector("#audio-quality-summary").textContent), "summary should show leveling");

  async function runExport(label) {
    const result = document.querySelector("#export-result");
    result.hidden = true; result.innerHTML = "";
    await waitFor(() => !document.querySelector("#export").disabled, label + ": export should be enabled");
    document.querySelector("#export").click();
    await waitFor(
      () => document.querySelector("#export-download") && document.querySelector("#export-playback"),
      label + ": export should produce a downloadable result",
      700,
    );
    const text = document.querySelector("#export-result").textContent || "";
    assert(/Balanced loudness/.test(text), label + ": export result should name leveling");
    assert(/Clear voices/.test(text), label + ": export result should name clarity");
    assert(/Gentle noise reduction/.test(text), label + ": export result should name noise reduction");
    const href = document.querySelector("#export-download").getAttribute("href");
    const blob = await (await fetch(href)).blob();
    assert(blob.size > 2048, label + ": exported file should carry real bytes");
    const decoded = await decodeBlob(blob);
    const report = loudnessReport(decoded);
    assert(report.loudSection > 1e-4 && report.quietSection > 1e-4, label + ": exported audio should be non-silent");
    assert(report.ratio < rawRatio * 0.45, label + ": leveling should improve raw ratio " + rawRatio + " -> " + report.ratio);
    assert(report.ratio < 2.35, label + ": leveled speaker sections should be close, ratio=" + report.ratio);
    return { bytes: blob.size, samples: decoded.length, loudness: report, downloadName: document.querySelector("#export-download").getAttribute("download") };
  }

  const first = await runExport("first export");
  document.querySelector('[data-preset="spotlight"]').click();
  await sleep(240);
  assert(document.querySelector("#stage-canvas").dataset.preset === "spotlight", "Spotlight should apply before second export");
  assert(document.querySelector("#audio-leveling").checked, "leveling should persist after preset switch");
  assert(document.querySelector("#audio-clarity").value === "clear", "clarity should persist after preset switch");
  assert(document.querySelector("#audio-noise-reduction").value === "gentle", "noise reduction should persist after preset switch");
  const second = await runExport("second export");
  assert(/spotlight/.test(second.downloadName || ""), "second export should reflect the switched layout");

  return {
    rawRatio: Number(rawRatio.toFixed(3)),
    firstExport: first,
    secondExport: second,
    settingsAfterSwitch: {
      leveling: document.querySelector("#audio-leveling").checked,
      clarity: document.querySelector("#audio-clarity").value,
      noiseReduction: document.querySelector("#audio-noise-reduction").value,
    },
  };
})()
`;

async function main() {
  const chrome = findChrome();
  const port = await getFreePort();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdc-audio-quality-"));
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
    const result = await send("Runtime.evaluate", { expression: browserExpression, awaitPromise: true, returnByValue: true, timeout: 75000 });
    ws.close();
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    console.log("verify-audio-quality: OK");
    console.log(JSON.stringify(result.result.value, null, 2));
  } finally {
    await stopChrome(child);
    await removeDirEventually(profileDir);
  }
}

main().catch((e) => { console.error(`verify-audio-quality: ${e.message}`); process.exit(1); });
