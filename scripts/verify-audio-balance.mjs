// scripts/verify-audio-balance.mjs
// Drives the shipped app in headless Chrome and proves issue #84's workflow:
// upload TWO generated speaker videos with DIFFERENT audio amplitudes (oscillator
// gains 0.9 vs 0.15) through the real Host/Guest controls, pick a preset, then
// measure each speaker's PREVIEW output RMS via PDC.audio's analysers, click the
// real "Balance speaker audio" control, re-measure, and ASSERT the loudness
// spread is CLOSER (smaller) after leveling while both speakers stay non-silent
// and the uploads + preset are preserved. No fixtures, seeded media, or
// verifier-only paths: media is generated in-browser and balancing is driven
// through the product's own control. Mirrors the CDP harness of the other checks.
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
  throw new Error("Chrome/Chromium was not found. Set CHROME_BIN to run audio-balance verification.");
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

  // Generate a real WebM whose audio track is a steady tone at a chosen
  // amplitude, so the two speakers genuinely arrive at DIFFERENT loudness.
  async function makeVideo(name, color, audioGain) {
    const canvas = document.createElement("canvas");
    canvas.width = 320; canvas.height = 180;
    const ctx = canvas.getContext("2d");
    const stream = canvas.captureStream(12);
    const ac = new AudioContext();
    const osc = ac.createOscillator();
    osc.frequency.value = 220;
    const g = ac.createGain();
    g.gain.value = audioGain;
    const d = ac.createMediaStreamDestination();
    osc.connect(g).connect(d);
    osc.start();
    const mix = new MediaStream([...stream.getVideoTracks(), ...d.stream.getAudioTracks()]);
    const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp8,opus") ? "video/webm;codecs=vp8,opus" : "video/webm";
    const rec = new MediaRecorder(mix, { mimeType });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.start();
    for (let i = 0; i < 28; i++) { ctx.fillStyle = color; ctx.fillRect(0,0,320,180); ctx.fillStyle="#fff"; ctx.font="26px sans-serif"; ctx.fillText("frame "+i, 20, 100); await sleep(45); }
    await new Promise((r) => { rec.onstop = r; rec.stop(); });
    osc.stop(); ac.close(); stream.getTracks().forEach((t) => t.stop());
    return new File(chunks, name, { type: "video/webm" });
  }
  const uploadTo = (input, file) => { const dt = new DataTransfer(); dt.items.add(file); input.files = dt.files; input.dispatchEvent(new Event("change", { bubbles: true })); };

  await waitFor(() => window.PDC && window.PDC.audio && document.querySelector('[data-file-bucket="host"]') && document.querySelector("#balance-audio"), "shipped controls + PDC.audio should exist");

  // Upload two speakers with DIFFERENT audio amplitudes.
  uploadTo(document.querySelector('[data-file-bucket="host"]'), await makeVideo("host.webm", "#b91c1c", 0.9));
  await sleep(120);
  uploadTo(document.querySelector('[data-file-bucket="guest1"]'), await makeVideo("guest.webm", "#047857", 0.15));
  await sleep(1300);

  // Pick a non-default preset and confirm uploads decoded.
  document.querySelector('[data-preset="split"]').click();
  await sleep(150);
  assert(document.querySelector("#stage-canvas").dataset.preset === "split", "selected preset should be active");
  let videos = [...document.querySelectorAll("video[data-speaker]")];
  assert(videos.length === 2, "two uploaded speaker videos should be present, got " + videos.length);
  assert(videos.every((v) => v.src.startsWith("blob:") && v.videoWidth > 0), "uploads should be decoded");

  // Resume the shared mixer and let real audio flow into the analysers.
  await PDC.audio.resume();
  const playBtn = document.querySelector("#play");
  if (playBtn && !playBtn.textContent.includes("Pause")) playBtn.click();
  await sleep(350);

  // Average several analyser reads so a single quiet window doesn't dominate.
  async function measure() {
    const acc = {};
    let n = 0;
    for (let i = 0; i < 8; i++) {
      const l = PDC.audio.levels();
      for (const k of Object.keys(l)) acc[k] = (acc[k] || 0) + l[k];
      n++;
      await sleep(40);
    }
    const out = {};
    for (const k of Object.keys(acc)) out[k] = acc[k] / n;
    return out;
  }

  const before = await measure();
  const bHost = before.host || 0, bGuest = before.guest1 || 0;
  assert(bHost > 0 && bGuest > 0, "both speakers should produce real preview audio before leveling (host=" + bHost + ", guest=" + bGuest + ")");
  const spreadBefore = Math.abs(bHost - bGuest);
  assert(spreadBefore > 1e-4, "uploaded speakers must start at DIFFERENT loudness, spread=" + spreadBefore);

  // Drive the real product control.
  document.querySelector("#balance-audio").click();
  await waitFor(() => { const t = (document.querySelector("#balance-status") || {}).textContent || ""; return /Balanced/.test(t) && t.includes("→"); }, "balance status should report the leveling effect (input->leveled)", 200);
  await sleep(250);

  const after = await measure();
  const aHost = after.host || 0, aGuest = after.guest1 || 0;
  const spreadAfter = Math.abs(aHost - aGuest);

  // Core acceptance: levels are CLOSER after leveling, both still non-silent,
  // and uploads + preset are preserved.
  assert(spreadAfter < spreadBefore, "loudness spread should shrink after leveling (before=" + spreadBefore + ", after=" + spreadAfter + ")");
  assert(aHost > 1e-4 && aGuest > 1e-4, "both speakers should remain non-silent after leveling (host=" + aHost + ", guest=" + aGuest + ")");

  videos = [...document.querySelectorAll("video[data-speaker]")];
  assert(videos.length === 2, "uploads must be preserved through balancing, got " + videos.length);
  assert(videos.every((v) => v.src.startsWith("blob:") && v.videoWidth > 0), "uploads must stay decoded after balancing");
  assert(document.querySelector("#stage-canvas").dataset.preset === "split", "selected preset must survive balancing");

  return {
    before: { host: bHost, guest1: bGuest, spread: spreadBefore },
    after: { host: aHost, guest1: aGuest, spread: spreadAfter },
    spreadShrunkBy: spreadBefore - spreadAfter,
    preset: document.querySelector("#stage-canvas").dataset.preset,
    status: document.querySelector("#balance-status").textContent,
  };
})()
`;

async function main() {
  const chrome = findChrome();
  const port = await getFreePort();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdc-audio-balance-"));
  const entryUrl = pathToFileURL(path.join(root, "index.html")).href;
  const child = spawn(chrome, [
    "--headless=new", "--no-sandbox", "--disable-gpu",
    "--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream",
    "--allow-file-access-from-files",
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
    console.log("verify-audio-balance: OK");
    console.log(JSON.stringify(result.result.value, null, 2));
  } finally {
    await stopChrome(child);
    await removeDirEventually(profileDir);
  }
}

main().catch((e) => { console.error(`verify-audio-balance: ${e.message}`); process.exit(1); });
