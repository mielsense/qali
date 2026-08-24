import { defineConfig } from "electron-vite";
import { resolve } from "node:path";

import { createDesktopRendererConfig } from "./src/renderer-config";

export default defineConfig({
  main: {
    build: {
      externalizeDeps: {
        exclude: ["@qali/desktop-contracts"],
      },
      outDir: "out/main",
      rollupOptions: {
        external: ["original-fs"],
        input: {
          index: resolve(__dirname, "src/main/index.ts"),
        },
      },
    },
  },
  preload: {
    build: {
      externalizeDeps: {
        exclude: ["@qali/desktop-contracts", "zod"],
      },
      outDir: "out/preload",
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/preload/index.ts"),
        },
        output: {
          entryFileNames: "index.cjs",
          format: "cjs",
        },
      },
    },
  },
  renderer: createDesktopRendererConfig({
    rendererEntry: resolve(__dirname, "../web/index.desktop.html"),
    rendererOutDir: resolve(__dirname, "out/renderer"),
    rendererRoot: resolve(__dirname, "../web"),
    rendererSourceRoot: resolve(__dirname, "../web/src"),
    desktopAuthClient: resolve(__dirname, "../web/src/lib/auth-client.desktop.ts"),
  }),
});
