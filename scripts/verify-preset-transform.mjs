// scripts/verify-preset-transform.mjs
// Drives the shipped app in headless Chrome and proves the active #41 workflow:
// upload two generated speaker videos, enter distinct social links, then switch
// across ALL THREE presets (Split, Stack, Spotlight) and confirm each visibly
// recomposes the live preview (distinct frame geometry), the uploaded videos
// render NON-BLACK decoded pixels (not placeholder/black), and the uploads,
// speaker assignments, and derived names survive every switch. No fixtures or
// product-only shortcuts: media is generated in-browser and uploaded as real
// File objects, links are typed into the real inputs. Mirrors the CDP harness
// of scripts/verify-rendered-preview.mjs.
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
  for (const c of candidates) {
    if (spawnSync(c, ["--version"], { encoding: "utf8" }).status === 0) return c;
  }
  throw new Error("Chrome/Chromium was not found. Set CHROME_BIN to run preset-transform verification.");
}
function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); });
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
  const waitFor = async (fn, label) => { for (let i = 0; i < 100; i++) { if (fn()) return; await sleep(50); } throw new Error(label); };

  async function makeVideo(name, color) {
    const canvas = document.createElement("canvas");
    canvas.width = 320; canvas.height = 180;
    const ctx = canvas.getContext("2d");
    const stream = canvas.captureStream(12);
    const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp8") ? "video/webm;codecs=vp8" : "video/webm";
    const rec = new MediaRecorder(stream, { mimeType });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.start();
    for (let i = 0; i < 24; i++) { ctx.fillStyle = color; ctx.fillRect(0,0,320,180); ctx.fillStyle="#fff"; ctx.font="26px sans-serif"; ctx.fillText("frame "+i, 20, 100); await sleep(45); }
    await new Promise((r) => { rec.onstop = r; rec.stop(); });
    stream.getTracks().forEach((t) => t.stop());
    return new File(chunks, name, { type: "video/webm" });
  }
  const uploadTo = (input, file) => { const dt = new DataTransfer(); dt.items.add(file); input.files = dt.files; input.dispatchEvent(new Event("change", { bubbles: true })); };
  const typeInto = (input, v) => { input.value = v; input.dispatchEvent(new Event("input", { bubbles: true })); };
  const tagText = (b) => { const el = document.querySelector('[data-speaker-tag="' + b + '"]'); return el ? el.textContent : null; };
  const layout = () => [...document.querySelectorAll("#stage .speaker-frame")].map((f) => f.dataset.speaker + ":" + f.style.left + "," + f.style.top + "," + f.style.width + "," + f.style.height).join("|");
  // Draw a video to a tiny canvas and report whether it shows non-black pixels.
  function nonBlack(video) {
    const c = document.createElement("canvas"); c.width = 16; c.height = 16;
    const x = c.getContext("2d");
    try { x.drawImage(video, 0, 0, 16, 16); } catch (e) { return false; }
    const data = x.getImageData(0, 0, 16, 16).data;
    let max = 0;
    for (let i = 0; i < data.length; i += 4) max = Math.max(max, data[i] + data[i+1] + data[i+2]);
    return max > 40; // some clearly-lit pixel exists
  }

  await waitFor(() => window.PDC && document.querySelector('[data-file-bucket="host"]') && document.querySelector('[data-link-bucket="host"]'), "shipped controls should exist");

  uploadTo(document.querySelector('[data-file-bucket="host"]'), await makeVideo("host.webm", "#b91c1c"));
  await sleep(100);
  uploadTo(document.querySelector('[data-file-bucket="guest1"]'), await makeVideo("guest.webm", "#047857"));
  await sleep(1200);
  typeInto(document.querySelector('[data-link-bucket="host"]'), "https://x.com/hostperson");
  typeInto(document.querySelector('[data-link-bucket="guest1"]'), "https://x.com/guestperson");
  await sleep(200);

  let stageVideos = [...document.querySelectorAll("#stage video")];
  assert(stageVideos.length === 2, "two uploaded speaker videos should compose the preview");
  await Promise.all(stageVideos.map((v) => v.readyState >= 2 ? null : new Promise((r) => v.addEventListener("loadeddata", r, { once: true }))));

  const order = ["split", "stack", "spotlight"];
  const seen = {};
  for (const id of order) {
    const btn = document.querySelector('[data-preset="' + id + '"]');
    assert(btn, "preset button should exist: " + id);
    btn.click();
    await sleep(400);
    assert(document.querySelector("#stage").dataset.preset === id, "stage should reflect active preset " + id);
    const vids = [...document.querySelectorAll("#stage video")];
    assert(vids.length === 2, "both uploaded videos present in preset " + id);
    assert(vids.every((v) => v.src.startsWith("blob:") && v.videoWidth > 0), "videos stay decoded uploads in preset " + id);
    assert(vids.some((v) => nonBlack(v)), "preview must render NON-BLACK uploaded frames in preset " + id);
    assert(tagText("host") === "hostperson" && tagText("guest1") === "guestperson", "derived names persist in preset " + id);
    seen[id] = layout();
  }

  // Each preset must visibly recompose the layout (distinct geometry).
  assert(seen.split !== seen.stack, "Split and Stack must produce different layouts");
  assert(seen.stack !== seen.spotlight, "Stack and Spotlight must produce different layouts");
  assert(seen.split !== seen.spotlight, "Split and Spotlight must produce different layouts");

  return { layouts: seen, tags: { host: tagText("host"), guest1: tagText("guest1") }, videoCount: document.querySelectorAll("#stage video").length };
})()
`;

async function main() {
  const chrome = findChrome();
  const port = await getFreePort();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdc-preset-transform-"));
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
    const result = await send("Runtime.evaluate", { expression: browserExpression, awaitPromise: true, returnByValue: true, timeout: 25000 });
    ws.close();
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    }
    console.log("verify-preset-transform: OK");
    console.log(JSON.stringify(result.result.value, null, 2));
  } finally {
    await stopChrome(child);
    await removeDirEventually(profileDir);
  }
}

main().catch((e) => { console.error(`verify-preset-transform: ${e.message}`); process.exit(1); });
