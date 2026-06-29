import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const requiredPaths = [
  "index.html",
  "styles.css",
  "app/main.js",
  "app/model.js",
  "package.json"
];

for (const path of requiredPaths) {
  if (!existsSync(path)) {
    throw new Error(`Missing required file: ${path}`);
  }
}

const html = readFileSync("index.html", "utf8");
for (const fragment of ['href="styles.css"', 'src="app/model.js"', 'src="app/main.js"']) {
  if (!html.includes(fragment)) {
    throw new Error(`index.html is missing ${fragment}`);
  }
}

if (html.includes('type="module"')) {
  throw new Error("Static preview must not depend on browser module loading.");
}

rmSync("dist", { force: true, recursive: true });
mkdirSync("dist", { recursive: true });

for (const entry of ["index.html", "styles.css", "app"]) {
  cpSync(entry, join("dist", entry), { recursive: true });
}

console.log("Preview build complete: dist/");
