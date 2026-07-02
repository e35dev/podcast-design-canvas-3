// scripts/verify-show-templates.mjs
// Headless rendered workflow for Issue #121:
// - Customize a layout, save as a named reusable show template
// - Refresh the app (same browser profile), upload new media
// - Select saved template and confirm it applies to new media with export enabled
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
  for (const c of candidates) if (spawnSync(c, ["--version"], { encoding: "utf8" }).status === 0) return c;
  throw new Error("Chrome/Chromium was not found. Set CHROME_BIN to run show-template verification.");
}
function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      child.off("exit", onExit);
      resolve(ok);
    };
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
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (e) {
      if (i === 7) return;
      await sleep(100 * (i + 1));
    }
  }
}
async function fetchJson(url, attempts = 60) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
      last = new Error("HTTP " + r.status);
    } catch (e) {
      last = e;
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
  const waitFor = async (fn, label, tries) => {
    for (let i = 0; i < (tries || 240); i++) { if (fn()) return; await sleep(50); }
    throw new Error(label);
  };

  async function makeVideo(name, color) {
    const canvas = document.createElement("canvas");
    canvas.width = 320; canvas.height = 180;
    const ctx = canvas.getContext("2d");
    const stream = canvas.captureStream(12);
    const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp8") ? "video/webm;codecs=vp8" : "video/webm";
    const rec = new MediaRecorder(stream, { mimeType });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.start(250);
    for (let i = 0; i < 30; i++) { ctx.fillStyle = color; ctx.fillRect(0,0,320,180); await sleep(60); }
    await new Promise((r) => { rec.onstop = r; rec.stop(); });
    stream.getTracks().forEach((t) => t.stop());
    return new File(chunks, name, { type: "video/webm" });
  }

  const uploadTo = (input, file) => {
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  };

  const typeInto = (input, v) => { input.value = v; input.dispatchEvent(new Event("input", { bubbles: true })); input.dispatchEvent(new Event("change", { bubbles: true })); };

  await waitFor(() => window.PDC && window.PDC.templates && document.querySelector("#customize") && document.querySelector("#new-episode"), "controls should exist");

  // Upload three speakers, open customize, and move/resize Host/Guest1 via click controls.
  uploadTo(document.querySelector('[data-file-bucket="host"]'), await makeVideo("h1.webm", "#d11d1d"));
  await sleep(90);
  uploadTo(document.querySelector('[data-file-bucket="guest1"]'), await makeVideo("g1.webm", "#1d7dd1"));
  await sleep(90);
  uploadTo(document.querySelector('[data-file-bucket="guest2"]'), await makeVideo("g2.webm", "#0f8a4b"));
  await sleep(1300);

  await waitFor(() => !document.querySelector("#customize").disabled, "Customize should enable after uploads");
  document.querySelector("#customize").click();
  await sleep(200);
  const overlay = document.querySelector("#edit-overlay");
  assert(!overlay.hidden, "custom layout editor should open");
  const hostFrame = overlay.querySelector('[data-frame-bucket="host"]');
  const guest1Frame = overlay.querySelector('[data-frame-bucket="guest1"]');
  assert(hostFrame && guest1Frame, "Host and Guest 1 frames should exist");

  async function clickN(bucket, action, n) {
    for (let i = 0; i < n; i++) {
      const btn = overlay.querySelector('[data-nudge="' + bucket + ":" + action + '"]');
      btn.click();
      await sleep(40);
    }
  }

  const hostBefore = { left: parseFloat(hostFrame.style.left), top: parseFloat(hostFrame.style.top), width: parseFloat(hostFrame.style.width) };
  await clickN("host", "down", 4);
  await clickN("host", "smaller", 4);
  await clickN("guest1", "up", 2);
  const hostAfter = { left: parseFloat(hostFrame.style.left), top: parseFloat(hostFrame.style.top), width: parseFloat(hostFrame.style.width) };
  assert(hostAfter.top > hostBefore.top + 10, "Host should move down via editor controls");
  assert(hostAfter.width < hostBefore.width - 5, "Host should shrink via editor controls");

  typeInto(document.querySelector("#template-name"), "Show Template A");
  document.querySelector("#save-template").click();
  await sleep(250);
  assert(overlay.hidden, "editor should close after saving template");

  const tplBtn = [...document.querySelectorAll('#templates [data-layout]')].find((b) => /Show Template A/.test(b.textContent));
  assert(tplBtn, "saved template should appear in template list");
  const tplId = tplBtn.dataset.layout;
  assert(window.PDC.templates.getTemplate(tplId), "template should exist in model");

  // Save a signature of the rects we expect to persist.
  const saved = window.PDC.templates.getTemplate(tplId).rects;

  // Refresh the page: templates must persist, media must NOT.
  location.reload();
  await waitFor(() => window.PDC && window.PDC.templates && document.querySelector('[data-status="host"]'), "app should reload");
  await sleep(200);

  const tplBtn2 = [...document.querySelectorAll('#templates [data-layout]')].find((b) => /Show Template A/.test(b.textContent));
  assert(tplBtn2, "saved template should survive refresh");
  const tplId2 = tplBtn2.dataset.layout;
  const t2 = window.PDC.templates.getTemplate(tplId2);
  assert(t2, "template should be loadable after refresh");
  assert(JSON.stringify(t2.rects.host) === JSON.stringify(saved.host), "saved host rect should persist across refresh");

  // Media must not persist across refresh.
  assert(document.querySelector('[data-status="host"]').textContent === "No file", "old media should not persist (host)");
  assert(document.querySelectorAll(".bucket.filled").length === 0, "no buckets should be filled after refresh");

  // Upload a NEW set of videos and apply the saved template.
  uploadTo(document.querySelector('[data-file-bucket="host"]'), await makeVideo("h2.webm", "#d11d1d"));
  await sleep(90);
  uploadTo(document.querySelector('[data-file-bucket="guest1"]'), await makeVideo("g1b.webm", "#1d7dd1"));
  await sleep(90);
  uploadTo(document.querySelector('[data-file-bucket="guest2"]'), await makeVideo("g2b.webm", "#0f8a4b"));
  await sleep(1300);

  tplBtn2.click();
  await sleep(250);
  const canvas = document.querySelector("#stage-canvas");
  assert(canvas.dataset.preset === tplId2, "selecting template should apply it to the new episode");
  assert(!document.querySelector("#export").disabled, "Export should be enabled with the template selected");

  // Switch away and back: selection should survive and template should still apply.
  document.querySelector('[data-preset="stack"]').click();
  await sleep(250);
  assert(canvas.dataset.preset === "stack", "preset switch should apply");
  tplBtn2.click();
  await sleep(250);
  assert(canvas.dataset.preset === tplId2, "template should re-apply after switching away and back");
  assert(tplBtn2.classList.contains("selected"), "template should remain selected in the UI");

  return { templateId: tplId2, persisted: true };
})()
`;

async function main() {
  const chrome = findChrome();
  const port = await getFreePort();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdc-show-templates-"));
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
    const page = targets.find((t) => t.type === "page");
    if (!page) throw new Error("Chrome did not expose a page target");
    const { ws, ready, send } = connectWebSocket(page.webSocketDebuggerUrl);
    await ready;
    await send("Runtime.enable");
    const result = await send("Runtime.evaluate", {
      expression: browserExpression,
      awaitPromise: true,
      returnByValue: true,
      timeout: 90000,
    });
    ws.close();
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    console.log("verify-show-templates: OK");
    console.log(JSON.stringify(result.result.value, null, 2));
  } finally {
    await stopChrome(child);
    await removeDirEventually(profileDir);
  }
}

main().catch((e) => {
  console.error(`verify-show-templates: ${e.message}`);
  process.exit(1);
});

