// scripts/verify-template-persistence.mjs
// Drives the shipped app in headless Chrome and proves the reusable
// show-template workflow end to end, INCLUDING a real page reload:
// upload three speaker videos, customize a layout (move/resize Host and
// Guest 1), save it as a named template, then reload the page (a fresh JS
// realm, same browser profile) and confirm the template survived, that the
// fresh episode carries none of the old episode's media, that selecting the
// template applies the saved arrangement to newly uploaded videos, that it
// stays selected across a preset round-trip, and that export still works.
// Media is generated in-browser; the reload is a real CDP navigation, not a
// simulated/verifier-only shortcut.
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
  throw new Error("Chrome/Chromium was not found. Set CHROME_BIN to run template-persistence verification.");
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

// Poll (not a single fixed wait) so this survives whatever the navigation
// timing looks like in the sandbox — a fresh execution context only exists
// once the new document has actually loaded.
async function waitPageReady(send, tries = 200) {
  const probe = "document.readyState === 'complete' && !!window.PDC && !!document.querySelector('#customize')";
  for (let i = 0; i < tries; i++) {
    try {
      const r = await send("Runtime.evaluate", { expression: probe, returnByValue: true });
      if (r && r.result && r.result.value === true) return;
    } catch (e) {
      /* the old context can still be tearing down mid-navigation */
    }
    await sleep(100);
  }
  throw new Error("page did not become ready after navigation");
}

// Shared browser-side helpers (re-declared in each phase since a navigation
// destroys the previous execution context and every global with it).
const helpers = `
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
  const canvas = () => document.querySelector("#stage-canvas");
  const cx = () => canvas().getContext("2d");
  const isRed = (p) => p.r > 110 && p.r > p.g + 40 && p.r > p.b + 40;
  const isBlue = (p) => p.b > 120 && p.b > p.r + 45 && p.b > p.g + 30;
  const isGreen = (p) => p.g > 85 && p.g > p.r + 30 && p.b > p.r + 25;
  const exportEnabled = () => !document.querySelector("#export").disabled;
  function avgAtPct(xPct, yPct) {
    const c = canvas(), ctx = cx();
    const px = Math.round(xPct / 100 * c.width), py = Math.round(yPct / 100 * c.height);
    const n = 6, d = ctx.getImageData(Math.max(0, px - n), Math.max(0, py - n), n * 2, n * 2).data;
    let r = 0, g = 0, b = 0, count = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; count++; }
    return { r: r / count, g: g / count, b: b / count };
  }
  const clickFrameN = async (frame, sel, times) => {
    for (let i = 0; i < times; i++) { frame.querySelector(sel).click(); await sleep(40); }
  };
`;

