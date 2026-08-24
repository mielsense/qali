// @ts-expect-error Bun supplies its test module at runtime; the web app's
// TypeScript config intentionally includes browser globals only.
import { describe, expect, it } from "bun:test";

import { assistantCanSend } from "./assistant-readiness";

describe("assistantCanSend", () => {
  it("allows both full and degraded ready states", () => {
    expect(assistantCanSend({ kind: "ready" })).toBe(true);
    expect(assistantCanSend({ kind: "ready-degraded" })).toBe(true);
  });

  it("blocks states that still require user or runtime recovery", () => {
    expect(assistantCanSend({ kind: "probing" })).toBe(false);
    expect(assistantCanSend({ kind: "authentication-required" })).toBe(false);
    expect(assistantCanSend({ kind: "probe-failed" })).toBe(false);
    expect(assistantCanSend(undefined)).toBe(false);
  });
});
