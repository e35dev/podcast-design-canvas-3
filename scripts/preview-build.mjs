import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, "dist");
const distSrc = join(dist, "src");

await rm(dist, { recursive: true, force: true });
await mkdir(distSrc, { recursive: true });
await cp(join(root, "index.html"), join(dist, "index.html"));
await cp(join(root, "src", "styles.css"), join(distSrc, "styles.css"));
await cp(join(root, "src", "standalone.js"), join(distSrc, "standalone.js"));

const html = await readFile(join(dist, "index.html"), "utf8");

for (const expected of ['href="./src/styles.css"', 'src="./src/standalone.js"']) {
  if (!html.includes(expected)) {
    throw new Error(`preview-build missing file-compatible reference: ${expected}`);
  }
}

console.log("Built file-compatible preview to dist/.");
