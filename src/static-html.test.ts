import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("file-open runtime", () => {
  it("uses only one classic standalone script from index.html", () => {
    const html = readFileSync(join(root, "index.html"), "utf8");

    expect(html).toContain('href="./src/styles.css"');
    expect(html).toContain('src="./src/standalone.js"');
    expect(html).not.toContain('type="module"');
    expect(html.match(/<script\b/g) ?? []).toHaveLength(1);
  });

  it("keeps the standalone runtime scoped to avoid duplicate global declarations", () => {
    const script = readFileSync(join(root, "src", "standalone.js"), "utf8");

    expect(script.trim().startsWith("(function () {")).toBe(true);
    expect(script.trim().endsWith("})();")).toBe(true);
    expect(script).not.toMatch(/\b(?:const|let|var)\s+PRESETS\b/);
    expect(script.match(/\bconst\s+presets\b/g) ?? []).toHaveLength(1);
  });
});
