import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  buildRendererCsp,
  resolveRendererAsset,
  type RendererAssetManifest,
} from "../src/main/protocol";

const manifest: RendererAssetManifest = new Map([
  [
    "/",
    {
      fileName: "index.html",
      mimeType: "text/html; charset=utf-8",
    },
  ],
  [
    "/assets/app.js",
    {
      fileName: "assets/app.js",
      mimeType: "text/javascript; charset=utf-8",
    },
  ],
]);

describe("renderer protocol", () => {
  test("renderer paths cannot escape the manifest root", () => {
    expect(
      resolveRendererAsset("qali-app://renderer/../../etc/passwd", manifest),
    ).toBeNull();
  });

  test("serves only manifest-listed renderer assets", () => {
    expect(
      resolveRendererAsset("qali-app://renderer/assets/app.js", manifest),
    ).toEqual({
      fileName: "assets/app.js",
      mimeType: "text/javascript; charset=utf-8",
    });
    expect(
      resolveRendererAsset("qali-app://renderer/assets/not-listed.js", manifest),
    ).toBeNull();
  });

  test("production renderer manifest lists its entry document", async () => {
    const files = JSON.parse(
      await readFile(
        resolve(import.meta.dirname, "../out/renderer/renderer-assets.json"),
        "utf8",
      ),
    ) as string[];

    expect(files).toContain("index.html");
    expect(files).toContain("icon.svg");
  });

  test("CSP admits only explicitly supplied loopback Convex origins", () => {
    const csp = buildRendererCsp([
      "http://127.0.0.1:3210",
      "ws://127.0.0.1:3210",
    ]);

    expect(csp).toContain("connect-src 'self' http://127.0.0.1:3210 ws://127.0.0.1:3210");
  });

  test("CSP rejects non-loopback and traversal-bearing Convex origins", () => {
    expect(() => buildRendererCsp(["https://convex.example.com"])).toThrow();
    expect(() => buildRendererCsp(["http://127.0.0.1:3210/../../etc/passwd"])).toThrow();
  });
});
