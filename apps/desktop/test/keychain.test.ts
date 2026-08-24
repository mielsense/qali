import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";

import {
  createAppIdentity,
  type AppChannel,
  type AppIdentity,
} from "../src/main/identity";
import {
  KeychainUnavailableError,
  KeychainStore,
  resolveKeychainHelperPath,
  type KeychainRuntime,
  type KeychainSpawn,
} from "../src/main/keychain/keychain";

const temporaryRoots: string[] = [];

async function createRuntime(
  channel: AppChannel = "test",
  isPackaged = false,
  timeoutMs = 100,
) {
  const root = await mkdtemp(join(tmpdir(), "qali-keychain-"));
  temporaryRoots.push(root);
  const appData = join(root, "app-data");
  const appPath = join(root, "app");
  const resourcesPath = join(root, "packaged-resources");
  const helperRoot = isPackaged ? resourcesPath : join(appPath, "resources");
  const helperPath = join(helperRoot, "bin", "keychain-helper");
  await mkdir(appData, { recursive: true });
  await mkdir(join(helperRoot, "bin"), { recursive: true });
  await writeFile(helperPath, "helper fixture");
  await chmod(helperPath, 0o700);
  if (isPackaged) {
    const helper = await readFile(helperPath);
    await writeFile(
      join(resourcesPath, "packaged-resource-manifest.json"),
      `${JSON.stringify({
        entries: [
          {
            bytes: helper.byteLength,
            mode: 0o700,
            path: "bin/keychain-helper",
            sha256: createHash("sha256").update(helper).digest("hex"),
          },
        ],
        formatVersion: 2,
      })}\n`,
    );
  }
  return {
    identity: createAppIdentity(channel, appData),
    runtime: {
      appPath,
      isPackaged,
      resourcesPath,
      timeoutMs,
    } satisfies KeychainRuntime,
    helperPath,
    root,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

function captureSpawn(
  behavior:
    | { kind: "response"; response: unknown }
    | { kind: "stuck" }
    | { kind: "early-close" } = { kind: "response", response: { ok: true } },
) {
  const argv: string[] = [];
  let stdin = "";
  let killCount = 0;

  const spawn: KeychainSpawn = (command, args) => {
    argv.push(command, ...args);
    const child = new EventEmitter() as ReturnType<KeychainSpawn>;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const input = new Writable({
      write(chunk, _encoding, callback) {
        stdin += chunk.toString();
        callback();
      },
    });

    Object.assign(child, {
      stdin: input,
      stdout,
      stderr,
      kill: () => {
        killCount += 1;
        return true;
      },
    });
    if (behavior.kind === "response") {
      queueMicrotask(() => {
        stdout.end(`${JSON.stringify(behavior.response)}\n`);
        stderr.end();
        child.emit("close", 0, null);
      });
    } else if (behavior.kind === "early-close") {
      queueMicrotask(() => {
        const error = Object.assign(new Error("broken pipe"), {
          code: "EPIPE",
        });
        input.emit("error", error);
        child.emit("close", 1, null);
      });
    }
    return child;
  };

  return {
    spawn,
    argv,
    readStdin: () => stdin,
    readKillCount: () => killCount,
  };
}

describe("KeychainStore", () => {
  test("uses the login Keychain supported by an ad-hoc signed personal build", async () => {
    const helperSource = await readFile(
      join(import.meta.dir, "../native/keychain-helper/main.swift"),
      "utf8",
    );

    expect(helperSource).toContain("kSecClassGenericPassword");
    expect(helperSource).not.toContain("kSecUseDataProtectionKeychain");
    for (let index = 0; index < 8; index += 1) {
      expect(helperSource).toContain(`"google-account-v2-${index}"`);
    }
  });

  test("derives the channel service from immutable identity and keeps secrets out of argv", async () => {
    const { identity, runtime } = await createRuntime("development");
    const captured = captureSpawn();
    const store = new KeychainStore(identity, runtime, captured.spawn);

    await store.set("google-refresh-token", "canary-secret");

    expect(captured.argv.join(" ")).not.toContain("canary-secret");
    expect(JSON.parse(captured.readStdin())).toEqual({
      operation: "set",
      service: "com.qali.desktop.dev",
      account: "google-refresh-token",
      value: "canary-secret",
    });
  });

  test("rejects an identity forged to cross channel Keychain services", async () => {
    const { identity, runtime } = await createRuntime("test");
    const forgedIdentity = Object.freeze({
      ...identity,
      bundleId: "com.qali.desktop",
    }) as unknown as AppIdentity;

    expect(
      () => new KeychainStore(forgedIdentity, runtime, captureSpawn().spawn),
    ).toThrow("Keychain requires an immutable Qali application identity");
  });

  test("returns a stored secret only from the bounded helper response", async () => {
    const { identity, runtime } = await createRuntime();
    const captured = captureSpawn({
      kind: "response",
      response: { ok: true, value: "stored-secret" },
    });
    const store = new KeychainStore(identity, runtime, captured.spawn);

    await expect(store.get("local-jwt-signing-key")).resolves.toBe(
      "stored-secret",
    );
  });

  test("rejects malformed helper responses", async () => {
    const { identity, runtime } = await createRuntime();
    const captured = captureSpawn({
      kind: "response",
      response: { ok: true, value: 42 },
    });
    const store = new KeychainStore(identity, runtime, captured.spawn);

    await expect(store.get("google-refresh-token")).rejects.toThrow(
      "Invalid Keychain helper response",
    );
  });

  test("resolves packaged and development helper roots explicitly", async () => {
    const development = await createRuntime("test", false);
    const packaged = await createRuntime("stable", true);

    expect(resolveKeychainHelperPath(development.runtime)).toBe(
      await realpath(development.helperPath),
    );
    expect(resolveKeychainHelperPath(packaged.runtime)).toBe(
      await realpath(packaged.helperPath),
    );
  });

  test("rejects a helper symlink that escapes its owned resource root", async () => {
    const fixture = await createRuntime();
    const outside = join(fixture.root, "outside-helper");
    await writeFile(outside, "unexpected helper");
    await chmod(outside, 0o700);
    await rm(fixture.helperPath);
    await symlink(outside, fixture.helperPath);

    expect(() => resolveKeychainHelperPath(fixture.runtime)).toThrow(
      "Keychain helper must be a regular bundled executable",
    );
  });

  test("rejects containment escape through a helper parent symlink", async () => {
    const fixture = await createRuntime();
    const helperRoot = join(fixture.runtime.appPath, "resources");
    const outsideBin = join(fixture.root, "outside-bin");
    await mkdir(outsideBin);
    await writeFile(join(outsideBin, "keychain-helper"), "unexpected helper");
    await chmod(join(outsideBin, "keychain-helper"), 0o700);
    await rm(join(helperRoot, "bin"), { recursive: true });
    await symlink(outsideBin, join(helperRoot, "bin"));

    expect(() => resolveKeychainHelperPath(fixture.runtime)).toThrow(
      "Keychain helper resolves outside its owned resource root",
    );
  });

  test("rejects a missing helper before attempting spawn", async () => {
    const fixture = await createRuntime();
    await rm(fixture.helperPath);

    expect(() => resolveKeychainHelperPath(fixture.runtime)).toThrow(
      "Keychain helper must be a regular bundled executable",
    );
  });

  test("rejects a packaged helper whose sealed hash or size changed", async () => {
    const fixture = await createRuntime("stable", true);
    await writeFile(fixture.helperPath, "tampered packaged helper");
    await chmod(fixture.helperPath, 0o700);

    expect(() => resolveKeychainHelperPath(fixture.runtime)).toThrow(
      "Keychain helper failed packaged resource verification",
    );
  });

  test("rejects a packaged helper when its sealed manifest is absent", async () => {
    const fixture = await createRuntime("stable", true);
    await rm(
      join(fixture.runtime.resourcesPath, "packaged-resource-manifest.json"),
    );

    expect(() => resolveKeychainHelperPath(fixture.runtime)).toThrow(
      "Keychain helper failed packaged resource verification",
    );
  });

  test("times out and terminates a stuck helper with a recoverable error", async () => {
    const { identity, runtime } = await createRuntime("test", false, 10);
    const captured = captureSpawn({ kind: "stuck" });
    const store = new KeychainStore(identity, runtime, captured.spawn);

    const error = await store
      .get("google-refresh-token")
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(KeychainUnavailableError);
    expect(error).toMatchObject({ code: "timeout", recoverable: true });
    expect(captured.readKillCount()).toBe(1);
  });

  test("turns an early stdin EPIPE into a recoverable unavailable state", async () => {
    const { identity, runtime } = await createRuntime();
    const captured = captureSpawn({ kind: "early-close" });
    const store = new KeychainStore(identity, runtime, captured.spawn);

    const error = await store
      .set("google-refresh-token", "never-logged-secret")
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(KeychainUnavailableError);
    expect(error).toMatchObject({ code: "unavailable", recoverable: true });
    expect(String(error)).not.toContain("never-logged-secret");
  });
});
