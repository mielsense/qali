import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const rendererRoot = join(import.meta.dir, "../out/renderer");
const webRoot = join(import.meta.dir, "../../web/src");

describe("packaged desktop renderer isolation", () => {
  test("marks the dedicated desktop document before rendering native chrome", async () => {
    const entry = await readFile(join(webRoot, "main.desktop.tsx"), "utf8");
    expect(entry).toContain("applyDesktopDocumentChrome(document.documentElement, true)");
  });

  test("contains no hosted Better Auth or Google social-login route", async () => {
    const assets = JSON.parse(
      await readFile(join(rendererRoot, "renderer-assets.json"), "utf8"),
    ) as string[];
    expect(assets.some((asset) => /(?:^|\/)login-[^/]+\.js$/.test(asset))).toBe(false);

    const executableAssets = assets.filter((asset) =>
      asset === "index.html" || asset.endsWith(".js"),
    );
    let bytes = 0;
    const contents: string[] = [];
    for (const asset of executableAssets) {
      const value = await readFile(join(rendererRoot, asset), "utf8");
      bytes += Buffer.byteLength(value, "utf8");
      if (bytes > 16 * 1024 * 1024) throw new Error("Desktop renderer artifact is unexpectedly large");
      contents.push(value);
    }
    const artifact = contents.join("\n");
    expect(artifact).not.toMatch(/better-auth/i);
    expect(artifact).not.toContain("/api/auth");
    expect(artifact).not.toContain("authClient.signIn.social");
    expect(artifact).not.toContain('errorCallbackURL: "/login"');
  });
});
