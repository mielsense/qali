import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const release = await import("../../../scripts/desktop/release-macos").catch(
  (error: unknown) => ({ error }),
);

describe("signed macOS release orchestration", () => {
  test("requires one exact stable tag for the packaged application version", () => {
    expect("error" in release).toBe(false);
    if ("error" in release) return;

    expect(() => release.assertReleaseTag("0.2.0", "v0.2.0")).not.toThrow();
    expect(() => release.assertReleaseTag("0.2.0", "v0.2.1")).toThrow(
      "RELEASE_TAG_VERSION_MISMATCH",
    );
    expect(() => release.assertReleaseTag("0.2.0", "nightly")).toThrow(
      "RELEASE_TAG_INVALID",
    );
  });

  test("signs exact paths with hardened runtime, a timestamp, and explicit entitlements", () => {
    expect("error" in release).toBe(false);
    if ("error" in release) return;

    expect(
      release.releaseCodesignArguments(
        "/Applications/Qali.app",
        "Developer ID Application: Qali Example (ABCDE12345)",
        "/repo/apps/desktop/build/entitlements.mac.plist",
      ),
    ).toEqual([
      "--force",
      "--timestamp",
      "--options",
      "runtime",
      "--entitlements",
      "/repo/apps/desktop/build/entitlements.mac.plist",
      "--sign",
      "Developer ID Application: Qali Example (ABCDE12345)",
      "/Applications/Qali.app",
    ]);
    expect(
      release.releaseCodesignArguments(
        "/Applications/Qali.app/Contents/Resources/bin/keychain-helper",
        "Developer ID Application: Qali Example (ABCDE12345)",
      ),
    ).not.toContain("--deep");
  });

  test("creates updater-compatible zip and dmg artifacts from the already signed app", () => {
    expect("error" in release).toBe(false);
    if ("error" in release) return;
    const root = resolve(import.meta.dir, "../../..");
    const app = resolve(root, "dist/Qali.app");

    expect(release.releaseArtifactBuilderArguments(root, app)).toEqual([
      "--config",
      resolve(root, "apps/desktop/electron-builder.release.yml"),
      "--prepackaged",
      app,
      "--mac",
      "dmg",
      "zip",
      "--arm64",
      "--publish",
      "never",
    ]);
    expect(release.releaseArtifactNames("0.2.0")).toEqual([
      "Qali-0.2.0-arm64.dmg",
      "Qali-0.2.0-arm64.dmg.blockmap",
      "Qali-0.2.0-arm64.zip",
      "Qali-0.2.0-arm64.zip.blockmap",
      "latest-mac.yml",
    ]);
  });

  test("verifies that updater metadata describes the final distributable bytes", () => {
    expect("error" in release).toBe(false);
    if ("error" in release) return;
    const source = `version: 0.2.0
files:
  - url: Qali-0.2.0-arm64.zip
    sha512: zip-sha512
    size: 456
  - url: Qali-0.2.0-arm64.dmg
    sha512: dmg-sha512
    size: 123
path: Qali-0.2.0-arm64.zip
sha512: zip-sha512
releaseDate: '2026-08-21T12:00:00.000Z'
`;
    const artifacts = {
      "Qali-0.2.0-arm64.dmg": { bytes: 123, sha512: "dmg-sha512" },
      "Qali-0.2.0-arm64.zip": { bytes: 456, sha512: "zip-sha512" },
    };

    expect(() =>
      release.assertUpdateMetadata(source, "0.2.0", artifacts),
    ).not.toThrow();
    expect(() =>
      release.assertUpdateMetadata(source, "0.2.1", artifacts),
    ).toThrow("UPDATE_METADATA_VERSION_MISMATCH");
    expect(() =>
      release.assertUpdateMetadata(source, "0.2.0", {
        ...artifacts,
        "Qali-0.2.0-arm64.zip": { bytes: 457, sha512: "zip-sha512" },
      }),
    ).toThrow("UPDATE_METADATA_ARTIFACT_MISMATCH");
  });

  test("waits for notarization and rejects every non-accepted result", () => {
    expect("error" in release).toBe(false);
    if ("error" in release) return;

    expect(
      release.notarytoolSubmitArguments("/tmp/Qali.zip", {
        issuer: "00000000-0000-0000-0000-000000000000",
        keyId: "ABCDE12345",
        keyPath: "/tmp/AuthKey_ABCDE12345.p8",
      }),
    ).toEqual([
      "notarytool",
      "submit",
      "/tmp/Qali.zip",
      "--key",
      "/tmp/AuthKey_ABCDE12345.p8",
      "--key-id",
      "ABCDE12345",
      "--issuer",
      "00000000-0000-0000-0000-000000000000",
      "--wait",
      "--output-format",
      "json",
    ]);
    expect(
      release.parseAcceptedNotaryResult(
        JSON.stringify({
          id: "00000000-0000-0000-0000-000000000001",
          status: "Accepted",
        }),
      ),
    ).toEqual({
      id: "00000000-0000-0000-0000-000000000001",
      status: "Accepted",
    });
    expect(() =>
      release.parseAcceptedNotaryResult(
        JSON.stringify({
          id: "00000000-0000-0000-0000-000000000001",
          status: "Invalid",
        }),
      ),
    ).toThrow("NOTARIZATION_REJECTED");
  });
});
