import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function createElement(id) {
  return {
    id,
    className: "",
    dataset: {},
    disabled: false,
    hidden: false,
    href: "",
    innerHTML: "",
    textContent: "",
    value: "",
    addEventListener() {},
    appendChild() {},
    closest() {
      return null;
    },
    getContext() {
      return {
        addColorStop() {},
        arcTo() {},
        beginPath() {},
        clearRect() {},
        closePath() {},
        createLinearGradient() {
          return { addColorStop() {} };
        },
        fillRect() {},
        fillText() {},
        measureText(text) {
          return { width: text.length * 12 };
        },
        moveTo() {},
        restore() {},
        save() {},
        stroke() {}
      };
    },
    querySelector(selector) {
      if (selector === 'input[name="preset"]:checked') {
        return { value: "conversation-grid" };
      }
      const name = selector.match(/\[name="([^"]+)"\]/)?.[1];
      return name ? { value: "https://example.com/profile" } : null;
    },
    querySelectorAll() {
      return [
        { value: "" },
        { value: "" },
        { value: "" }
      ];
    },
    remove() {},
    setAttribute() {}
  };
}

test("browser scripts start together without fatal runtime errors", () => {
  const elements = new Map();
  const context = {
    console,
    URL: {
      createObjectURL() {
        return "blob:episode";
      },
      revokeObjectURL() {}
    },
    document: {
      createElement(tagName) {
        return createElement(tagName);
      },
      querySelector(selector) {
        const id = selector.startsWith("#") ? selector.slice(1) : selector;
        if (!elements.has(id)) {
          elements.set(id, createElement(id));
        }
        return elements.get(id);
      },
      querySelectorAll(selector) {
        if (selector === "[data-file-for]") {
          return ["host", "guest1", "guest2"].map((bucket) => ({
            dataset: { fileFor: bucket },
            value: "",
            addEventListener() {}
          }));
        }
        if (selector === "[data-social-for]") {
          return ["host", "guest1", "guest2"].map((bucket) => ({
            dataset: { socialFor: bucket },
            value: "",
            addEventListener() {}
          }));
        }
        if (selector === "[data-state-for]") {
          return ["host", "guest1", "guest2"].map((bucket) => ({
            classList: { toggle() {} },
            dataset: { stateFor: bucket },
            textContent: ""
          }));
        }
        return [];
      }
    },
    requestAnimationFrame() {
      return 1;
    },
    cancelAnimationFrame() {}
  };
  context.window = context;

  vm.createContext(context);

  assert.doesNotThrow(() => {
    vm.runInContext(readFileSync("app/model.js", "utf8"), context, { filename: "app/model.js" });
    vm.runInContext(readFileSync("app/main.js", "utf8"), context, { filename: "app/main.js" });
  });

  assert.ok(context.window.PodcastDesignCanvasModel);
  assert.equal(elements.get("compose-preview").disabled, false);
  assert.equal(elements.get("play-preview").disabled, true);
  assert.equal(elements.get("export-episode").disabled, true);
  assert.match(elements.get("status").textContent, /Start a new episode|Upload synced speaker tracks/);
});
