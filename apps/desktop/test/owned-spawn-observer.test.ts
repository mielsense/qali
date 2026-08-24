import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  beginOwnedSpawnObservation,
  finishOwnedSpawnObservation,
  observeOwnedSpawn,
  registerOwnedInstanceSecret,
} from "../src/main/processes/owned-spawn-observer";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true });
});

async function executable(name = "convex-local-backend"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "qali-owned-spawn-"));
  roots.push(root);
  const path = join(root, name);
  await writeFile(path, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await chmod(path, 0o700);
  return path;
}

describe("owned packaged process observations", () => {
  test("persists redacted executable, argv, and environment receipts", async () => {
    const command = await executable();
    const secret = "a".repeat(64);
    beginOwnedSpawnObservation();
    registerOwnedInstanceSecret(secret);
    observeOwnedSpawn(
      "convex-backend",
      command,
      ["--interface", "127.0.0.1", "--instance-secret", secret],
      { LANG: "C.UTF-8", PATH: "/usr/bin:/bin" },
    );

    const receipts = finishOwnedSpawnObservation();
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.executable).toMatchObject({
      bytes: 17,
      mode: 0o700,
      path: await realpath(command),
    });
    expect(receipts[0]?.executable.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(receipts[0]?.argv.map(({ classification }) => classification)).toEqual([
      "flag",
      "loopback",
      "flag",
      "convex-instance-secret",
    ]);
    expect(receipts[0]?.environment.map(({ key }) => key)).toEqual(["LANG", "PATH"]);
    expect(receipts[0]?.instanceSecretOccurrences).toEqual({
      argv: 1,
      environment: 0,
      executable: 0,
    });
    expect(JSON.stringify(receipts)).not.toContain(secret);
    expect(JSON.stringify(receipts)).not.toContain("C.UTF-8");
    expect(JSON.stringify(receipts)).not.toContain("/usr/bin:/bin");
  });

  test("fails closed when the instance secret reaches any non-backend spawn surface", async () => {
    const command = await executable("keychain-helper");
    const secret = "b".repeat(64);
    beginOwnedSpawnObservation();
    registerOwnedInstanceSecret(secret);
    observeOwnedSpawn("keychain-helper", command, [], {
      LANG: "C.UTF-8",
      LEAK: secret,
    });
    expect(() => finishOwnedSpawnObservation()).toThrow(
      "OWNED_SPAWN_INSTANCE_SECRET_BOUNDARY_VIOLATION",
    );
  });

  test("requires exactly one instance-secret argument on every backend spawn", async () => {
    const command = await executable();
    beginOwnedSpawnObservation();
    registerOwnedInstanceSecret("c".repeat(64));
    observeOwnedSpawn("convex-backend", command, ["--instance-secret", "wrong"], {
      LANG: "C.UTF-8",
    });
    expect(() => finishOwnedSpawnObservation()).toThrow(
      "OWNED_SPAWN_INSTANCE_SECRET_BOUNDARY_VIOLATION",
    );
  });
});
