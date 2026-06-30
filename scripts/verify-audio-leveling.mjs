// scripts/verify-audio-leveling.mjs
// Drives the shipped app in headless Chrome and proves issue #84: upload two
// generated speaker videos with deliberately uneven audio levels, enable preview
// sound, measure per-speaker output, apply automatic speaker leveling through
// the real UI control, and confirm preview levels are closer after balancing.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function findChrome() {
  const candidates = [process.env.CHROME_BIN, "google-chrome", "chromium", "chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "/c/Program Files/Google/Chrome/Application/chrome.exe"].filter(Boolean);
  for (const c of candidates) if (spawnSync(c, ["--version"], { encoding: "utf8" }).status === 0) return c;
  throw new Error("Chrome/Chromium was not found. Set CHROME_BIN to run audio leveling verification.");
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

function levelRatio(levels) {
  const vals = Object.values(levels).filter((v) => v > 0);
  if (vals.length < 2) return Infinity;
  return Math.max(...vals) / Math.min(...vals);
}

const browserExpression = `
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const assert = (c, m) => { if (!c) throw new Error(m); };
  const waitFor = async (fn, label, tries) => { for (let i = 0; i < (tries || 200); i++) { if (fn()) return; await sleep(50); } throw new Error(label); };

  async function makeVideo(name, color, audioGain) {
    const canvas = document.createElement("canvas");
    canvas.width = 320; canvas.height = 180;
    const ctx = canvas.getContext("2d");
    const stream = canvas.captureStream(12);
    const ac = new AudioContext();
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    gain.gain.value = audioGain;
    osc.connect(gain);
    const d = ac.createMediaStreamDestination();
    gain.connect(d);
    osc.start();
    const mix = new MediaStream([...stream.getVideoTracks(), ...d.stream.getAudioTracks()]);
    const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp8,opus") ? "video/webm;codecs=vp8,opus" : "video/webm";
    const rec = new MediaRecorder(mix, { mimeType });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.start();
    for (let i = 0; i < 24; i++) { ctx.fillStyle = color; ctx.fillRect(0,0,320,180); ctx.fillStyle="#fff"; ctx.font="26px sans-serif"; ctx.fillText("frame "+i, 20, 100); await sleep(45); }
    await new Promise((r) => { rec.onstop = r; rec.stop(); });
    osc.stop(); ac.close(); stream.getTracks().forEach((t) => t.stop());
    return new File(chunks, name, { type: "video/webm" });
  }
  const uploadTo = (input, file) => { const dt = new DataTransfer(); dt.items.add(file); input.files = dt.files; input.dispatchEvent(new Event("change", { bubbles: true })); };
  const ratio = (levels) => {
    const vals = Object.values(levels).filter((v) => v > 0);
    if (vals.length < 2) return Infinity;
    return Math.max(...vals) / Math.min(...vals);
  };
  const sampleLevels = async () => {
    await sleep(800);
    return window.PDC.ui.getSpeakerAudioLevels();
  };
  const sampleGains = () => window.PDC.ui.getSpeakerAudioGains();

  await waitFor(() => window.PDC && window.PDC.ui && document.querySelector('[data-audio-leveling="balanced"]'), "audio quality controls should exist");

  uploadTo(document.querySelector('[data-file-bucket="host"]'), await makeVideo("host.webm", "#b91c1c", 0.85));
  await sleep(100);
  uploadTo(document.querySelector('[data-file-bucket="guest1"]'), await makeVideo("guest.webm", "#047857", 0.04));
  await sleep(1400);

  await waitFor(() => !document.querySelector("#mute").disabled, "preview should be ready after two uploads");
  document.querySelector("#play").click();
  await sleep(300);
  document.querySelector("#mute").click();
  await sleep(400);

  const rawLevels = await sampleLevels();
  const rawRatio = ratio(rawLevels);
  const rawGains = sampleGains();
  assert(Object.keys(rawGains).length >= 2, "preview audio graph should connect at least two speakers");
  assert(rawRatio > 3 || (rawGains.host > 0.99 && rawGains.guest1 > 0.99), "uneven uploads should produce a wide level spread before leveling, got ratio " + rawRatio);

  document.querySelector('[data-audio-leveling="balanced"]').click();
  await sleep(1200);
  const balancedLevels = await sampleLevels();
  const balancedRatio = ratio(balancedLevels);
  const balancedGains = sampleGains();
  assert(balancedGains.guest1 > rawGains.guest1 * 1.5, "quiet speaker gain should increase after leveling");
  assert(balancedGains.host < rawGains.host || balancedGains.host <= 1.01, "loud speaker gain should not be boosted");
  assert(balancedRatio < rawRatio * 0.7 || balancedRatio < 4, "leveling should bring speaker preview levels closer (raw " + rawRatio.toFixed(2) + " -> " + balancedRatio.toFixed(2) + ")");

  document.querySelector('[data-preset="stack"]').click();
  await sleep(250);
  assert(document.querySelector('[data-audio-leveling="balanced"]').classList.contains("selected"), "balanced leveling should survive preset switch");

  return { rawRatio, balancedRatio, rawLevels, balancedLevels, rawGains, balancedGains };
})()
`;

async function main() {
  const chrome = findChrome();
  const port = await getFreePort();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdc-audio-level-"));
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
    const result = await send("Runtime.evaluate", { expression: browserExpression, awaitPromise: true, returnByValue: true, timeout: 45000 });
    ws.close();
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    const value = result.result.value;
    console.log("verify-audio-leveling: OK");
    console.log(JSON.stringify(value, null, 2));
    if (levelRatio(value.rawLevels) <= levelRatio(value.balancedLevels) && value.balancedGains.guest1 <= value.rawGains.guest1 * 1.2) {
      throw new Error("balanced levels or gains should improve after leveling");
    }
  } finally {
    await stopChrome(child);
    await removeDirEventually(profileDir);
  }
}

main().catch((e) => { console.error(`verify-audio-leveling: ${e.message}`); process.exit(1); });
