// @ts-expect-error Bun supplies its test module at runtime; the web app's
// TypeScript config intentionally includes browser globals only.
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

describe("desktop route tree", () => {
  test("exposes Insights as a workspace route and never mounts public booking", async () => {
    const source = await readFile(
      new URL("./routeTree.desktop.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain('from "./routes/_workspace/insights"');
    expect(source).toContain("WorkspaceInsightsRoute");
    expect(source).not.toContain('from "./routes/$slug"');
    expect(source).not.toContain("SlugRoute");
  });
});
