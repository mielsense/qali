// @ts-expect-error Bun supplies its test module at runtime.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("assistant sign-in interaction", () => {
  test("opens the exact validated desktop login challenge", () => {
    const source = readFileSync(
      new URL("./assistant-panel.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain("desktopSessionSnapshot?.challenge");
    expect(source).toContain("desktopSession.openChallenge()");
    expect(source).toContain("openedLoginChallengeRef");
  });
});
