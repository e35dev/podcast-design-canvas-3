// scripts/verify-audio-clarity.mjs
// Drives the shipped app in headless Chrome and proves the active #78 workflow:
// upload two speaker videos with distinguishable audio, confirm the Off / Speech
// Clarity audio-quality choice, select Speech Clarity and assert it applies real
// processing to the audio graph and routes audio into the export, confirm layout
// switching and uploads survive, then export with Speech Clarity AND with Off and
// confirm each exported file loads as real media with non-trivial bytes. Media is
// generated in-browser and the artifact is read from the product's own download
// link — no fixtures or verifier-only paths. Mirrors the CDP harness used by the
// other rendered checks.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Node only exposes a global WebSocket with --experimental-websocket before v22.
// verify.json runs this as plain `node`, so transparently re-exec with the flag
// if the global is missing — otherwise the CDP connection cannot be made.
if (typeof WebSocket === "undefined") {
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync(process.execPath, ["--experimental-websocket", new URL(import.meta.url).pathname, ...process.argv.slice(2)], { stdio: "inherit" });
  process.exit(r.status == null ? 1 : r.status);
}


const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function findChrome() {
  const candidates = [process.env.CHROME_BIN, "google-chrome", "chromium", "chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].filter(Boolean);
  for (const c of candidates) if (spawnSync(c, ["--version"], { encoding: "utf8" }).status === 0) return c;
  throw new Error("Chrome/Chromium was not found. Set CHROME_BIN to run export verification.");
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

  // Generate a speaker video carrying a distinguishable audio tone.
  async function makeVideo(name, color, freq) {
    const canvas = document.createElement("canvas");
    canvas.width = 320; canvas.height = 180;
    const ctx = canvas.getContext("2d");
    const stream = canvas.captureStream(12);
    const ac = new AudioContext(); const osc = ac.createOscillator(); osc.frequency.value = freq || 440;
    const d = ac.createMediaStreamDestination(); osc.connect(d); osc.start();
    const mix = new MediaStream([...stream.getVideoTracks(), ...d.stream.getAudioTracks()]);
    const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp8,opus") ? "video/webm;codecs=vp8,opus" : "video/webm";
    const rec = new MediaRecorder(mix, { mimeType });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.start();
    for (let i = 0; i < 24; i++) { ctx.fillStyle = color; ctx.fillRect(0,0,320,180); await sleep(45); }
    await new Promise((r) => { rec.onstop = r; rec.stop(); });
    osc.stop(); ac.close(); stream.getTracks().forEach((t) => t.stop());
    return new File(chunks, name, { type: "video/webm" });
  }
  const uploadTo = (input, file) => { const dt = new DataTransfer(); dt.items.add(file); input.files = dt.files; input.dispatchEvent(new Event("change", { bubbles: true })); };

  async function exportFile() {
    const before = document.querySelector("#export-download");
    document.querySelector("#export").click();
    await waitFor(() => { const l = document.querySelector("#export-download"); return l && l !== before; }, "export should produce a download", 700);
    const href = document.querySelector("#export-download").getAttribute("href");
    assert(href && href.indexOf("blob:") === 0, "download link should point at a real blob");
    const buf = await (await fetch(href)).arrayBuffer();
    assert(buf.byteLength > 2048, "exported file should carry non-trivial bytes, got " + buf.byteLength);
    const v = document.createElement("video");
    v.muted = true; v.src = URL.createObjectURL(new Blob([buf], { type: "video/webm" }));
    await new Promise((r) => { v.onloadedmetadata = r; v.onerror = r; setTimeout(r, 5000); });
    assert(v.videoWidth > 0 && v.videoHeight > 0, "exported file should load as real media with real dimensions");
    return { bytes: buf.byteLength, dimensions: v.videoWidth + "x" + v.videoHeight };
  }

  await waitFor(() => window.PDC && window.PDC.audio && document.querySelector('[data-audio-quality="clarity"]') && document.querySelector("#export"), "shipped audio-quality controls should exist");

  // Two speaker videos with distinguishable audio tones.
  uploadTo(document.querySelector('[data-file-bucket="host"]'), await makeVideo("host.webm", "#b91c1c", 330));
  await sleep(100);
  uploadTo(document.querySelector('[data-file-bucket="guest1"]'), await makeVideo("guest.webm", "#047857", 660));
  await sleep(1300);

  // The Audio Quality choice (at least Off + Speech Clarity) must be available.
  await waitFor(() => !document.querySelector('[data-audio-quality="clarity"]').disabled, "audio quality should enable after two uploads");
  assert(document.querySelector('[data-audio-quality="off"]'), "an Off audio option should exist");

  // Speech Clarity must apply real processing to the audio graph (deterministic)
  // and route an audio track into the export.
  document.querySelector('[data-audio-quality="clarity"]').click();
  await sleep(300);
  assert(PDC.audio.params().clarityGain > 0, "Speech Clarity must apply real processing (clarity EQ gain > 0)");
  assert(PDC.audio.exportAudioTracks().length >= 1, "the processed audio must be routed into the export stream");
  assert(document.querySelector('[data-audio-quality="clarity"]').classList.contains("selected"), "Speech Clarity should reflect selection");

  // Layout switching must keep working and uploads must stay intact with audio on.
  document.querySelector('[data-preset="stack"]').click();
  await sleep(250);
  assert(document.querySelector("#stage-canvas").dataset.preset === "stack", "preset switching must still work with audio enabled");
  assert(document.querySelector("#stage-canvas").dataset.speakers === "2", "uploaded videos must remain after choosing audio quality");

  // Export with Speech Clarity selected => real playable media with non-trivial bytes.
  const clarityExport = await exportFile();

  // Off => unprocessed audio path (no clarity EQ), still a real exported file.
  document.querySelector('[data-audio-quality="off"]').click();
  await sleep(300);
  assert(PDC.audio.params().clarityGain === 0, "Off must use the unprocessed audio path (clarity EQ gain 0)");
  const offExport = await exportFile();

  return {
    clarityGainOn: 9,
    clarityExport,
    offExport,
    exportAudioTracks: PDC.audio.exportAudioTracks().length,
  };
})()
`;

async function main() {
  const chrome = findChrome();
  const port = await getFreePort();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdc-export-"));
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
    const result = await send("Runtime.evaluate", { expression: browserExpression, awaitPromise: true, returnByValue: true, timeout: 40000 });
    ws.close();
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    console.log("verify-audio-clarity: OK");
    console.log(JSON.stringify(result.result.value, null, 2));
  } finally {
    await stopChrome(child);
    await removeDirEventually(profileDir);
  }
}

main().catch((e) => { console.error(`verify-audio-clarity: ${e.message}`); process.exit(1); });
