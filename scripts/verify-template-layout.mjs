// scripts/verify-template-layout.mjs
// Headless Chrome check for the reusable custom speaker-layout workflow.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function findChrome() {
  const candidates = [process.env.CHROME_BIN, "google-chrome", "chromium", "chromium-browser"].filter(Boolean);
  for (const candidate of candidates) {
    if (spawnSync(candidate, ["--version"], { encoding: "utf8" }).status === 0) return candidate;
  }
  throw new Error("Chrome/Chromium not found");
}

function getPort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const address = s.address();
      s.close(() => resolve(address.port));
    });
  });
}

async function fetchJson(url, attempts = 60) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
      last = new Error(`HTTP ${res.status}`);
    } catch (err) {
      last = err;
    }
    await sleep(250);
  }
  throw last;
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
  return {
    ws,
    ready,
    send(method, params = {}) {
      const callId = ++id;
      ws.send(JSON.stringify({ id: callId, method, params }));
      return new Promise((resolve, reject) => pending.set(callId, { resolve, reject }));
    },
  };
}

const browserExpression = `
(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const assert = (c, m) => { if (!c) throw new Error(m); };
  async function makeVideo(name, color) {
    const canvas = document.createElement("canvas");
    canvas.width = 320; canvas.height = 180;
    const ctx = canvas.getContext("2d");
    const stream = canvas.captureStream(12);
    const rec = new MediaRecorder(stream, { mimeType: "video/webm" });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.start();
    for (let i = 0; i < 20; i++) { ctx.fillStyle = color; ctx.fillRect(0,0,320,180); ctx.fillStyle="#fff"; ctx.fillText(name, 20, 80); await sleep(45); }
    await new Promise((r) => { rec.onstop = r; rec.stop(); });
    stream.getTracks().forEach((t) => t.stop());
    return new File(chunks, name, { type: "video/webm" });
  }
  const uploadTo = (input, file) => { const dt = new DataTransfer(); dt.items.add(file); input.files = dt.files; input.dispatchEvent(new Event("change", { bubbles: true })); };
  const drag = async (target, from, to) => {
    target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, pointerType: "mouse", buttons: 1, clientX: from.x, clientY: from.y }));
    window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1, pointerType: "mouse", buttons: 1, clientX: to.x, clientY: to.y }));
    window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, pointerType: "mouse", buttons: 0, clientX: to.x, clientY: to.y }));
    await sleep(150);
  };
  const waitFor = async (fn, label, tries = 200) => { for (let i = 0; i < tries; i++) { if (fn()) return; await sleep(50); } throw new Error(label); };
  await waitFor(() => document.querySelector('#open-editor'), "app");
  uploadTo(document.querySelector('[data-file-bucket="host"]'), await makeVideo("host.webm", "#b91c1c"));
  await sleep(100);
  uploadTo(document.querySelector('[data-file-bucket="guest1"]'), await makeVideo("guest.webm", "#047857"));
  await sleep(1000);
  document.querySelector('#open-editor').click();
  await sleep(200);
  const hostFrame = document.querySelector('.layout-frame[data-bucket="host"]');
  const hostBox = hostFrame.getBoundingClientRect();
  const startLeft = parseFloat(hostFrame.style.left);
  const startWidth = parseFloat(hostFrame.style.width);
  await drag(hostFrame, { x: hostBox.left + hostBox.width / 2, y: hostBox.top + hostBox.height / 2 }, { x: hostBox.left + hostBox.width / 2 + 80, y: hostBox.top + hostBox.height / 2 + 30 });
  const handle = document.querySelector('.layout-frame[data-bucket="host"] .frame-handle');
  const handleBox = handle.getBoundingClientRect();
  await drag(handle, { x: handleBox.left + handleBox.width / 2, y: handleBox.top + handleBox.height / 2 }, { x: handleBox.left + handleBox.width / 2 + 60, y: handleBox.top + handleBox.height / 2 + 24 });
  assert(parseFloat(hostFrame.style.left) !== startLeft, "host should move");
  assert(parseFloat(hostFrame.style.width) !== startWidth, "host should resize");
  document.querySelector('#template-name').value = 'Interview A';
  document.querySelector('#save-template').click();
  await sleep(200);
  assert(document.querySelector('#template-list').textContent.includes('Interview A'), "template should save");
  document.querySelector('[data-preset="stack"]').click();
  await sleep(200);
  assert(document.querySelector('#stage-canvas').dataset.layoutMode === 'preset', "preset switch should work");
  document.querySelector('#template-list button').click();
  await sleep(200);
  assert(document.querySelector('#stage-canvas').dataset.layoutMode === 'template', "template should reapply");
  assert(document.querySelector('#stage-canvas').dataset.layoutSource === 'Interview A', "template name should render");
  return { mode: document.querySelector('#stage-canvas').dataset.layoutMode, source: document.querySelector('#stage-canvas').dataset.layoutSource };
})()
`;

async function main() {
  const chrome = findChrome();
  const port = await getPort();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdc-template-"));
  const child = spawn(chrome, ["--headless=new", "--no-sandbox", "--disable-gpu", "--autoplay-policy=no-user-gesture-required", "--allow-file-access-from-files", `--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`, pathToFileURL(path.join(root, "index.html")).href]);
  try {
    const targets = await fetchJson(`http://127.0.0.1:${port}/json`);
    const page = targets.find((t) => t.type === "page");
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
    await sleep(1000);
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch {}
  }
}

main().catch((error) => {
  console.error(`verify-template-layout: ${error.message}`);
  process.exit(1);
});
