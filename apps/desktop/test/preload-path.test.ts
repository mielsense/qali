import { expect, test } from "bun:test";

import { resolvePreloadPath } from "../src/main/preload-path";

test("uses the sandbox-compatible CommonJS preload emitted beside the main bundle", () => {
  expect(
    resolvePreloadPath("file:///Applications/Qali.app/Contents/Resources/app.asar/out/main/index.js"),
  ).toBe("/Applications/Qali.app/Contents/Resources/app.asar/out/preload/index.cjs");
});
