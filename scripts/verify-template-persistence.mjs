// scripts/verify-template-persistence.mjs
// Drives the shipped app in headless Chrome and proves saved show templates are
// reusable across a refresh: upload three sample WebM speaker videos, choose a
// preset, open Customize layout, move/resize the Host and Guest 1 frames, save
// the layout as a named show template, then REFRESH the app (a real page
// navigation in the same browser). Upload a NEW set of sample WebM speaker
// videos, select the saved template from the normal template/preset controls,
// and confirm the preview composes the new videos in the SAVED frame
// arrangement, the saved template name remains selected after switching away
// and back, Export is enabled, and the persisted template JSON carries ONLY
// layout data (no media, blob URLs, or old-episode fields). Media is generated
// in-browser through the real upload inputs — no fixtures, seeded media, or
// verifier-only paths. Mirrors the CDP harness used by the other rendered checks.
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

// Browser-side helpers shared by both phases (before and after the refresh).
const browserHelpers = `
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

  // Looked up lazily: this helper block is evaluated as soon as the CDP
  // session attaches, which can be before the document has parsed.
  const stageEl = () => document.querySelector("#stage-canvas");
  const isRed = (p) => p.r > 110 && p.r > p.g + 40 && p.r > p.b + 40;
  const isBlue = (p) => p.b > 120 && p.b > p.r + 45 && p.b > p.g + 30;
  const isGreen = (p) => p.g > 85 && p.g > p.r + 30 && p.b > p.r + 25;
  const isDark = (p) => p.r < 40 && p.g < 40 && p.b < 40;
  function avgAtPct(xPct, yPct) {
    const stage = stageEl();
    const px = Math.round(xPct / 100 * stage.width), py = Math.round(yPct / 100 * stage.height);
    const n = 6, d = stage.getContext("2d").getImageData(Math.max(0, px - n), Math.max(0, py - n), n * 2, n * 2).data;
    let r = 0, g = 0, b = 0, c = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; c++; }
    return { r: r / c, g: g / c, b: b / c };
  }
  const rectCenter = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
  const insideRect = (pt, r) => pt.x > r.x && pt.x < r.x + r.w && pt.y > r.y && pt.y < r.y + r.h;
  const exportEnabled = () => !document.querySelector("#export").disabled;

  async function uploadThree(prefix, colors) {
    uploadTo(document.querySelector('[data-file-bucket="host"]'), await makeVideo(prefix + "-host.webm", colors[0]));
    await sleep(90);
    uploadTo(document.querySelector('[data-file-bucket="guest1"]'), await makeVideo(prefix + "-guest1.webm", colors[1]));
    await sleep(90);
    uploadTo(document.querySelector('[data-file-bucket="guest2"]'), await makeVideo(prefix + "-guest2.webm", colors[2]));
    await sleep(1300);
  }
`;

