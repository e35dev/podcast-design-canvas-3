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
    for (let i = 0; i < 18; i++) {
      ctx.fillStyle = amp > 0.05 ? "#dc2626" : "#2563eb";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#fff";
      ctx.font = "24px sans-serif";
      ctx.fillText(name, 20, 80);
      await sleep(35);
    }
    await new Promise((resolve) => { rec.onstop = resolve; rec.stop(); });
    osc.stop();
    ac.close();
    return new File(chunks, name + ".webm", { type: "video/webm" });
  }
  const loud = await makeVideo("Loud", 0.18);
  const soft = await makeVideo("Soft", 0.02);
  const upload = async (selector, file) => { const input = document.querySelector(selector); const dt = new DataTransfer(); dt.items.add(file); input.files = dt.files; input.dispatchEvent(new Event("change", { bubbles: true })); };
  await upload('[data-file-bucket="host"]', loud);
  await upload('[data-file-bucket="guest1"]', soft);
  await sleep(600);
  assert(!document.querySelector("#play").disabled, "play should be enabled");
  document.querySelector("#audio-leveling").value = "speaker-leveling";
  document.querySelector("#audio-leveling").dispatchEvent(new Event("change", { bubbles: true }));
  await sleep(500);
  const gains = window.PDC.previewController.audioGainState();
  assert(gains.host && gains.guest1, "gain state should include both speakers");
  assert(gains.guest1 > gains.host, "quiet speaker should receive more gain");
  const diff = Math.abs(gains.host - gains.guest1);
  assert(diff > 0.1, "leveling should produce distinct gains");
  document.querySelector("#play").click();
  await sleep(300);
  assert(window.PDC.currentEpisode.audioLeveling === "speaker-leveling", "selection should persist");
  return gains;
})()
`;

async function main() {
  const chrome = findChrome();
  const servePort = await getFreePort();
  const debugPort = await getFreePort();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdc-preview-level-"));
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
  console.log("verify-preview-leveling: OK", JSON.stringify(result.result.value));
  cleanup();
}

main().catch((error) => { console.error(error); process.exit(1); });
