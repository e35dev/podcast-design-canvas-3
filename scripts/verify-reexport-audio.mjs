import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function findChrome() {
  for (const candidate of [process.env.CHROME_BIN, "google-chrome", "chromium", "chromium-browser"].filter(Boolean)) {
    if (spawnSync(candidate, ["--version"], { encoding: "utf8" }).status === 0) return candidate;
  }
  throw new Error("Chrome not found");
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
  return { ready, send(method, params = {}) { const callId = ++id; ws.send(JSON.stringify({ id: callId, method, params })); return new Promise((resolve, reject) => pending.set(callId, { resolve, reject })); } };
}

  const browserExpression = String.raw`
(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const waitFor = async (fn, label, attempts = 200) => {
    for (let i = 0; i < attempts; i++) {
      if (await fn()) return;
      await sleep(50);
    }
    throw new Error(label);
  };
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  async function makeVideo(name, amp) {
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 180;
    const ctx = canvas.getContext("2d");
    const stream = canvas.captureStream(12);
    const ac = new AudioContext();
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    const dest = ac.createMediaStreamDestination();
    osc.frequency.value = 220;
    gain.gain.value = amp;
    osc.connect(gain).connect(dest);
    osc.start();
    const mix = new MediaStream([...stream.getVideoTracks(), ...dest.stream.getAudioTracks()]);
    const rec = new MediaRecorder(mix, { mimeType: "video/webm" });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.start();
    for (let i = 0; i < 16; i++) {
      ctx.fillStyle = amp > 0.05 ? "#dc2626" : "#2563eb";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#fff";
      ctx.font = "24px sans-serif";
      ctx.fillText(name, 20, 80);
      await sleep(40);
    }
    await new Promise((resolve) => { rec.onstop = resolve; rec.stop(); });
    osc.stop();
    ac.close();
    return new File(chunks, name + ".webm", { type: "video/webm" });
  }
  const host = await makeVideo("Host", 0.18);
  const guest = await makeVideo("Guest", 0.04);
  const upload = async (selector, file) => { const input = document.querySelector(selector); const dt = new DataTransfer(); dt.items.add(file); input.files = dt.files; input.dispatchEvent(new Event("change", { bubbles: true })); };
  await upload('[data-file-bucket="host"]', host);
  await upload('[data-file-bucket="guest1"]', guest);
  await sleep(900);
  const exportOnce = async () => {
    document.querySelector("#export").click();
    await waitFor(() => document.querySelector("#export-playback"), "export playback should appear");
    const video = document.querySelector("#export-playback");
    await waitFor(() => video.readyState >= HTMLMediaElement.HAVE_METADATA, "exported video should load");
    assert(video.videoWidth > 0 && video.videoHeight > 0, "exported video should have dimensions");
    const href = document.querySelector("#export-download").href;
    assert(href.startsWith("blob:"), "export download should be a blob URL");
    return { href, duration: video.duration };
  };
  const first = await exportOnce();
  const second = await exportOnce();
  assert(first.duration > 0 && second.duration > 0, "both exports should load playable media");
  return { first, second };
})()
`;

async function main() {
  const chrome = findChrome();
  const servePort = await getFreePort();
  const debugPort = await getFreePort();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdc-reexport-audio-"));
  const server = spawn(process.execPath, [path.join(root, "scripts", "serve.mjs"), String(servePort)], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  const browser = spawn(chrome, ["--headless=new", "--no-sandbox", "--disable-gpu", "--autoplay-policy=no-user-gesture-required", "--allow-file-access-from-files", `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profileDir}`, `http://127.0.0.1:${servePort}`], { stdio: ["ignore", "pipe", "pipe"] });
  const cleanup = () => { server.kill("SIGTERM"); browser.kill("SIGTERM"); };
  process.on("exit", cleanup);
  await sleep(1000);
  const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
  const page = targets.find((t) => t.type === "page");
  const cdp = connectWebSocket(page.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send("Runtime.enable");
  const result = await cdp.send("Runtime.evaluate", { expression: browserExpression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "browser assertion failed");
  console.log("verify-reexport-audio: OK", JSON.stringify(result.result.value));
  cleanup();
}

main().catch((error) => { console.error(error); process.exit(1); });