// PHASE 1 — first session: upload, choose a preset, customize the Host and
// Guest 1 frames (buttons AND real mouse drags), save as a named show template,
// and confirm it persisted to storage. Returns the saved geometry so phase 2
// (after the refresh) can verify the arrangement independently.
const phaseOneExpression = `
(async () => {
  ${browserHelpers}
  await waitFor(() => window.PDC && document.querySelector('[data-file-bucket="host"]') && document.querySelector("#customize"), "shipped controls should exist");

  // Upload three sample WebM speaker videos through the real inputs.
  await uploadThree("first", ["#d11d1d", "#1d7dd1", "#0f8a4b"]);

  // Choose a preset.
  document.querySelector('[data-preset="split"]').click();
  await sleep(250);
  assert(stageEl().dataset.preset === "split", "Split should be active before customizing");
  assert(exportEnabled(), "export should be enabled with three uploads");

  // Open Customize layout.
  await waitFor(() => !document.querySelector("#customize").disabled, "Customize should enable after uploads");
  document.querySelector("#customize").click();
  await sleep(150);
  const overlay = document.querySelector("#edit-overlay");
  assert(!overlay.hidden, "editor overlay should open");
  const hostFrame = overlay.querySelector('[data-frame-bucket="host"]');
  const guestFrame = overlay.querySelector('[data-frame-bucket="guest1"]');
  assert(hostFrame && guestFrame, "Host and Guest 1 frames should be editable");

  const styleRect = (f) => ({ x: parseFloat(f.style.left), y: parseFloat(f.style.top), w: parseFloat(f.style.width), h: parseFloat(f.style.height) });
  const clickN = async (frame, sel, times) => { for (let i = 0; i < times; i++) { frame.querySelector(sel).click(); await sleep(40); } };
  const dragMouse = async (el, fromX, fromY, toX, toY) => {
    el.dispatchEvent(new MouseEvent("mousedown", { clientX: fromX, clientY: fromY, bubbles: true }));
    await sleep(30);
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: (fromX + toX) / 2, clientY: (fromY + toY) / 2, bubbles: true }));
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: toX, clientY: toY, bubbles: true }));
    await sleep(30);
    document.dispatchEvent(new MouseEvent("mouseup", { clientX: toX, clientY: toY, bubbles: true }));
    await sleep(120);
  };
  const ob = () => overlay.getBoundingClientRect();

  // MOVE + RESIZE the Host frame: nudge buttons for deterministic geometry,
  // then a genuine mouse drag (both interaction paths the editor ships).
  await clickN(hostFrame, '[data-nudge="host:smaller"]', 4); // 50x100 -> 18x68
  await clickN(hostFrame, '[data-nudge="host:down"]', 4);    // y -> 32 (clamped)
  const hb = hostFrame.getBoundingClientRect();
  await dragMouse(hostFrame, hb.left + hb.width / 2, hb.top + hb.height / 2, hb.left + hb.width / 2 + ob().width * 0.04, hb.top + hb.height / 2);
  const hostRect = styleRect(hostFrame);
  assert(hostRect.w < 30, "Host should be resized well below its Split width (w=" + hostRect.w + "%)");
  assert(hostRect.y > 20, "Host should be moved down (top=" + hostRect.y + "%)");
  assert(hostRect.x > 1, "the mouse drag should move Host right (left=" + hostRect.x + "%)");

  // MOVE + RESIZE the Guest 1 frame: nudges to reposition, then a real
  // resize drag on its corner handle.
  await clickN(guestFrame, '[data-nudge="guest1:smaller"]', 2); // 50x50 -> 34x34
  await clickN(guestFrame, '[data-nudge="guest1:down"]', 2);    // y 0 -> 16
  await clickN(guestFrame, '[data-nudge="guest1:left"]', 1);    // x 50 -> 42
  const handle = guestFrame.querySelector(".edit-frame-resize");
  const gb = guestFrame.getBoundingClientRect();
  await dragMouse(handle, gb.right, gb.bottom, gb.right - ob().width * 0.04, gb.bottom - ob().height * 0.04);
  const guestRect = styleRect(guestFrame);
  assert(guestRect.x < 50 && guestRect.y > 5, "Guest 1 should be moved (left=" + guestRect.x + "%, top=" + guestRect.y + "%)");
  assert(guestRect.w < 33, "the corner drag should shrink Guest 1 (w=" + guestRect.w + "%)");

  // The customized arrangement must keep every speaker's sample point outside
  // the other frames so the pixel checks are unambiguous.
  const guest2Rect = styleRect(overlay.querySelector('[data-frame-bucket="guest2"]'));
  const hostC = rectCenter(hostRect), guestC = rectCenter(guestRect), g2C = rectCenter(guest2Rect);
  assert(!insideRect(hostC, guestRect) && !insideRect(hostC, guest2Rect), "Host center should sit only inside the Host frame");
  assert(!insideRect(guestC, hostRect) && !insideRect(guestC, guest2Rect), "Guest 1 center should sit only inside its frame");
  assert(!insideRect(g2C, hostRect) && !insideRect(g2C, guestRect), "Guest 2 center should sit only inside its frame");

  // Live preview already composes the edited arrangement.
  await sleep(200);
  assert(isRed(avgAtPct(hostC.x, hostC.y)), "live preview should render Host at the edited position");
  assert(isBlue(avgAtPct(guestC.x, guestC.y)), "live preview should render Guest 1 at the edited position");

  // Save the layout as a named show template.
  typeInto(document.querySelector("#template-name"), "My Show Layout");
  document.querySelector("#save-template").click();
  await sleep(250);
  assert(overlay.hidden, "editor should close after saving");
  const tplBtn = document.querySelector("#templates [data-layout]");
  assert(tplBtn, "a saved template button should appear");
  const tplId = tplBtn.dataset.layout;
  assert(/My Show Layout/.test(tplBtn.textContent), "template should carry the chosen name");
  assert(stageEl().dataset.preset === tplId, "saving should apply the template");
  assert(tplBtn.classList.contains("selected"), "the saved template should be selected");

  // The template reached persistent storage before the refresh.
  const saved = window.PDC.templates.getTemplate(tplId);
  assert(saved && saved.rects.host && saved.rects.guest1 && saved.rects.guest2, "the template should keep one rect per speaker");
  const raw = window.localStorage.getItem(window.PDC.templates.STORE_KEY);
  assert(raw && raw.indexOf('"' + tplId + '"') !== -1, "the saved template should be written to localStorage before the refresh");

  return { tplId, name: saved.name, rects: saved.rects };
})()
`;

