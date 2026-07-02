// tests/_load.mjs — load the DOM-free model (presets.js + episode.js) into the
// CURRENT realm with a minimal `window` shim, so the browser's classic-script
// IIFEs can be exercised under plain Node with zero dependencies. Running in the
// current realm (not a fresh vm context) keeps the model's objects on the same
// Array/Object prototypes the tests use, so deepStrictEqual works as expected.
// preview.js and ui.js are intentionally NOT loaded here because they touch the DOM.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

// `extra` can seed properties (e.g. a mock `localStorage`) onto the fresh
// `window` before the modules run, so a test can simulate the SAME storage
// surviving across two otherwise-independent loadPDC() calls (a "reload").
export function loadPDC(root, extra) {
  globalThis.window = Object.assign({}, extra); // fresh namespace per load
  for (const file of ["app/presets.js", "app/episode.js", "app/moments.js", "app/templates.js"]) {
    const code = fs.readFileSync(path.join(root, file), "utf8");
    vm.runInThisContext(code, { filename: file });
  }
  return globalThis.window.PDC;
}
