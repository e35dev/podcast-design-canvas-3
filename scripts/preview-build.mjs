/*
 * Zero-dependency "preview build": assemble the static, no-build app into dist/
 * and assert it is shippable — every referenced asset exists, is non-empty, and
 * the page stays file://-safe (no module scripts).
 */
import { readFileSync, mkdirSync, copyFileSync, rmSync, existsSync } from "node:fs";

const ASSETS = ["index.html", "app/styles.css", "app/model.js", "app/main.js"];
const OUT = "dist";

for (const a of ASSETS) {
  if (!existsSync(a)) {
    console.error("preview-build: missing asset " + a);
    process.exit(1);
  }
  if (readFileSync(a).length === 0) {
    console.error("preview-build: empty asset " + a);
    process.exit(1);
  }
}

const html = readFileSync("index.html", "utf8");
const htmlCode = html.replace(/<!--[\s\S]*?-->/g, "");
if (/<script[^>]*type=["']module["']/i.test(htmlCode)) {
  console.error("preview-build: index.html must not use module scripts (file:// safe).");
  process.exit(1);
}
for (const ref of ["app/styles.css", "app/model.js", "app/main.js"]) {
  if (!htmlCode.includes(ref)) {
    console.error("preview-build: index.html does not reference " + ref);
    process.exit(1);
  }
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT + "/app", { recursive: true });
for (const a of ASSETS) {
  copyFileSync(a, OUT + "/" + a);
}

console.log("preview-build: ok — dist/ assembled (" + ASSETS.length + " assets)");
