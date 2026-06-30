// scripts/verify-template-layout.mjs
// Drives the shipped app in headless Chrome and proves the reusable custom
// speaker-layout workflow: upload two generated videos, open the canvas editor,
// drag and resize frames, save the arrangement as a named template, switch away
// to a preset, re-apply the template, and export the result from the live canvas.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function findChrome() {
  const candidates = [process.env.CHROME_BIN, "google-chrome", "chromium", "chromium-browser", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].filter(Boolean);
  for (const candidate of candidates) {
    if (spawnSync(candidate, ["--version"], { encoding: "utf8" }).status === 0) return candidate;
  }
  throw new Error("Chrome/Chromium was not found. Set CHROME_BIN to run template verification.");
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  const send = (method, params = {}) => {
    const callId = ++id;
    ws.send(JSON.stringify({ id: callId, method, params }));
    return new Promise((resolve, reject) => pending.set(callId, { resolve, reject }));
  };
  return { ws, ready, send };
}

const browserExpression = `
(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const assert = (condition, message) => { if (!condition) throw new Error(message); };

  async function makeVideo(name, color) {
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 180;
    const ctx = canvas.getContext("2d");
    const stream = canvas.captureStream(12);
    const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp8")
      ? "video/webm;codecs=vp8"
      : "video/webm";
    const recorder = new MediaRecorder(stream, { mimeType });
    const chunks = [];
    recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
    recorder.start();
    for (let i = 0; i < 24; i++) {
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#fff";
      ctx.font = "26px sans-serif";
      ctx.fillText(name.slice(0, 20), 20, 78);
      ctx.fillText("frame " + i, 20, 118);
      await sleep(45);
    }
    await new Promise((resolve) => { recorder.onstop = resolve; recorder.stop(); });
    stream.getTracks().forEach((track) => track.stop());
    return new File(chunks, name, { type: "video/webm" });
  }

  const waitFor = async (fn, label, tries = 200) => {
    for (let i = 0; i < tries; i++) { if (fn()) return; await sleep(50); }
    throw new Error(label);
  };

  const uploadTo = (input, file) => {
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  };

  const pointer = (type, x, y) => new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", buttons: type === "pointerup" ? 0 : 1, clientX: x, clientY: y });
  const drag = async (target, from, to) => {
    target.dispatchEvent(pointer("pointerdown", from.x, from.y));
    window.dispatchEvent(pointer("pointermove", to.x, to.y));
    window.dispatchEvent(pointer("pointerup", to.x, to.y));
    await sleep(150);
  };

  await waitFor(() => window.PDC && document.querySelector('#open-editor'), "app shell should load");

  uploadTo(document.querySelector('[data-file-bucket="host"]'), await makeVideo("host.webm", "#b91c1c"));
  await sleep(100);
  uploadTo(document.querySelector('[data-file-bucket="guest1"]'), await makeVideo("guest.webm", "#047857"));
  await sleep(1200);

  document.querySelector('[data-link-bucket="host"]').value = "https://x.com/hostperson";
  document.querySelector('[data-link-bucket="host"]').dispatchEvent(new Event("input", { bubbles: true }));
  document.querySelector('[data-link-bucket="guest1"]').value = "https://x.com/guestperson";
  document.querySelector('[data-link-bucket="guest1"]').dispatchEvent(new Event("input", { bubbles: true }));

  await waitFor(() => !document.querySelector('#open-editor').disabled, "editor should unlock after two uploads");
  document.querySelector('#open-editor').click();
  await sleep(300);

  const hostFrame = document.querySelector('.layout-frame[data-bucket="host"]');
  const hostBox = hostFrame.getBoundingClientRect();
  const initialHostLeft = parseFloat(hostFrame.style.left || "0");
  const initialHostTop = parseFloat(hostFrame.style.top || "0");
  const initialHostWidth = parseFloat(hostFrame.style.width || "0");
  const initialHostHeight = parseFloat(hostFrame.style.height || "0");
  await drag(hostFrame, { x: hostBox.left + hostBox.width / 2, y: hostBox.top + hostBox.height / 2 }, { x: hostBox.left + hostBox.width / 2 + 80, y: hostBox.top + hostBox.height / 2 + 30 });

  const resizeHandle = document.querySelector('.layout-frame[data-bucket="host"] .frame-handle');
  const handleBox = resizeHandle.getBoundingClientRect();
  await drag(resizeHandle, { x: handleBox.left + handleBox.width / 2, y: handleBox.top + handleBox.height / 2 }, { x: handleBox.left + handleBox.width / 2 + 60, y: handleBox.top + handleBox.height / 2 + 24 });

  assert(document.querySelector('#stage-canvas').dataset.layoutMode === 'draft', 'editor edits should render a draft layout');
  const movedHost = document.querySelector('.layout-frame[data-bucket="host"]');
  assert(parseFloat(movedHost.style.left || "0") !== initialHostLeft || parseFloat(movedHost.style.top || "0") !== initialHostTop, 'host frame should move after drag');
  assert(parseFloat(movedHost.style.width || "0") !== initialHostWidth || parseFloat(movedHost.style.height || "0") !== initialHostHeight, 'host frame should resize after handle drag');

  const templateName = 'Interview A';
  document.querySelector('#template-name').value = templateName;
  document.querySelector('#save-template').click();
  await sleep(200);
  assert(document.querySelector('#template-list').textContent.includes(templateName), 'saved template should appear in the template list');
  assert(document.querySelector('#stage-canvas').dataset.layoutMode === 'template', 'saving should apply the new template');

  const savedTemplateButton = [...document.querySelectorAll('#template-list button')].find((btn) => btn.textContent === templateName);
  assert(savedTemplateButton, 'template button should exist');

  document.querySelector('[data-preset="stack"]').click();
  await sleep(200);
  assert(document.querySelector('#stage-canvas').dataset.layoutMode === 'preset', 'preset switch should move away from template');

  savedTemplateButton.click();
  await sleep(250);
  assert(document.querySelector('#stage-canvas').dataset.layoutMode === 'template', 'saved template should be re-applicable');
  assert(document.querySelector('#stage-canvas').dataset.layoutSource === templateName, 'canvas should reflect the saved template name');
  const hostAfter = document.querySelector('.layout-frame[data-bucket="host"]');
  assert(parseFloat(hostAfter.style.left || "0") !== 0 || parseFloat(hostAfter.style.top || "0") !== 0, 'host frame should not remain at the default origin after dragging');

  document.querySelector('#export').click();
  await waitFor(() => document.querySelector('#export-download') && document.querySelector('#export-playback'), 'export should complete from the custom template', 700);
  const link = document.querySelector('#export-download');
  const blob = await (await fetch(link.href)).blob();
  assert(blob.size > 2048, 'exported custom-template video should contain bytes');
  const video = document.createElement('video');
  video.muted = true;
  video.src = URL.createObjectURL(blob);
  await new Promise((resolve) => { video.onloadedmetadata = resolve; video.onerror = resolve; setTimeout(resolve, 5000); });
  assert(video.videoWidth > 0 && video.videoHeight > 0, 'exported file should be playable');

  return {
    layoutMode: document.querySelector('#stage-canvas').dataset.layoutMode,
    layoutSource: document.querySelector('#stage-canvas').dataset.layoutSource,
    bytes: blob.size,
    dimensions: video.videoWidth + 'x' + video.videoHeight,
  };
})()
`;

async function main() {
  const chrome = findChrome();
  const port = await getFreePort();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdc-template-layout-"));
  const entryUrl = pathToFileURL(path.join(root, "index.html")).href;
  const child = spawn(chrome, [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--autoplay-policy=no-user-gesture-required",
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
    const result = await send("Runtime.evaluate", { expression: browserExpression, awaitPromise: true, returnByValue: true, timeout: 45000 });
    ws.close();
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    console.log("verify-template-layout: OK");
    console.log(JSON.stringify(result.result.value, null, 2));
  } finally {
    child.kill("SIGTERM");
    await sleep(1500);
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch {}
  }
}

main().catch((error) => {
  console.error(`verify-template-layout: ${error.message}`);
  process.exit(1);
});