// PHASE 2 — after a REAL page refresh: the saved template is listed by name,
// a brand new set of uploads composes in the SAVED arrangement when the
// template is selected from the normal controls, the selection survives
// switching away and back, Export is enabled, and the persisted JSON carries
// only layout data.
function phaseTwoExpression(expected) {
  return `
(async () => {
  ${browserHelpers}
  const expected = ${JSON.stringify(expected)};
  await waitFor(() => window.PDC && document.querySelector('[data-file-bucket="host"]') && document.querySelector("#templates"), "shipped controls should exist after the refresh");

  // The refreshed app starts a fresh episode — no media carried over — but
  // still lists the saved show template by name.
  assert(document.querySelector('[data-status="host"]').textContent === "No file", "the refreshed episode must not carry the old uploads");
  assert(!exportEnabled(), "export should be disabled before the new uploads");
  const tplBtn = document.querySelector('#templates [data-layout="' + expected.tplId + '"]');
  assert(tplBtn, "the saved template should be listed after the refresh");
  assert(/My Show Layout/.test(tplBtn.textContent), "the saved template should keep its name after the refresh");

  // The persisted template matches what was saved and carries ONLY layout data.
  const t = window.PDC.templates.getTemplate(expected.tplId);
  assert(t, "getTemplate should resolve the persisted template");
  assert(t.name === expected.name, "the persisted name should match (got: " + t.name + ")");
  ["host", "guest1", "guest2"].forEach((b) => {
    const a = t.rects[b], e = expected.rects[b];
    assert(a && ["x", "y", "w", "h"].every((k) => Math.abs(a[k] - e[k]) < 0.5),
      "persisted " + b + " rect should match the saved geometry (got " + JSON.stringify(a) + ", want " + JSON.stringify(e) + ")");
  });
  const raw = window.localStorage.getItem(window.PDC.templates.STORE_KEY);
  const entry = JSON.parse(raw).find((x) => x.id === expected.tplId);
  assert(entry, "the stored JSON should contain the template");
  assert(Object.keys(entry).sort().join(",") === "id,name,rects", "the stored template must carry ONLY id/name/rects, got keys: " + Object.keys(entry).join(","));
  Object.keys(entry.rects).forEach((b) => {
    assert(Object.keys(entry.rects[b]).sort().join(",") === "h,w,x,y", "stored rects must be pure geometry, got keys: " + Object.keys(entry.rects[b]).join(","));
  });
  assert(!/blob:|\\.webm|"media"|"src"|"url"|"objectUrl"|"file"/i.test(raw), "the stored template JSON must not reference media: " + raw);

  // Upload a NEW set of sample WebM speaker videos.
  await uploadThree("second", ["#e01414", "#1450e0", "#0fa050"]);
  assert(stageEl().dataset.preset === "split", "a fresh episode should start on the default preset, not the template");

  const hostC = rectCenter(expected.rects.host);
  const guestC = rectCenter(expected.rects.guest1);
  const g2C = rectCenter(expected.rects.guest2);
  // Under the default Split, the top-left corner shows the Host video; under
  // the saved arrangement it is bare stage — a discriminating probe point.
  const probe = { x: 10, y: 8 };
  assert(!insideRect(probe, expected.rects.host) && !insideRect(probe, expected.rects.guest1) && !insideRect(probe, expected.rects.guest2),
    "the probe point must sit outside every saved rect");
  await waitFor(() => isRed(avgAtPct(probe.x, probe.y)), "Split should compose the new Host video top-left before the template is selected");

  // Select the saved template from the normal template/preset controls.
  tplBtn.click();
  await sleep(300);
  assert(stageEl().dataset.preset === expected.tplId, "selecting the saved template should apply it (canvas preset=" + stageEl().dataset.preset + ")");
  assert(tplBtn.classList.contains("selected"), "the saved template button should be selected");
  assert(/My Show Layout/.test(document.querySelector("#readiness").textContent), "the status line should name the selected template");

  // The preview composes the NEW videos in the SAVED frame arrangement.
  await waitFor(() => isRed(avgAtPct(hostC.x, hostC.y)), "the new Host video should render inside the saved Host rect");
  assert(isBlue(avgAtPct(guestC.x, guestC.y)), "the new Guest 1 video should render inside the saved Guest 1 rect");
  assert(isGreen(avgAtPct(g2C.x, g2C.y)), "the new Guest 2 video should render inside the saved Guest 2 rect");
  assert(isDark(avgAtPct(probe.x, probe.y)), "outside the saved rects the stage should be background — the saved arrangement, not Split, drives the preview");
  assert(exportEnabled(), "Export should be enabled with the saved template selected");

  // Switch away to a preset and back: the template re-selects and re-applies.
  document.querySelector('[data-preset="split"]').click();
  await sleep(250);
  assert(stageEl().dataset.preset === "split", "switching to Split should take effect");
  assert(!tplBtn.classList.contains("selected"), "the template should deselect while Split is active");
  await waitFor(() => isRed(avgAtPct(probe.x, probe.y)), "Split should put the Host video back top-left");
  tplBtn.click();
  await sleep(300);
  assert(stageEl().dataset.preset === expected.tplId, "re-selecting the template should restore it");
  assert(tplBtn.classList.contains("selected"), "the saved template name should be selected again after switching away and back");
  assert(/My Show Layout/.test(document.querySelector("#readiness").textContent), "the status line should name the template again");
  assert(isRed(avgAtPct(hostC.x, hostC.y)), "the saved arrangement should re-apply after the round-trip");
  assert(isDark(avgAtPct(probe.x, probe.y)), "the re-applied arrangement should again leave the probe point on background");
  assert(exportEnabled(), "Export should stay enabled after the round-trip");

  return {
    templateListedAfterRefresh: true,
    selectedAfterRoundTrip: tplBtn.classList.contains("selected"),
    readiness: document.querySelector("#readiness").textContent,
    storedKeys: Object.keys(entry).sort(),
    hostRect: t.rects.host,
    guest1Rect: t.rects.guest1,
  };
})()
`;
}

