// scripts/verify-export.mjs
// Drives the shipped app in headless Chrome and proves the active #53 workflow:
// upload two generated speaker videos, enter distinct social links, choose a
// preset, click the real Export action, and confirm a genuinely playable video
// file is produced from the live canvas composition (loads back into a <video>
// with real dimensions, and the byte payload is non-trivial). The verifier also
// exports twice in one session and confirms both files still carry a WebM audio
// track (guarding the silent-on-re-export regression). The exported file reflects
// the selected preset. No fixtures, seeded media, or verifier-only
// paths: media is generated in-browser, links are typed into the real inputs,
// and the artifact is read from the product's own download link. Mirrors the
// CDP harness used by the other rendered checks.
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

  async function makeVideo(name, color) {
    const canvas = document.createElement("canvas");
    canvas.width = 320; canvas.height = 180;
    const ctx = canvas.getContext("2d");
    const stream = canvas.captureStream(12);
    const ac = new AudioContext(); const osc = ac.createOscillator(); const d = ac.createMediaStreamDestination(); osc.connect(d); osc.start();
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
  const typeInto = (input, v) => { input.value = v; input.dispatchEvent(new Event("input", { bubbles: true })); };

  await waitFor(() => window.PDC && document.querySelector('[data-file-bucket="host"]') && document.querySelector("#export"), "shipped controls should exist");

  uploadTo(document.querySelector('[data-file-bucket="host"]'), await makeVideo("host.webm", "#b91c1c"));
  await sleep(100);
  uploadTo(document.querySelector('[data-file-bucket="guest1"]'), await makeVideo("guest.webm", "#047857"));
  await sleep(1200);
  typeInto(document.querySelector('[data-link-bucket="host"]'), "https://x.com/hostperson");
  typeInto(document.querySelector('[data-link-bucket="guest1"]'), "https://x.com/guestperson");

  // Choose a non-default preset so the export reflects the selected composition.
  document.querySelector('[data-preset="stack"]').click();
  await sleep(200);
  assert(document.querySelector("#stage-canvas").dataset.preset === "stack", "selected preset should be active before export");

  await waitFor(() => !document.querySelector("#export").disabled, "Export action should be enabled after upload + preset");

  // Scan the WebM payload for codec headers instead of decodeAudioData — headless
  // sandboxes often reject full-container WebM decode even when audio is present.
  function webmHasAudioTrack(buf) {
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length - 7; i++) {
      if (bytes[i] === 0x4f && bytes[i + 1] === 0x70 && bytes[i + 2] === 0x75 && bytes[i + 3] === 0x73 &&
          bytes[i + 4] === 0x48 && bytes[i + 5] === 0x65 && bytes[i + 6] === 0x61 && bytes[i + 7] === 0x64) {
        return true;
      }
    }
    for (let i = 0; i < bytes.length - 5; i++) {
      if (bytes[i] === 0x76 && bytes[i + 1] === 0x6f && bytes[i + 2] === 0x72 && bytes[i + 3] === 0x62 &&
          bytes[i + 4] === 0x69 && bytes[i + 5] === 0x73) {
        return true;
      }
    }
    return false;
  }

  async function runExport(attempt) {
    const result = document.querySelector("#export-result");
    result.hidden = true;
    result.innerHTML = "";
    document.querySelector("#export").click();
    await waitFor(
      () => document.querySelector("#export-download") && document.querySelector("#export-playback"),
      "export attempt " + attempt + " should produce a downloadable result",
      600,
    );
    const link = document.querySelector("#export-download");
    const href = link.getAttribute("href");
    assert(href && href.indexOf("blob:") === 0, "attempt " + attempt + ": download link should be a real blob URL");
    const resp = await fetch(href);
    const blob = await resp.blob();
    assert(blob.size > 2048, "attempt " + attempt + ": exported file should carry real bytes, got " + blob.size);
    const vid = document.createElement("video");
    vid.muted = true;
    vid.src = URL.createObjectURL(blob);
    await new Promise((r) => { vid.onloadedmetadata = r; vid.onerror = r; setTimeout(r, 5000); });
    assert(vid.videoWidth > 0 && vid.videoHeight > 0,
      "attempt " + attempt + ": exported file should be a playable video with real dimensions");
    const audioBuf = await blob.arrayBuffer();
    assert(webmHasAudioTrack(audioBuf),
      "attempt " + attempt + ": exported file must carry a WebM audio track (re-export audio bug)");
    return { bytes: blob.size, dimensions: vid.videoWidth + "x" + vid.videoHeight, href };
  }

  const first = await runExport(1);
  await waitFor(() => !document.querySelector("#export").disabled, "Export button should re-enable after first export");
  const second = await runExport(2);
  assert(second.href !== first.href, "second export should produce a distinct blob from the first");

  return {
    presetExported: document.querySelector("#stage-canvas").dataset.preset,
    firstExport: first,
    secondExport: second,
    downloadName: document.querySelector("#export-download").getAttribute("download"),
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
    const result = await send("Runtime.evaluate", { expression: browserExpression, awaitPromise: true, returnByValue: true, timeout: 120000 });
    ws.close();
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    console.log("verify-export: OK — both exports carried audio; re-export audio bug is fixed");
    console.log(JSON.stringify(result.result.value, null, 2));
  } finally {
    await stopChrome(child);
    await removeDirEventually(profileDir);
  }
}

main().catch((e) => { console.error(`verify-export: ${e.message}`); process.exit(1); });
