#!/usr/bin/env node
// tests/browser-export-flow.mjs
// End-to-end proof that the REAL product works in a browser: it serves the app,
// generates two short speaker clips in-page, runs the actual import -> assign ->
// preset -> compose -> export pipeline from app/*, confirms the preview paints
// real uploaded frames (pixel-sampled, not the placeholder), and confirms the
// MediaRecorder export is a genuinely playable video (loads back into <video>
// at the planned dimensions).
//
// This is product evidence, not a unit test: it is intentionally NOT named
// *.test.js, so the zero-dependency gate (scripts/run-tests.mjs) does not run
// it. It needs a Chromium/Chrome binary. If none is found it SKIPS (exit 0) so
// it never breaks a build; run it manually to reproduce the export proof:
//
//   node tests/browser-export-flow.mjs
//
import { createServer } from "http";
import { readFile, stat } from "fs/promises";
import { spawn } from "child_process";
import { existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);
const chromeBin = CHROME_CANDIDATES.find((p) => existsSync(p));

if (!chromeBin) {
  console.log("SKIP browser-export-flow: no Chrome/Chromium found (set CHROME_PATH to run).");
  process.exit(0);
}

const PAGE = `<!doctype html><meta charset=utf-8><canvas id=stage width=1280 height=720></canvas>
<script src="/app/presets.js"></script><script src="/app/episode.js"></script><script src="/app/export-plan.js"></script><script src="/app/compositor.js"></script><script src="/app/exporter.js"></script>
<script>
const { createEpisode, assignSpeakerFile, setPreset } = window.PDC.episode;
const { buildExportPlan } = window.PDC.exportPlan;
const { drawComposite } = window.PDC.compositor;
const { exportEpisode } = window.PDC.exporter;
const post=(o)=>fetch('/__result',{method:'POST',body:JSON.stringify(o)});
async function makeClip(color,label){const c=document.createElement('canvas');c.width=640;c.height=480;const x=c.getContext('2d');
  const vs=c.captureStream(25);const ac=new AudioContext();const osc=ac.createOscillator();const d=ac.createMediaStreamDestination();osc.connect(d);osc.start();
  const s=new MediaStream([...vs.getVideoTracks(),...d.stream.getAudioTracks()]);const r=new MediaRecorder(s,{mimeType:'video/webm'});const ch=[];r.ondataavailable=e=>{if(e.data&&e.data.size)ch.push(e.data)};const done=new Promise(z=>r.onstop=z);
  r.start(100);let t=0;const iv=setInterval(()=>{x.fillStyle=color;x.fillRect(0,0,640,480);x.fillStyle='#fff';x.font='48px sans-serif';x.fillText(label+' '+(t++),40,240)},40);
  await new Promise(z=>setTimeout(z,2000));clearInterval(iv);osc.stop();r.requestData();r.stop();await done;ac.close();return new Blob(ch,{type:'video/webm'});}
async function vid(b){const v=document.createElement('video');v.src=URL.createObjectURL(b);v.muted=true;v.playsInline=true;
  await new Promise(z=>{const ok=()=>{if(v.readyState>=2)z()};v.onloadeddata=ok;v.oncanplay=ok;v.onerror=z;setTimeout(z,5000)});
  await new Promise(z=>{v.onseeked=z;try{v.currentTime=0.05}catch{z()}setTimeout(z,1500)});return v;}
(async()=>{try{
  const A=await makeClip('#d23b3b','HOST'),B=await makeClip('#2f7be0','GUEST');
  const vA=await vid(A),vB=await vid(B);const videos={host:vA,guest1:vB};
  const ep=createEpisode({title:'Export Flow'});
  assignSpeakerFile(ep,'host',{name:'host.webm',size:A.size,type:'video/webm',durationSec:vA.duration||2});
  assignSpeakerFile(ep,'guest1',{name:'guest.webm',size:B.size,type:'video/webm',durationSec:vB.duration||2});
  setPreset(ep,'side-by-side');
  const plan=buildExportPlan(ep,{resolution:'720p',fps:25});
  const stage=document.getElementById('stage');stage.width=plan.width;stage.height=plan.height;const ctx=stage.getContext('2d');
  drawComposite(ctx,plan,videos,{title:ep.title});
  const f=plan.frames[0];const px=ctx.getImageData(Math.round(f.x+f.w/2),Math.round(f.y+f.h/2),1,1).data;
  const realFrame=px[0]>120&&px[0]>px[2];
  const out=await exportEpisode(stage,plan,videos,{title:ep.title,maxSeconds:2});
  const ev=await vid(out.blob);
  post({pass:out.bytes>2000&&ev.videoWidth===plan.width&&realFrame,bytes:out.bytes,exportW:ev.videoWidth,exportH:ev.videoHeight,realFrame});
}catch(e){post({pass:false,why:String(e&&e.stack||e)});}})();
<\/script>`;

const TYPES = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html" };
let resolveResult;
const result = new Promise((r) => (resolveResult = r));
const server = createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/__result") {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => { res.end("ok"); resolveResult(b); });
    return;
  }
  const url = req.url.split("?")[0];
  if (url === "/" || url === "/__page") {
    res.setHeader("content-type", "text/html");
    res.end(PAGE);
    return;
  }
  const full = path.join(root, url);
  const s = await stat(full).catch(() => null);
  if (s && s.isFile() && full.startsWith(root)) {
    res.setHeader("content-type", TYPES[path.extname(full)] || "application/octet-stream");
    res.end(await readFile(full));
    return;
  }
  res.writeHead(404).end();
});

server.on("error", (e) => {
  console.error("SKIP browser-export-flow: server error " + e.message);
  process.exit(0);
});
server.listen(0, "127.0.0.1", () => {
  const PORT = server.address().port;
  const chrome = spawn(chromeBin, [
    "--headless=new", "--no-sandbox", "--disable-gpu",
    "--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream",
    "--remote-debugging-port=0", `http://localhost:${PORT}/__page`,
  ], { stdio: "ignore" });

  const timeout = new Promise((r) => setTimeout(() => r('{"pass":false,"why":"timeout"}'), 60000));
  Promise.race([result, timeout]).then((raw) => {
    chrome.kill("SIGKILL");
    server.close();
    let r = {};
    try { r = JSON.parse(raw); } catch { r = { pass: false, why: "bad result" }; }
    console.log("browser-export-flow:", JSON.stringify(r));
    if (r.pass) {
      console.log("PASS: real-frame preview + playable export verified in-browser.");
      process.exit(0);
    } else {
      console.error("FAIL: " + (r.why || "export/preview did not verify"));
      process.exit(1);
    }
  });
});
