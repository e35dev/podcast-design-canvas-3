import { defineConfig } from "vitest/config";

export default defineConfig({
  build: {
    target: "es2018",
    cssCodeSplit: false,
    outDir: "dist",
    emptyOutDir: true,
    lib: {
      entry: "src/main.ts",
      formats: ["iife"],
      name: "PodcastDesignCanvas",
      fileName: () => "app.bundle.js",
    },
  },
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.ts"],
  },
});
