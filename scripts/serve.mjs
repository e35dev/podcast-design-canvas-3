import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";

const root = process.cwd();
const port = Number(process.env.PORT || 4173);
const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".webm": "video/webm",
  ".txt": "text/plain; charset=utf-8"
};

function resolvePath(urlPath) {
  const requested = (urlPath || "/").split("?")[0];
  if (requested === "/" || requested === "") {
    return join(root, "index.html");
  }
  const safe = normalize(requested).replace(/^([/\\])+/, "").replace(/^(\.\.[/\\])+/, "");
  return join(root, safe);
}

createServer((req, res) => {
  const filePath = resolvePath(req.url);
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }
  res.writeHead(200, { "content-type": mimeTypes[extname(filePath)] || "application/octet-stream" });
  createReadStream(filePath).pipe(res);
}).listen(port, () => {
  console.log(`Podcast Design Canvas available at http://127.0.0.1:${port}`);
});
