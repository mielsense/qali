import { expect, test } from "bun:test";

import {
  createDesktopRendererConfig,
  desktopViteVersion,
} from "../src/renderer-config";

test("creates a desktop-owned Vite 7 renderer configuration", () => {
  const config = createDesktopRendererConfig({
    rendererEntry: "/workspace/apps/web/index.html",
    rendererOutDir: "/workspace/apps/desktop/out/renderer",
    rendererRoot: "/workspace/apps/web",
    rendererSourceRoot: "/workspace/apps/web/src",
  });

  expect(desktopViteVersion.startsWith("7.")).toBe(true);
  expect(config.root).toBe("/workspace/apps/web");
  expect(config.build?.rollupOptions?.input).toEqual({
    index: "/workspace/apps/web/index.html",
  });
  expect(
    config.plugins?.some(
      (plugin) => plugin.name === "qali:desktop-renderer-manifest",
    ),
  ).toBe(true);
});
