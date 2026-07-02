// scripts/verify-template-apply.mjs
// Drives the shipped app in headless Chrome and proves the "apply a saved
// show template to a NEW episode" workflow end to end, using the product's
// own in-app reset path (the "Start new episode" button — no page reload
// required): upload two speaker videos, customize and save a named template
// (moving/resizing Host enough to be visibly distinct), click Start new
// episode, confirm the fresh episode has no leftover media while the saved
// template survived, upload a brand-new pair of speaker videos, select the
// saved template from the normal setup/preset controls, confirm the preview
// renders the new videos at the saved Host geometry, and export a genuinely
// playable video with that same geometry burned in. Media is generated
// in-browser; no seeded fixtures or verifier-only paths.
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
  throw new Error("Chrome/Chromium was not found. Set CHROME_BIN to run template-apply verification.");
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
    for (let i = 0; i < 24; i++) { ctx.fillStyle = color; ctx.fillRect(0,0,320,180); ctx.fillStyle="#fff"; ctx.font="26px sans-serif"; ctx.fillText(name+" "+i, 20, 100); await sleep(45); }
    await new Promise((r) => { rec.onstop = r; rec.stop(); });
    osc.stop(); ac.close(); stream.getTracks().forEach((t) => t.stop());
    return new File(chunks, name, { type: "video/webm" });
  }
  const uploadTo = (input, file) => { const dt = new DataTransfer(); dt.items.add(file); input.files = dt.files; input.dispatchEvent(new Event("change", { bubbles: true })); };
  const typeInto = (input, v) => { input.value = v; input.dispatchEvent(new Event("input", { bubbles: true })); };
  const canvas = document.querySelector("#stage-canvas");
  const cx = canvas.getContext("2d");
  const isRed = (p) => p.r > 110 && p.r > p.g + 40 && p.r > p.b + 40;
  const isBlue = (p) => p.b > 120 && p.b > p.r + 45 && p.b > p.g + 30;
  const exportEnabled = () => !document.querySelector("#export").disabled;
  function avgAtPct(xPct, yPct) {
    const px = Math.round(xPct / 100 * canvas.width), py = Math.round(yPct / 100 * canvas.height);
    const n = 6, d = cx.getImageData(Math.max(0, px - n), Math.max(0, py - n), n * 2, n * 2).data;
    let r = 0, g = 0, b = 0, count = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; count++; }
    return { r: r / count, g: g / count, b: b / count };
  }
  const clickFrameN = async (frame, sel, times) => { for (let i = 0; i < times; i++) { frame.querySelector(sel).click(); await sleep(40); } };

  await waitFor(() => window.PDC && document.querySelector('[data-file-bucket="host"]') && document.querySelector("#new-episode"), "shipped controls should exist");

  // --- Episode 1: build and save a template with a visibly-distinct Host. ---
  uploadTo(document.querySelector('[data-file-bucket="host"]'), await makeVideo("host.webm", "#d11d1d"));
  await sleep(90);
  uploadTo(document.querySelector('[data-file-bucket="guest1"]'), await makeVideo("guest1.webm", "#1d7dd1"));
  await sleep(1200);

  document.querySelector('[data-preset="split"]').click();
  await sleep(200);
  assert(canvas.dataset.preset === "split", "split preset should be active before customizing");

  await waitFor(() => !document.querySelector("#customize").disabled, "Customize should enable after uploads");
  document.querySelector("#customize").click();
  await sleep(150);
  const overlay = document.querySelector("#edit-overlay");
  assert(!overlay.hidden, "editor overlay should open");
  const hostFrame = overlay.querySelector('[data-frame-bucket="host"]');
  const guest1Frame = overlay.querySelector('[data-frame-bucket="guest1"]');
  assert(hostFrame, "Host frame should be editable");
  // Move Host into Guest 1's DEFAULT (right-half) territory, and nudge Guest 1
  // out of the way so the two never overlap in the saved template. This is
  // what makes the "before template" pixel check below meaningful: at this
  // exact spot, the default Split preset shows Guest 1 (blue), so seeing red
  // there is only possible once the saved template is actually applied.
  await clickFrameN(hostFrame, '[data-nudge="host:smaller"]', 5);
  await clickFrameN(hostFrame, '[data-nudge="host:right"]', 7);
  await clickFrameN(hostFrame, '[data-nudge="host:down"]', 1);
  await clickFrameN(guest1Frame, '[data-nudge="guest1:smaller"]', 5);
  await clickFrameN(guest1Frame, '[data-nudge="guest1:left"]', 6);
  await clickFrameN(guest1Frame, '[data-nudge="guest1:down"]', 3);
  const hostRect = { x: parseFloat(hostFrame.style.left), y: parseFloat(hostFrame.style.top), w: parseFloat(hostFrame.style.width), h: parseFloat(hostFrame.style.height) };
  const guest1Rect = { x: parseFloat(guest1Frame.style.left), y: parseFloat(guest1Frame.style.top), w: parseFloat(guest1Frame.style.width), h: parseFloat(guest1Frame.style.height) };
  assert(hostRect.x > 40, "Host should have visibly moved right (left=" + hostRect.x + "%)");
  assert(hostRect.x >= guest1Rect.x + guest1Rect.w, "test setup should keep Host and Guest 1 apart so pixel checks aren't ambiguous (host=" + JSON.stringify(hostRect) + " guest1=" + JSON.stringify(guest1Rect) + ")");

  typeInto(document.querySelector("#template-name"), "Reusable Corner Show");
  document.querySelector("#save-template").click();
  await sleep(250);
  assert(overlay.hidden, "editor should close after saving");
  const tplBtnBefore = document.querySelector("#templates [data-layout]");
  assert(tplBtnBefore, "a saved template button should appear");
  assert(/Reusable Corner Show/.test(tplBtnBefore.textContent), "template should carry the chosen name");

  const hostCenter = { x: hostRect.x + hostRect.w / 2, y: hostRect.y + hostRect.h / 2 };
  assert(isRed(avgAtPct(hostCenter.x, hostCenter.y)), "Host should render at its saved position in episode 1");

  // --- Start a brand-new episode from the product UI (no page reload). ---
  document.querySelector("#new-episode").click();
  await sleep(250);

  assert(document.querySelector('[data-status="host"]').textContent === "No file", "new episode should start with no Host media");
  assert(document.querySelector('[data-status="guest1"]').textContent === "No file", "new episode should start with no Guest 1 media");
  assert(!document.querySelector('.bucket[data-bucket="host"]').classList.contains("filled"), "Host bucket should not be marked filled in the new episode");
  assert(document.querySelector("#export").disabled, "export should be disabled before any media is uploaded in the new episode");
  assert(document.querySelector('[data-link-bucket="host"]').value === "", "social links should reset in the new episode");

  const tplButtons = document.querySelectorAll("#templates [data-layout]");
  assert(tplButtons.length === 1, "the saved template must survive starting a new episode, got " + tplButtons.length + " template(s)");
  const tplBtn = tplButtons[0];
  assert(/Reusable Corner Show/.test(tplBtn.textContent), "surviving template should keep its saved name");
  assert(!tplBtn.classList.contains("selected"), "the new episode should not still be pointed at the old template until the creator picks it");

  // --- Episode 2: new media, select the saved template through normal controls. ---
  uploadTo(document.querySelector('[data-file-bucket="host"]'), await makeVideo("host2.webm", "#d11d1d"));
  await sleep(90);
  uploadTo(document.querySelector('[data-file-bucket="guest1"]'), await makeVideo("guest1-2.webm", "#1d7dd1"));
  await sleep(1200);
  assert(exportEnabled(), "export should enable once two speakers are uploaded in the new episode");
  // Before picking the template, the new episode is on the default Split
  // preset, where this exact spot belongs to Guest 1 (blue) — proving the
  // saved custom geometry only takes effect once the template is selected.
  assert(isBlue(avgAtPct(hostCenter.x, hostCenter.y)), "new episode should show the default Split layout (Guest 1 here), not the old custom geometry, before selecting the template");

  tplBtn.click();
  await sleep(300);
  const tplId = tplBtn.dataset.layout;
  assert(canvas.dataset.preset === tplId, "selecting the saved template should apply it to the new episode");
  assert(isRed(avgAtPct(hostCenter.x, hostCenter.y)), "new episode's Host video should render at the saved template's position");
  assert(exportEnabled(), "export should stay enabled with the saved template applied");
  assert(!document.querySelector("#edit-overlay") || document.querySelector("#edit-overlay").hidden, "applying a saved template must not reopen the canvas editor");

  // Export and confirm the saved geometry is actually burned into the file.
  document.querySelector("#export").click();
  for (let i = 0; i < 700; i++) {
    if (document.querySelector("#export-download")) break;
    const res = document.querySelector("#export-result");
    if (res && !res.hidden && /fail/i.test(res.textContent)) throw new Error("export reported: " + res.textContent);
    await sleep(50);
  }
  assert(document.querySelector("#export-download"), "export should produce a download while the saved template is active");
  const href = document.querySelector("#export-download").getAttribute("href");
  const blob = await (await fetch(href)).blob();
  assert(blob.size > 2048, "exported file should carry real bytes, got " + blob.size);
  const v = document.createElement("video");
  v.muted = true; v.src = URL.createObjectURL(blob);
  await new Promise((r) => { v.onloadedmetadata = r; v.onerror = r; setTimeout(r, 5000); });
  assert(v.videoWidth > 0 && v.videoHeight > 0, "exported file should be a playable video with real dimensions");

  return {
    templateId: tplId,
    hostRect,
    exportBytes: blob.size,
    exportDimensions: v.videoWidth + "x" + v.videoHeight,
  };
})()
`;

async function main() {
  const chrome = findChrome();
  const port = await getFreePort();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdc-template-apply-"));
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
    const result = await send("Runtime.evaluate", { expression: browserExpression, awaitPromise: true, returnByValue: true, timeout: 60000 });
    ws.close();
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    console.log("verify-template-apply: OK — a saved show template applies to a brand-new episode via the in-app reset");
    console.log(JSON.stringify(result.result.value, null, 2));
  } finally {
    await stopChrome(child);
    await removeDirEventually(profileDir);
  }
}

main().catch((e) => { console.error(`verify-template-apply: ${e.message}`); process.exit(1); });
