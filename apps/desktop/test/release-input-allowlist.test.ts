import { describe, expect, test } from "bun:test";

import {
  assertLocalDevelopmentSourceState,
  assertReleaseSourceState,
  assertSameReleaseInputPaths,
  compareReleaseInputEntries,
  declaredToolchainRoots,
  isDeclaredTrackedReleasePath,
} from "../../../scripts/desktop/lib/release-input-allowlist";

const base = {
  bytes: 10,
  mode: 0o644,
  sha256: "a".repeat(64),
};

describe("pre-build release input closure", () => {
  test("binds the invoked Electron packaging toolchain packages", () => {
    expect(declaredToolchainRoots()).toEqual(
      expect.arrayContaining([
        "apps/desktop/node_modules/electron-builder",
        "apps/desktop/node_modules/electron-vite",
        "apps/desktop/node_modules/vite",
        "node_modules/@electron/asar",
        "node_modules/.bun/esbuild@0.25.12/node_modules/esbuild",
        "node_modules/.bun/@esbuild+darwin-arm64@0.25.12/node_modules/@esbuild/darwin-arm64",
      ]),
    );
  });
  test("requires a committed clean source revision", () => {
    expect(assertReleaseSourceState("7".repeat(40), "", "")).toEqual({
      patchSha256:
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      revision: "7".repeat(40),
    });
    expect(() => assertReleaseSourceState("bad", "", "")).toThrow(
      "RELEASE_SOURCE_REVISION_INVALID",
    );
    expect(() =>
      assertReleaseSourceState("7".repeat(40), "M file", ""),
    ).toThrow("RELEASE_SOURCE_NOT_CLEAN");
    expect(() => assertReleaseSourceState("7".repeat(40), "", "diff")).toThrow(
      "RELEASE_SOURCE_NOT_CLEAN",
    );
  });

  test("records an explicit local development snapshot without weakening release cleanliness", () => {
    const proof = assertLocalDevelopmentSourceState(
      "7".repeat(40),
      " M apps/web/src/example.tsx\n",
      "diff --git a/example b/example",
    );

    expect(proof.revision).toBe("7".repeat(40));
    expect(proof.patchSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(proof.patchSha256).not.toBe(
      assertReleaseSourceState("7".repeat(40), "", "").patchSha256,
    );
    expect(() => assertLocalDevelopmentSourceState("bad", "", "")).toThrow(
      "RELEASE_SOURCE_REVISION_INVALID",
    );
  });
  test.each([
    "packages/backend/convex/injected.ts",
    "apps/desktop/node_modules/zod/v4/injected.js",
    "apps/desktop/resources/injected.txt",
    "apps/web/src/injected.tsx",
  ])("rejects an unlisted copied/source input: %s", (path) => {
    expect(compareReleaseInputEntries([], [{ ...base, path }])).toEqual([
      `RELEASE_INPUT_UNEXPECTED:${path}`,
    ]);
  });

  test("refuses to regenerate an allowlist that would bless a new path", () => {
    expect(() =>
      assertSameReleaseInputPaths(
        [],
        [
          {
            ...base,
            path: "packages/backend/convex/benign-review-proof.ts",
          },
        ],
      ),
    ).toThrow(
      "RELEASE_INPUT_PATH_SET_CHANGED:packages/backend/convex/benign-review-proof.ts",
    );
  });
  test("permits a committed desktop resource to enter the reviewed input closure", () => {
    expect(
      isDeclaredTrackedReleasePath(
        "apps/desktop/resources/google-oauth-client.json",
      ),
    ).toBe(true);
    expect(
      isDeclaredTrackedReleasePath("apps/desktop/resources/injected.txt"),
    ).toBe(true);
    expect(isDeclaredTrackedReleasePath("tmp/injected.txt")).toBe(false);
  });

  test("rejects missing, byte-changed, hash-changed, and mode-changed inputs", () => {
    const expected = [{ ...base, path: "packages/backend/convex/calendar.ts" }];
    expect(compareReleaseInputEntries(expected, [])).toEqual([
      "RELEASE_INPUT_MISSING:packages/backend/convex/calendar.ts",
    ]);
    for (const change of [
      { bytes: 11 },
      { mode: 0o600 },
      { sha256: "b".repeat(64) },
    ]) {
      expect(
        compareReleaseInputEntries(expected, [{ ...expected[0]!, ...change }]),
      ).toEqual(["RELEASE_INPUT_CHANGED:packages/backend/convex/calendar.ts"]);
    }
  });
});