const phase1Expression = `
(async () => {
  ${helpers}

  await waitFor(() => window.PDC && document.querySelector('[data-file-bucket="host"]') && document.querySelector("#customize"), "shipped controls should exist");

  uploadTo(document.querySelector('[data-file-bucket="host"]'), await makeVideo("host.webm", "#d11d1d"));
  await sleep(90);
  uploadTo(document.querySelector('[data-file-bucket="guest1"]'), await makeVideo("guest1.webm", "#1d7dd1"));
  await sleep(90);
  uploadTo(document.querySelector('[data-file-bucket="guest2"]'), await makeVideo("guest2.webm", "#0f8a4b"));
  await sleep(1300);

  document.querySelector('[data-preset="split"]').click();
  await sleep(200);
  assert(canvas().dataset.preset === "split", "split preset should be active before customizing");

  await waitFor(() => !document.querySelector("#customize").disabled, "Customize should enable after uploads");
  document.querySelector("#customize").click();
  await sleep(150);
  const overlay = document.querySelector("#edit-overlay");
  assert(!overlay.hidden, "editor overlay should open");

  // Move AND resize both Host and Guest 1 (the issue explicitly requires at
  // least these two) via the click-based nudge controls, which produce
  // deterministic percent geometry we can re-check after the reload. The
  // nudge counts are chosen so the two frames end up clearly apart (not just
  // non-identical) — otherwise one can paint over the other's sample point.
  const hostFrame = overlay.querySelector('[data-frame-bucket="host"]');
  const guest1Frame = overlay.querySelector('[data-frame-bucket="guest1"]');
  assert(hostFrame && guest1Frame, "Host and Guest 1 frames should be editable");
  await clickFrameN(hostFrame, '[data-nudge="host:smaller"]', 4);
  await clickFrameN(hostFrame, '[data-nudge="host:down"]', 2);
  await clickFrameN(guest1Frame, '[data-nudge="guest1:larger"]', 1);
  await clickFrameN(guest1Frame, '[data-nudge="guest1:down"]', 1);

  const hostRect = { x: parseFloat(hostFrame.style.left), y: parseFloat(hostFrame.style.top), w: parseFloat(hostFrame.style.width), h: parseFloat(hostFrame.style.height) };
  const guest1Rect = { x: parseFloat(guest1Frame.style.left), y: parseFloat(guest1Frame.style.top), w: parseFloat(guest1Frame.style.width), h: parseFloat(guest1Frame.style.height) };
  assert(hostRect.x + hostRect.w <= guest1Rect.x, "test setup should keep Host and Guest 1 apart so pixel checks aren't ambiguous (host=" + JSON.stringify(hostRect) + " guest1=" + JSON.stringify(guest1Rect) + ")");

  typeInto(document.querySelector("#template-name"), "Reusable Corner Show");
  document.querySelector("#save-template").click();
  await sleep(250);
  assert(overlay.hidden, "editor should close after saving");

  const tplBtn = document.querySelector("#templates [data-layout]");
  assert(tplBtn, "a saved template button should appear");
  assert(/Reusable Corner Show/.test(tplBtn.textContent), "template should carry the chosen name");
  assert(canvas().dataset.preset === tplBtn.dataset.layout, "saved template should apply immediately");

  const hostCenter = { x: hostRect.x + hostRect.w / 2, y: hostRect.y + hostRect.h / 2 };
  const guest1Center = { x: guest1Rect.x + guest1Rect.w / 2, y: guest1Rect.y + guest1Rect.h / 2 };
  assert(isRed(avgAtPct(hostCenter.x, hostCenter.y)), "Host should render at its saved position before reload");
  assert(isBlue(avgAtPct(guest1Center.x, guest1Center.y)), "Guest 1 should render at its saved position before reload");

  return { hostRect, guest1Rect, templateName: tplBtn.textContent };
})()
`;

