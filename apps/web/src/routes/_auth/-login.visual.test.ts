// @ts-expect-error Bun supplies its test module at runtime; the web app's
// TypeScript config intentionally includes browser globals only.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./login.tsx", import.meta.url), "utf8");

describe("desktop sign-in visual contract", () => {
  test("uses the neutral product surface instead of a calendar event color", () => {
    expect(source).toContain("qali-surface--floating");
    expect(source).toContain('src="/icon.svg"');
    expect(source).toContain("motion.div");
    expect(source).not.toContain("var(--event-6)");
    expect(source).not.toContain("absolute top-2 bottom-2 left-2");
  });

  test("explains the local-first sign-in boundary", () => {
    expect(source).toContain("Your calendar stays local");
    expect(source).toContain("Qali never sees your Google password");
  });
});