// Wait (bounded) until a FRESHLY booted app is the document behind the CDP
// session. Evaluating too early can land in the initial about:blank context —
// where the app's controls never appear — or, right after a navigation, in the
// outgoing document. Requiring the pristine "No file" Host status alongside the
// controls means only a fresh boot (never the old, uploaded-into episode)
// satisfies the probe; each attempt re-evaluates against the current context.
async function waitForBoot(send, label) {
  const probeExpression = "!!(window.PDC && document.querySelector('#templates') && document.querySelector('#stage-canvas')" +
    " && document.querySelector('[data-file-bucket=\"host\"]')" +
    " && (document.querySelector('[data-status=\"host\"]') || {}).textContent === 'No file')";
  for (let i = 0; i < 240; i++) {
    try {
      const probe = await send("Runtime.evaluate", { expression: probeExpression, returnByValue: true, timeout: 5000 });
      if (probe.result && probe.result.value === true) return;
    } catch (e) { /* navigation in flight — keep polling */ }
    await sleep(250);
  }
  throw new Error("the app did not boot " + label);
}

async function main() {
  const chrome = findChrome();
  const port = await getFreePort();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdc-tpl-persist-"));
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
    await waitForBoot(send, "before the first session");

    const first = await send("Runtime.evaluate", { expression: phaseOneExpression, awaitPromise: true, returnByValue: true, timeout: 90000 });
    if (first.exceptionDetails) throw new Error("before refresh: " + (first.exceptionDetails.exception?.description || first.exceptionDetails.text));
    const saved = first.result.value;

    // REFRESH the app: a real page navigation back to the entry URL in the
    // same browser profile, then wait (bounded) for the fresh app to boot.
    await send("Page.navigate", { url: entryUrl });
    await sleep(250);
    await waitForBoot(send, "after the refresh");

    const second = await send("Runtime.evaluate", { expression: phaseTwoExpression(saved), awaitPromise: true, returnByValue: true, timeout: 90000 });
    ws.close();
    if (second.exceptionDetails) throw new Error("after refresh: " + (second.exceptionDetails.exception?.description || second.exceptionDetails.text));

    console.log("verify-template-persistence: OK");
    console.log(JSON.stringify({ saved, afterRefresh: second.result.value }, null, 2));
  } finally {
    await stopChrome(child);
    await removeDirEventually(profileDir);
  }
}

main().catch((e) => { console.error(`verify-template-persistence: ${e.message}`); process.exit(1); });
