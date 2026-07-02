// scripts/verify-export.mjs
// Drives the shipped app in headless Chrome and proves the export workflow:
// upload two generated speaker videos (each carrying an audio track), enter
// distinct social links, choose a preset, click the real Export action, and
// confirm a genuinely playable video file is produced from the live canvas
// composition (loads back into a <video> with real dimensions, visible composed
// frames, and non-trivial bytes) that carries AUDIBLE mixed speaker audio. It
// then re-exports twice more in the same session across preset switches (no reload
// / re-upload) and confirms those repeated files are ALSO playable, visible, and
// still carry non-silent audio — guarding the silent-on-re-export regression
// (#90/#107). No fixtures, seeded media, or
// verifier-only paths: media is generated in-browser, links are typed into the
// real inputs, and each artifact is read from the product's own download link.
// Mirrors the CDP harness used by the other rendered checks.
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

  async function waitForVideoFrame(video) {
    await new Promise((resolve) => {
      if (video.readyState >= HTMLMediaElement.HAVE_METADATA) return resolve();
      video.onloadedmetadata = resolve;
      video.onerror = resolve;
      setTimeout(resolve, 5000);
    });
    const target = Number.isFinite(video.duration) && video.duration > 0.4 ? Math.min(0.35, video.duration / 2) : 0;
    if (target > 0) {
      await new Promise((resolve) => {
        let done = false;
        const finish = () => { if (done) return; done = true; resolve(); };
        video.addEventListener("seeked", finish, { once: true });
        video.addEventListener("timeupdate", finish, { once: true });
        try { video.currentTime = target; } catch (e) { finish(); }
        setTimeout(finish, 2000);
      });
    }
    try {
      const p = video.play();
      if (p && typeof p.catch === "function") await p.catch(() => {});
      await new Promise((resolve) => {
        if (video.requestVideoFrameCallback) {
          let done = false;
          const finish = () => { if (done) return; done = true; resolve(); };
          video.requestVideoFrameCallback(() => video.requestVideoFrameCallback(finish));
          setTimeout(finish, 1500);
        } else {
          setTimeout(resolve, 700);
        }
      });
      video.pause();
    } catch (e) {}
  }

  function assertVisibleFrame(video, attempt) {
    const canvas = document.createElement("canvas");
    canvas.width = 160; canvas.height = 90;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let lit = 0, colorful = 0, rSum = 0, gSum = 0, bSum = 0;
    const total = data.length / 4;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      rSum += r; gSum += g; bSum += b;
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      if (max > 35) lit++;
      if (max > 35 && max - min > 18) colorful++;
    }
    const litPct = Math.round((lit / total) * 100);
    const colorfulPct = Math.round((colorful / total) * 100);
    const avg = { r: Math.round(rSum / total), g: Math.round(gSum / total), b: Math.round(bSum / total) };
    assert(
      litPct > 20 && colorfulPct > 10,
      "attempt " + attempt + ": exported video should contain visible composed frames, got lit=" + litPct + "% colorful=" + colorfulPct + "% avg=" + JSON.stringify(avg),
    );
    return { litPct, colorfulPct, avg };
  }

  await waitFor(() => window.PDC && document.querySelector('[data-file-bucket="host"]') && document.querySelector("#export"), "shipped controls should exist");

  uploadTo(document.querySelector('[data-file-bucket="host"]'), await makeVideo("host.webm", "#b91c1c"));
  await sleep(100);
  uploadTo(document.querySelector('[data-file-bucket="guest1"]'), await makeVideo("guest.webm", "#047857"));
  await sleep(1200);
  typeInto(document.querySelector('[data-link-bucket="host"]'), "https://x.com/hostperson");
  typeInto(document.querySelector('[data-link-bucket="guest1"]'), "https://x.com/guestperson");

  // Choose a non-default preset so the export reflects the selected composition.
  document.querySelector('[data-preset="stack"]').click();
  await sleep(200);
  assert(document.querySelector("#stage-canvas").dataset.preset === "stack", "selected preset should be active before export");

  await waitFor(() => !document.querySelector("#export").disabled, "Export action should be enabled after upload + preset");

  // Click the real Export action, read the produced file from the product's own
  // download link, and prove it is a genuinely playable video that carries
  // AUDIBLE (non-silent) mixed speaker audio. The re-export bug produced a second
  // file with no audio track at all (decodeAudioData throws EncodingError on such
  // a file), so we decode the audio and confirm a non-zero peak sample.
  async function runExport(attempt) {
    const result = document.querySelector("#export-result");
    result.hidden = true; result.innerHTML = "";
    await waitFor(() => !document.querySelector("#export").disabled, "attempt " + attempt + ": Export should be enabled");
    document.querySelector("#export").click();
    await waitFor(
      () => document.querySelector("#export-download") && document.querySelector("#export-playback"),
      "attempt " + attempt + ": export should produce a downloadable result",
      600,
    );
    const link = document.querySelector("#export-download");
    const href = link.getAttribute("href");
    assert(href && href.indexOf("blob:") === 0, "attempt " + attempt + ": download link should be a real blob URL");
    const blob = await (await fetch(href)).blob();
    assert(blob.size > 2048, "attempt " + attempt + ": exported file should carry real bytes, got " + blob.size);

    const v = document.createElement("video");
    v.muted = true; v.playsInline = true; v.src = URL.createObjectURL(blob);
    v.style.cssText = "position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0";
    document.body.appendChild(v);
    await waitForVideoFrame(v);
    assert(v.videoWidth > 0 && v.videoHeight > 0, "attempt " + attempt + ": exported file should be a playable video with real dimensions");
    const videoFrame = assertVisibleFrame(v, attempt);
    v.remove();

    const buf = await blob.arrayBuffer();
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    let peak = 0, samples = 0;
    try {
      const decoded = await ac.decodeAudioData(buf.slice(0));
      samples = decoded.length;
      for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
        const data = decoded.getChannelData(ch);
        for (let i = 0; i < data.length; i += 97) { const a = Math.abs(data[i]); if (a > peak) peak = a; }
      }
    } catch (e) {
      throw new Error("attempt " + attempt + ": exported file has no decodable audio track (" + e.name + ") — re-export audio bug");
    } finally { ac.close(); }
    assert(samples > 0 && peak > 1e-4, "attempt " + attempt + ": exported audio must be audible (non-silent), peak=" + peak);

    return { bytes: blob.size, dimensions: v.videoWidth + "x" + v.videoHeight, downloadName: link.getAttribute("download"), videoFrame, audioSamples: samples, audioPeak: Number(peak.toFixed(4)) };
  }

  const first = await runExport(1);
  // Re-export in the SAME session — without reloading or re-uploading — across
  // preset switches. Every repeated export must stay enabled and carry audio.
  document.querySelector('[data-preset="split"]').click();
  await sleep(200);
  assert(document.querySelector("#stage-canvas").dataset.preset === "split", "preset switch to split should apply before the second export");
  const second = await runExport(2);
  assert(/split/.test(second.downloadName || ""), "second export should reflect the switched (split) layout, got " + second.downloadName);

  document.querySelector('[data-preset="spotlight"]').click();
  await sleep(200);
  assert(document.querySelector("#stage-canvas").dataset.preset === "spotlight", "preset switch to spotlight should apply before the third export");
  const third = await runExport(3);
  assert(/spotlight/.test(third.downloadName || ""), "third export should reflect the switched (spotlight) layout, got " + third.downloadName);

  return {
    presetExported: document.querySelector("#stage-canvas").dataset.preset,
    firstExport: first,
    secondExport: second,
    thirdExport: third,
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
    // 75s budget: three full exports (record + decode) plus in-browser media setup.
    const result = await send("Runtime.evaluate", { expression: browserExpression, awaitPromise: true, returnByValue: true, timeout: 75000 });
    ws.close();
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    console.log("verify-export: OK — three consecutive exports all playable and carrying audible audio");
    console.log(JSON.stringify(result.result.value, null, 2));
  } finally {
    await stopChrome(child);
    await removeDirEventually(profileDir);
  }
}

main().catch((e) => { console.error(`verify-export: ${e.message}`); process.exit(1); });
