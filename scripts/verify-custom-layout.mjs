// scripts/verify-custom-layout.mjs
// Drives the shipped app in headless Chrome and proves the active #66 workflow:
// upload two speaker videos, open the custom layout editor, RESIZE and DRAG the
// Host frame with real mouse events, confirm the live preview renders the moved
// Host video, save the arrangement as a named reusable template, confirm the
// applied template renders the saved positions, survive a preset round-trip, and
// export a genuinely playable video while the custom template is selected. Media
// is generated in-browser and the artifact is read from the product's own
// download link — no fixtures, seeded media, or verifier-only paths. Mirrors the
// CDP harness used by the other rendered checks.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Node only exposes a global WebSocket with --experimental-websocket before v22.
// verify.json runs this as plain `node`, so transparently re-exec with the flag
// if the global is missing — otherwise the CDP connection cannot be made.
if (typeof WebSocket === "undefined") {
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync(process.execPath, ["--experimental-websocket", new URL(import.meta.url).pathname, ...process.argv.slice(2)], { stdio: "inherit" });
  process.exit(r.status == null ? 1 : r.status);
}


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

  await waitFor(() => window.PDC && document.querySelector('[data-file-bucket="host"]') && document.querySelector("#customize"), "shipped controls should exist");

  // Two distinct-colour speakers so we can tell which frame moved where.
  uploadTo(document.querySelector('[data-file-bucket="host"]'), await makeVideo("host.webm", "#d11d1d"));
  await sleep(90);
  uploadTo(document.querySelector('[data-file-bucket="guest1"]'), await makeVideo("guest.webm", "#1d7dd1"));
  await sleep(1300);

  const canvas = document.querySelector("#stage-canvas");
  const cx = canvas.getContext("2d");
  const overlay = document.querySelector("#edit-overlay");
  const isRed = (p) => p.r > 110 && p.r > p.g + 40 && p.r > p.b + 40;
  function avgAtPct(xPct, yPct) {
    const px = Math.round(xPct / 100 * canvas.width), py = Math.round(yPct / 100 * canvas.height);
    const n = 6, d = cx.getImageData(Math.max(0, px - n), Math.max(0, py - n), n * 2, n * 2).data;
    let r = 0, g = 0, b = 0, c = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; c++; }
    return { r: r / c, g: g / c, b: b / c };
  }
  const dragMouse = async (el, fromX, fromY, toX, toY) => {
    el.dispatchEvent(new MouseEvent("mousedown", { clientX: fromX, clientY: fromY, bubbles: true }));
    await sleep(30);
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: (fromX + toX) / 2, clientY: (fromY + toY) / 2, bubbles: true }));
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: toX, clientY: toY, bubbles: true }));
    await sleep(30);
    document.dispatchEvent(new MouseEvent("mouseup", { clientX: toX, clientY: toY, bubbles: true }));
    await sleep(120);
  };

  // 1) Open the custom layout editor.
  await waitFor(() => !document.querySelector("#customize").disabled, "Customize should enable after two uploads");
  document.querySelector("#customize").click();
  await sleep(150);
  assert(!overlay.hidden, "editor overlay should be visible after opening customize");
  const hostFrame = overlay.querySelector('[data-frame-bucket="host"]');
  assert(hostFrame, "an editable Host frame should exist");
  const oRect = () => overlay.getBoundingClientRect();
  const frameCenter = () => { const f = hostFrame.getBoundingClientRect(); return { x: f.left + f.width / 2, y: f.top + f.height / 2 }; };

  // 2) CLICK-BASED resize/position (the path a generic probe can drive without a
  //    freeform drag gesture): shrink + move the Host frame via its buttons.
  const clickN = async (sel, times) => { for (let i = 0; i < times; i++) { hostFrame.querySelector(sel).click(); await sleep(40); } };
  const wBeforeBtns = parseFloat(hostFrame.style.width);
  await clickN('[data-nudge="host:smaller"]', 4);
  await clickN('[data-nudge="host:down"]', 4);
  const wAfterBtns = parseFloat(hostFrame.style.width), yAfterBtns = parseFloat(hostFrame.style.top);
  assert(wAfterBtns < wBeforeBtns - 5, "the smaller button should shrink the Host frame (" + wBeforeBtns + "->" + wAfterBtns + ")");
  assert(yAfterBtns > 10, "the down button should move the Host frame downward (top=" + yAfterBtns + "%)");

  // 3) DRAG also works (literal acceptance): nudge the Host frame via mouse.
  const handle = hostFrame.querySelector(".edit-frame-resize");
  const hb0 = hostFrame.getBoundingClientRect();
  await dragMouse(handle, hb0.right, hb0.bottom, hb0.right - oRect().width * 0.1, hb0.bottom - oRect().height * 0.08);
  const c0 = frameCenter(), ob = oRect();
  await dragMouse(hostFrame, c0.x, c0.y, ob.left + ob.width * 0.16, ob.top + ob.height * 0.7);
  const movedX = parseFloat(hostFrame.style.left), movedY = parseFloat(hostFrame.style.top);
  assert(movedY > 25, "dragging should move the Host frame downward (top=" + movedY + "%)");

  // Live preview should show Host (red) at its new spot and NOT in its old top area.
  const savedCenterX = movedX + parseFloat(hostFrame.style.width) / 2;
  const savedCenterY = movedY + parseFloat(hostFrame.style.height) / 2;
  await sleep(150);
  assert(isRed(avgAtPct(savedCenterX, savedCenterY)), "live preview should render Host video at the dragged position");
  assert(!isRed(avgAtPct(22, 16)), "Host should have vacated its original top-left area after moving");

  // 4) Save the arrangement as a named, reusable template.
  typeInto(document.querySelector("#template-name"), "Corner Host");
  document.querySelector("#save-template").click();
  await sleep(250);
  assert(overlay.hidden, "editor should close after saving");
  const tplBtn = document.querySelector('#templates [data-layout]');
  assert(tplBtn, "a saved template button should appear");
  const tplId = tplBtn.dataset.layout;
  assert(canvas.dataset.preset === tplId, "saved template should be applied (canvas preset=" + canvas.dataset.preset + ")");
  assert(/Corner Host/.test(tplBtn.textContent), "template should carry the chosen name");
  // Applied template renders Host at the saved position and NOT in the old top-left.
  assert(isRed(avgAtPct(savedCenterX, savedCenterY)), "applied template should render Host at the saved position");
  assert(!isRed(avgAtPct(12, 12)), "Host should no longer occupy the original top-left corner");

  // 5) Switch to a preset and back to the template: arrangement + media preserved.
  document.querySelector('[data-preset="stack"]').click();
  await sleep(250);
  assert(canvas.dataset.preset === "stack", "preset switch should take effect");
  tplBtn.click();
  await sleep(300);
  assert(canvas.dataset.preset === tplId, "re-selecting the template should restore it");
  assert(isRed(avgAtPct(savedCenterX, savedCenterY)), "custom arrangement should survive a preset round-trip");
  // The readiness status must name the active custom template (not the old preset).
  const status = (document.querySelector("#readiness").textContent || "");
  assert(/Corner Host/.test(status), "status should name the active custom template after the round-trip (got: " + status + ")");

  // 6) Export while the custom template is selected => playable video of the saved layout.
  await waitFor(() => !document.querySelector("#export").disabled, "export should be available with the template selected");
  document.querySelector("#export").click();
  for (let i = 0; i < 700; i++) {
    if (document.querySelector("#export-download")) break;
    const res = document.querySelector("#export-result");
    if (res && !res.hidden && /fail/i.test(res.textContent)) throw new Error("export reported: " + res.textContent);
    await sleep(50);
  }
  assert(document.querySelector("#export-download"), "export should produce a download for the custom layout");
  const href = document.querySelector("#export-download").getAttribute("href");
  assert(href && href.indexOf("blob:") === 0, "export should yield a real blob");
  const blob = await (await fetch(href)).blob();
  assert(blob.size > 2048, "exported custom-layout file should carry real bytes, got " + blob.size);
  const v = document.createElement("video");
  v.muted = true; v.src = URL.createObjectURL(blob);
  await new Promise((r) => { v.onloadedmetadata = r; v.onerror = r; setTimeout(r, 5000); });
  assert(v.videoWidth > 0 && v.videoHeight > 0, "exported custom-layout file should be a playable video");

  return {
    templateId: tplId,
    templateName: tplBtn.textContent,
    hostSaved: { left: movedX, top: movedY, width: parseFloat(hostFrame.style.width) },
    exportedDuringTemplate: canvas.dataset.preset === tplId,
    exportBytes: blob.size,
    exportDimensions: v.videoWidth + "x" + v.videoHeight,
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
    const result = await send("Runtime.evaluate", { expression: browserExpression, awaitPromise: true, returnByValue: true, timeout: 40000 });
    ws.close();
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    console.log("verify-custom-layout: OK");
    console.log(JSON.stringify(result.result.value, null, 2));
  } finally {
    await stopChrome(child);
    await removeDirEventually(profileDir);
  }
}

main().catch((e) => { console.error(`verify-custom-layout: ${e.message}`); process.exit(1); });