function phase2Expression(hostRect, guest1Rect) {
  const hostCenter = { x: hostRect.x + hostRect.w / 2, y: hostRect.y + hostRect.h / 2 };
  const guest1Center = { x: guest1Rect.x + guest1Rect.w / 2, y: guest1Rect.y + guest1Rect.h / 2 };
  return `
(async () => {
  ${helpers}

  await waitFor(() => window.PDC && document.querySelector('[data-file-bucket="host"]') && document.querySelector("#customize"), "shipped controls should exist after reload");

  // A reload must produce a brand-new episode: no leftover media from before.
  assert(document.querySelector('[data-status="host"]').textContent === "No file", "reload should start with no Host media");
  assert(document.querySelector('[data-status="guest1"]').textContent === "No file", "reload should start with no Guest 1 media");
  assert(!document.querySelector('.bucket[data-bucket="host"]').classList.contains("filled"), "Host bucket should not be marked filled after reload");
  assert(document.querySelector("#export").disabled, "export should be disabled before any media is uploaded post-reload");

  // But the saved template itself must have survived.
  const tplButtons = document.querySelectorAll("#templates [data-layout]");
  assert(tplButtons.length === 1, "exactly one persisted template should be listed after reload, got " + tplButtons.length);
  const tplBtn = tplButtons[0];
  assert(/Reusable Corner Show/.test(tplBtn.textContent), "persisted template should keep its saved name");
  const tplId = tplBtn.dataset.layout;

  // Upload a NEW set of speaker videos for this fresh episode.
  uploadTo(document.querySelector('[data-file-bucket="host"]'), await makeVideo("host2.webm", "#d11d1d"));
  await sleep(90);
  uploadTo(document.querySelector('[data-file-bucket="guest1"]'), await makeVideo("guest1-2.webm", "#1d7dd1"));
  await sleep(1200);
  assert(!document.querySelector("#export").disabled, "export should enable once two speakers are uploaded");

  tplBtn.click();
  await sleep(250);
  assert(canvas().dataset.preset === tplId, "selecting the persisted template should apply it");
  assert(isRed(avgAtPct(${hostCenter.x}, ${hostCenter.y})), "new Host video should render at the saved template position");
  assert(isBlue(avgAtPct(${guest1Center.x}, ${guest1Center.y})), "new Guest 1 video should render at the saved template position");
  assert(exportEnabled(), "export should be enabled with the persisted template applied");

  // Survive a round-trip through a built-in preset and back.
  document.querySelector('[data-preset="stack"]').click();
  await sleep(200);
  assert(canvas().dataset.preset === "stack", "switching to Stack should take effect");
  tplBtn.click();
  await sleep(250);
  assert(canvas().dataset.preset === tplId, "re-selecting the template should restore it after a preset switch");
  assert(isRed(avgAtPct(${hostCenter.x}, ${hostCenter.y})), "saved arrangement should survive a preset round-trip");
  const status = document.querySelector("#readiness").textContent || "";
  assert(/Reusable Corner Show/.test(status), "readiness status should name the active persisted template (got: " + status + ")");

  // Export while the persisted template is selected => a genuinely playable video.
  document.querySelector("#export").click();
  for (let i = 0; i < 700; i++) {
    if (document.querySelector("#export-download")) break;
    const res = document.querySelector("#export-result");
    if (res && !res.hidden && /fail/i.test(res.textContent)) throw new Error("export reported: " + res.textContent);
    await sleep(50);
  }
  assert(document.querySelector("#export-download"), "export should produce a download with the persisted template selected");
  const href = document.querySelector("#export-download").getAttribute("href");
  const blob = await (await fetch(href)).blob();
  assert(blob.size > 2048, "exported file should carry real bytes, got " + blob.size);
  const v = document.createElement("video");
  v.muted = true; v.src = URL.createObjectURL(blob);
  await new Promise((r) => { v.onloadedmetadata = r; v.onerror = r; setTimeout(r, 5000); });
  assert(v.videoWidth > 0 && v.videoHeight > 0, "exported file should be a playable video");

  return {
    templateId: tplId,
    exportBytes: blob.size,
    exportDimensions: v.videoWidth + "x" + v.videoHeight,
  };
})()
`;
}

async function main() {
  const chrome = findChrome();
  const port = await getFreePort();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdc-template-persist-"));
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
    await send("Page.enable");
    await waitPageReady(send);

    const phase1 = await send("Runtime.evaluate", { expression: phase1Expression, awaitPromise: true, returnByValue: true, timeout: 60000 });
    if (phase1.exceptionDetails) throw new Error(phase1.exceptionDetails.exception?.description || phase1.exceptionDetails.text);
    const { hostRect, guest1Rect, templateName } = phase1.result.value;

    // A real reload — same profile/localStorage, fresh JS realm — is the whole
    // point of this check: it's the only way to prove the template outlives
    // the session instead of just living in an in-memory array.
    await send("Page.navigate", { url: entryUrl });
    await waitPageReady(send);

    const phase2 = await send("Runtime.evaluate", { expression: phase2Expression(hostRect, guest1Rect), awaitPromise: true, returnByValue: true, timeout: 60000 });
    ws.close();
    if (phase2.exceptionDetails) throw new Error(phase2.exceptionDetails.exception?.description || phase2.exceptionDetails.text);

    console.log("verify-template-persistence: OK — saved template survives a reload and applies to a new episode");
    console.log(JSON.stringify({ templateName, hostRect, guest1Rect, afterReload: phase2.result.value }, null, 2));
  } finally {
    await stopChrome(child);
    await removeDirEventually(profileDir);
  }
}

main().catch((e) => { console.error(`verify-template-persistence: ${e.message}`); process.exit(1); });
