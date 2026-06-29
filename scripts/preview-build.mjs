import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const required = [
  "index.html",
  "styles.css",
  "app/model.js",
  "app/main.js",
  "package.json"
];

for (const path of required) {
  if (!existsSync(path)) {
    throw new Error(`Missing required file: ${path}`);
  }
}

const html = readFileSync("index.html", "utf8");
for (const fragment of ['href="styles.css"', 'src="app/model.js"', 'src="app/main.js"']) {
  if (!html.includes(fragment)) {
    throw new Error(`index.html missing ${fragment}`);
  }
}
if (html.includes('type="module"')) {
  throw new Error("Static preview must not depend on browser module scripts.");
}

rmSync("dist", { force: true, recursive: true });
mkdirSync("dist", { recursive: true });
for (const entry of ["index.html", "styles.css", "app"]) {
  cpSync(entry, join("dist", entry), { recursive: true });
}

console.log("Preview build complete: dist/");
