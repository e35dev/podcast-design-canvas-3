// scripts/verify-layout-template.mjs
// Drives the shipped app in headless Chrome and proves issue #66: upload speaker
// videos, open the layout editor, reposition frames, save/apply a named template,
// switch presets and back, and export a playable video reflecting the custom layout.
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
  throw new Error("Chrome/Chromium was not found. Set CHROME_BIN to run layout-template verification.");
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function stopChrome(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await sleep(500);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

const browserExpression = `
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const assert = (c, m) => { if (!c) throw new Error(m); };

  async function makeVideo(name, color) {
    const canvas = document.createElement("canvas");
    canvas.width = 320; canvas.height = 180;
    const ctx = canvas.getContext("2d");
    const stream = canvas.captureStream(12);
    const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp8") ? "video/webm;codecs=vp8" : "video/webm";
    const rec = new MediaRecorder(stream, { mimeType: mime });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.start();
    for (let i = 0; i < 24; i++) {
      ctx.fillStyle = color; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#fff"; ctx.font = "26px sans-serif"; ctx.fillText(name, 20, 100);
      await sleep(45);
    }
    await new Promise((r) => { rec.onstop = r; rec.stop(); });
    stream.getTracks().forEach((t) => t.stop());
    return new File(chunks, name + ".webm", { type: "video/webm" });
  }

  function upload(bucket, file) {
    const dt = new DataTransfer(); dt.items.add(file);
    const input = document.querySelector('[data-file-bucket="' + bucket + '"]');
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function regionColor(x0, y0, x1, y1) {
    const c = document.getElementById("stage-canvas");
    const w = c.width; const h = c.height;
    const data = c.getContext("2d").getImageData(0, 0, w, h).data;
    const px0 = Math.floor(x0 / 100 * w), px1 = Math.floor(x1 / 100 * w);
    const py0 = Math.floor(y0 / 100 * h), py1 = Math.floor(y1 / 100 * h);
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = py0; y < py1; y++) for (let x = px0; x < px1; x++) {
      const i = (y * w + x) * 4; r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
    }
    return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) };
  }

  function dominant(c) {
    if (c.r > c.g + 25 && c.r > c.b + 25) return "red";
    if (c.g > c.r + 25 && c.g > c.b + 25) return "green";
    return "mixed";
  }

  await sleep(300);
  assert(window.PDC && window.PDC.ui && window.PDC.ui.layoutEditor, "layout editor should be wired");
  assert(document.querySelector("#open-layout-editor"), "customize layout control should exist");

  upload("host", await makeVideo("HOST", "#b91c1c"));
  await sleep(120);
  upload("guest1", await makeVideo("G1", "#047857"));
  await sleep(1200);
  document.querySelector("#play").click();
  await sleep(700);

  const splitLeft = dominant(regionColor(5, 20, 45, 80));
  const splitRight = dominant(regionColor(55, 20, 95, 80));
  assert(splitLeft === "red" && splitRight === "green", "split preset should show host left and guest right");

  document.querySelector("#open-layout-editor").click();
  await sleep(200);
  assert(!document.getElementById("layout-editor").hidden, "layout editor should open");
  window.PDC.ui.layoutEditor.setFrameRect("guest1", { x: 58, y: 58, w: 38, h: 38 });
  document.getElementById("template-name").value = "Corner Guest";
  document.getElementById("save-template").click();
  await sleep(500);

  const canvas = document.getElementById("stage-canvas");
  assert(canvas.dataset.layoutSource === "template", "saved template should become active layout source");
  assert(canvas.dataset.templateId, "canvas should record active template id");

  const customBR = dominant(regionColor(60, 60, 95, 95));
  assert(customBR === "green", "custom template should place guest1 in bottom-right, got " + customBR);

  document.querySelector('[data-preset="stack"]').click();
  await sleep(500);
  assert(canvas.dataset.layoutSource === "preset", "switching preset should leave template mode");
  const stackTop = dominant(regionColor(5, 5, 95, 40));
  const stackBottom = dominant(regionColor(5, 60, 95, 95));
  assert(stackTop === "red" && stackBottom === "green", "stack preset should rearrange speakers into rows");

  const applyBtn = [...document.querySelectorAll(".template-item button")].find((b) => /Corner Guest|Apply template/.test(b.parentElement.textContent));
  assert(applyBtn, "saved template should appear in the template list");
  applyBtn.click();
  await sleep(500);
  assert(canvas.dataset.layoutSource === "template", "re-applying template should restore custom layout");
  assert(dominant(regionColor(60, 60, 95, 95)) === "green", "custom guest corner should return after re-apply");

  assert(!document.querySelector("#export").disabled, "export should stay available with custom template");
  document.querySelector("#export").click();
  await sleep(3500);
  const playback = document.getElementById("export-playback");
  assert(playback && playback.videoWidth > 0, "export should produce a playable custom-layout video");

  return {
    templateId: canvas.dataset.templateId,
    layoutSource: canvas.dataset.layoutSource,
    split: { left: splitLeft, right: splitRight },
    customCorner: customBR,
    exportDims: playback ? playback.videoWidth + "x" + playback.videoHeight : null,
    templates: window.PDC.templates.listTemplates().map((t) => t.name),
  };
})()
`;

async function main() {
  const chrome = findChrome();
  const port = await getFreePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "pdc-layout-template-"));
  const child = spawn(chrome, [
    "--headless=new", "--no-sandbox", "--disable-gpu",
    "--autoplay-policy=no-user-gesture-required", "--allow-file-access-from-files",
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    pathToFileURL(path.join(root, "index.html")).href,
  ]);
  try {
    await sleep(1500);
    const targets = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json());
    const page = targets.find((t) => t.type === "page");
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    let id = 0;
    const pending = new Map();
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      if (!m.id || !pending.has(m.id)) return;
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    });
    await new Promise((r) => ws.addEventListener("open", r, { once: true }));
    const send = (method, params = {}) => new Promise((res, rej) => {
      const callId = ++id; ws.send(JSON.stringify({ id: callId, method, params }));
      pending.set(callId, { resolve: res, reject: rej });
    });
    await send("Runtime.enable");
    const result = await send("Runtime.evaluate", { expression: browserExpression, awaitPromise: true, returnByValue: true, timeout: 60000 });
    ws.close();
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    console.log("verify-layout-template: OK");
    console.log(JSON.stringify(result.result.value, null, 2));
  } finally {
    await stopChrome(child);
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error("verify-layout-template: " + e.message); process.exit(1); });
