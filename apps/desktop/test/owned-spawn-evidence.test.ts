import { describe, expect, test } from "bun:test";

import {
  assertOwnedSpawnEvidence,
  parseCompleteSmokeMarker,
} from "../../../scripts/desktop/lib/owned-spawn-evidence";

const hash = "a".repeat(64);
const secretHash = "b".repeat(64);

function receipt(kind: string, secret = kind === "convex-backend") {
  return {
    argv: secret
      ? [{ classification: "convex-instance-secret", index: 0, sha256: secretHash }]
      : [],
    environment: [
      { classification: "configuration", key: "LANG", sha256: hash },
      { classification: "path", key: "PATH", sha256: hash },
    ],
    executable: { bytes: 17, mode: 0o700, path: `/owned/${kind}`, sha256: hash },
    instanceSecretOccurrences: {
      argv: secret ? 1 : 0,
      environment: 0,
      executable: 0,
    },
    kind,
  };
}

describe("packaged owned-spawn evidence", () => {
  test("retries a marker that is observable before its write completes", () => {
    expect(parseCompleteSmokeMarker('{"formatVersion":2')).toBeNull();
    expect(parseCompleteSmokeMarker('{"formatVersion":2}')).toEqual({
      formatVersion: 2,
    });
  });
  test("accepts all owned spawn kinds with the sole backend secret fingerprint", () => {
    const receipts = [
      receipt("convex-keygen", false),
      receipt("keychain-helper", false),
      receipt("convex-deploy-cli", false),
      receipt("convex-backend", true),
    ];
    expect(() => assertOwnedSpawnEvidence({
      expectedExecutableSha256: {
        "convex-backend": hash,
        "convex-deploy-cli": hash,
        "convex-keygen": hash,
        "keychain-helper": hash,
      },
      instanceSecretSha256: secretHash,
      receipts,
    })).not.toThrow();
  });

  test("rejects a secret fingerprint on another argv or environment surface", () => {
    const leaked = receipt("keychain-helper", false);
    leaked.environment[0]!.sha256 = secretHash;
    expect(() => assertOwnedSpawnEvidence({
      expectedExecutableSha256: { "keychain-helper": hash },
      instanceSecretSha256: secretHash,
      receipts: [leaked],
    })).toThrow("PACKAGED_SMOKE_OWNED_SPAWN_SECRET_LEAK");
  });

  test("rejects an executable that differs from the verified package", () => {
    expect(() => assertOwnedSpawnEvidence({
      expectedExecutableSha256: { "keychain-helper": "c".repeat(64) },
      instanceSecretSha256: secretHash,
      receipts: [receipt("keychain-helper", false)],
    })).toThrow("PACKAGED_SMOKE_OWNED_EXECUTABLE_MISMATCH");
  });
});
