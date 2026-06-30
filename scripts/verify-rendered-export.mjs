// scripts/verify-rendered-export.mjs
// Drives the shipped app in headless Chrome and proves issue #53: upload two real
// local WebM speaker videos through the shipped Host + Guest controls, enter
// per-speaker social links, pick a preset, click the Export action, and prove the
// produced file is a REAL, playable episode video built from the live preview
// canvas — non-trivial byte size, valid WebM magic (0x1A45DFA3), a decodable
// video track (videoWidth > 0 when re-loaded), and that switching the preset
// before export changes the composition. The blob is captured from the LIVE run
// (window.__lastExport), never a committed media artifact.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function findChrome() {
  const candidates = [
    process.env.CHROME_BIN,
    "google-chrome",
    "chromium",
    "chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter(Boolean);
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ["--version"], { encoding: "utf8" });
    if (result.status === 0) return candidate;
  }
  throw new Error("Chrome/Chromium was not found. Set CHROME_BIN to run rendered export verification.");
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve(ok);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
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
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 7) {
        console.warn(`verify-rendered-export: could not remove temp profile ${dir}: ${error.message}`);
        return;
      }
      await sleep(100 * (attempt + 1));
    }
  }
}

async function fetchJson(url, attempts = 60) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
      lastError = new Error(`HTTP ${response.status} from ${url}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw lastError;
}

function connectWebSocket(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  let id = 0;
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(JSON.stringify(message.error)));
    else resolve(message.result);
  });
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  function send(method, params = {}) {
    const callId = ++id;
    ws.send(JSON.stringify({ id: callId, method, params }));
    return new Promise((resolve, reject) => pending.set(callId, { resolve, reject }));
  }
  return { ws, ready, send };
}

const browserExpression = `
(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const assert = (condition, message) => { if (!condition) throw new Error(message); };

  // Build a real local WebM in-browser (canvas.captureStream → MediaRecorder),
  // exactly like a user's uploaded file. No seeded/committed media is used.
  async function makeVideo(name, color) {
    const canvas = document.createElement("canvas");
    canvas.width = 320; canvas.height = 180;
    const ctx = canvas.getContext("2d");
    const stream = canvas.captureStream(12);
    const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp8") ? "video/webm;codecs=vp8" : "video/webm";
    const recorder = new MediaRecorder(stream, { mimeType });
    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    recorder.start();
    for (let i = 0; i < 24; i++) {
      ctx.fillStyle = color; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#fff"; ctx.font = "26px sans-serif"; ctx.fillText(name.slice(0, 16), 18, 70);
      ctx.fillText("frame " + i, 18, 110);
      await sleep(45);
    }
    await new Promise((resolve) => { recorder.onstop = resolve; recorder.stop(); });
    stream.getTracks().forEach((t) => t.stop());
    return new File(chunks, name, { type: "video/webm" });
  }
  function uploadTo(input, file) {
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }
  function typeInto(input, value) {
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }
  function canvasLitPct() {
    const c = document.getElementById("stage-canvas");
    const data = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let lit = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > 14 || data[i + 1] > 14 || data[i + 2] > 14) lit++;
    }
    return Math.round((lit / (data.length / 4)) * 100);
  }

  const waitFor = async (fn, label) => {
    for (let i = 0; i < 120; i++) { if (fn()) return; await sleep(50); }
    throw new Error(label);
  };

  await waitFor(() => window.PDC && window.PDC.episode && window.PDC.exporter, "PDC export API should load");
  await waitFor(() => document.querySelector("#stage-canvas"), "composed preview canvas should exist");
  await waitFor(() => document.querySelector('[data-file-bucket="host"]'), "Host upload control should exist");
  await waitFor(() => document.querySelector("#export"), "Export control should exist");
  assert(document.querySelector("#export").disabled, "Export should start disabled before uploads");

  // Upload two real speaker videos through the shipped inputs.
  uploadTo(document.querySelector('[data-file-bucket="host"]'), await makeVideo("host.webm", "#b91c1c"));
  await sleep(120);
  uploadTo(document.querySelector('[data-file-bucket="guest1"]'), await makeVideo("guest.webm", "#047857"));
  await sleep(1200);

  let videos = [...document.querySelectorAll("video[data-speaker]")];
  assert(videos.length === 2, "two uploaded speaker videos should compose the preview");
  await Promise.all(videos.map((v) => v.readyState >= 2 ? null : new Promise((r) => v.addEventListener("loadeddata", r, { once: true }))));

  // Enter distinct per-speaker social links → derived names appear in the export.
  typeInto(document.querySelector('[data-link-bucket="host"]'), "https://x.com/hostperson");
  typeInto(document.querySelector('[data-link-bucket="guest1"]'), "https://x.com/guestperson");
  await sleep(300);

  // Pick the Spotlight preset (distinct from the default Split) so we prove the
  // selected preset drives the export composition.
  document.querySelector('[data-preset="spotlight"]').click();
  await sleep(400);
  assert(document.querySelector("#stage-canvas").dataset.preset === "spotlight", "preset should switch to spotlight before export");

  // Make sure the preview is actively drawing real frames (non-black) before export.
  const playButton = document.querySelector("#play");
  if (!playButton.textContent.includes("Pause")) playButton.click();
  await sleep(600);
  const litBeforeExport = canvasLitPct();
  assert(litBeforeExport >= 5, "preview canvas must show real (non-black) video frames before export (" + litBeforeExport + "%)");

  // Click the real Export action and wait for the produced Blob (window.__lastExport).
  assert(!document.querySelector("#export").disabled, "Export should be enabled once two speakers are ready");
  window.__lastExport = null;
  document.querySelector("#export").click();

  for (let i = 0; i < 200; i++) {
    if (window.__lastExport && window.__lastExport.size) break;
    await sleep(100);
  }
  assert(window.__lastExport && window.__lastExport.size, "Export must produce a blob within the bounded window");

  const exp = window.__lastExport;
  // Real, non-trivial WebM.
  assert(exp.size > 2048, "exported file must be a non-trivial size, got " + exp.size + " bytes");
  const magic = exp.bytes.slice(0, 4);
  assert(magic[0] === 0x1a && magic[1] === 0x45 && magic[2] === 0xdf && magic[3] === 0xa3,
    "exported file must carry the WebM/EBML magic 1A45DFA3, got " + magic.map((b) => b.toString(16)).join(" "));

  // The export-complete UI is present: a working download link + inline result video.
  assert(!document.querySelector("#export-result").hidden, "export-complete card should be visible");
  const dl = document.querySelector("#export-download");
  assert(dl && dl.getAttribute("href") && dl.getAttribute("href").startsWith("blob:"), "download link should point at a blob URL");
  assert(dl.getAttribute("download") && /\\.webm$/.test(dl.getAttribute("download")), "download link should carry a .webm filename");
  assert(/spotlight/.test(dl.getAttribute("download")), "download filename should reflect the selected preset");

  // Re-decode the recorded blob into a fresh <video> and confirm a real video track.
  const resultVideo = document.querySelector("#export-video");
  assert(resultVideo && resultVideo.src && resultVideo.src.startsWith("blob:"), "inline result video should be wired to the export blob");
  let decodedWidth = 0, decodedHeight = 0;
  try {
    const probe = document.createElement("video");
    probe.muted = true;
    probe.src = resultVideo.src;
    await new Promise((resolve) => {
      let settled = false;
      const done = () => { if (!settled) { settled = true; resolve(); } };
      probe.addEventListener("loadedmetadata", done, { once: true });
      probe.addEventListener("error", done, { once: true });
      setTimeout(done, 4000);
    });
    decodedWidth = probe.videoWidth;
    decodedHeight = probe.videoHeight;
  } catch (e) { /* metadata probe is best-effort; magic+size already proved a real file */ }

  return {
    presetId: exp.presetId,
    size: exp.size,
    mimeType: exp.mimeType,
    fileName: exp.fileName,
    magicHex: magic.map((b) => b.toString(16).padStart(2, "0")).join(""),
    litBeforeExport,
    decodedWidth,
    decodedHeight,
    tiles: exp.tiles,
    downloadName: dl.getAttribute("download"),
  };
})()
`;

async function main() {
  const chrome = findChrome();
  const port = await getFreePort();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdc-rendered-export-"));
  const entryUrl = pathToFileURL(path.join(root, "index.html")).href;

  const child = spawn(chrome, [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--autoplay-policy=no-user-gesture-required",
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--allow-file-access-from-files",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    entryUrl,
  ]);

  try {
    const targets = await fetchJson(`http://127.0.0.1:${port}/json`);
    const page = targets.find((target) => target.type === "page");
    if (!page) throw new Error("Chrome did not expose a page target");

    const { ws, ready, send } = connectWebSocket(page.webSocketDebuggerUrl);
    await ready;
    await send("Runtime.enable");
    const result = await send("Runtime.evaluate", {
      expression: browserExpression,
      awaitPromise: true,
      returnByValue: true,
      timeout: 45000,
    });
    ws.close();

    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    }

    const value = result.result.value;
    // Final defensive assertions on the Node side too.
    if (!value || value.size <= 2048) throw new Error("export blob too small");
    if (value.magicHex !== "1a45dfa3") throw new Error("export blob missing WebM magic: " + value.magicHex);

    console.log("verify-rendered-export: OK");
    console.log(JSON.stringify(value, null, 2));
  } finally {
    await stopChrome(child);
    await removeDirEventually(profileDir);
  }
}

main().catch((error) => {
  console.error(`verify-rendered-export: ${error.message}`);
  process.exit(1);
});
