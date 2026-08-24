import { afterEach, describe, expect, test } from "bun:test";
import { lstat, mkdtemp, mkdir, readlink, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAppIdentity, IDENTITIES } from "../src/main/identity";
import type { KeychainService } from "../src/main/identity";
import { resolveQaliPaths } from "../src/main/paths";
import { acquireWriterLock } from "../src/main/single-instance";

const temporaryRoots: string[] = [];

async function makeTemporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "qali-identity-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("desktop application identity and paths", () => {
  test("test identity cannot resolve the stable root", async () => {
    const appData = await makeTemporaryRoot();
    const paths = resolveQaliPaths({ channel: "test", appData });

    expect(paths.root).toBe(join(await realpath(appData), IDENTITIES.test.namespace));
    expect(paths.root).not.toBe(join(await realpath(appData), IDENTITIES.stable.namespace));
    expect(paths.keychainService).toBe("com.qali.desktop.test");
    const narrowService: KeychainService = paths.keychainService;
    expect(narrowService).toBe(IDENTITIES.test.bundleId);
  });

  test("selected identity is immutable and channel-specific", async () => {
    const appData = await makeTemporaryRoot();
    const identity = createAppIdentity("development", appData);

    expect(Object.isFrozen(identity)).toBe(true);
    expect(identity).toEqual({
      channel: "development",
      appData,
      ...IDENTITIES.development,
    });
  });

  test("creates every data directory with user-only permissions", async () => {
    const appData = await makeTemporaryRoot();
    const paths = resolveQaliPaths({ channel: "test", appData });

    for (const path of [
      paths.root,
      paths.config,
      paths.database,
      paths.cache,
      paths.logs,
      paths.runtime,
      paths.backups,
      paths.exports,
      paths.codexHome,
    ]) {
      expect((await lstat(path)).mode & 0o777).toBe(0o700);
    }
    expect(paths.codexHome).toBe(join(paths.config, "codex-home"));
  });

  test("rejects a pre-existing directory that escapes through a symlink", async () => {
    const appData = await makeTemporaryRoot();
    const outside = await makeTemporaryRoot();
    const testRoot = join(appData, IDENTITIES.test.namespace);
    await mkdir(testRoot, { mode: 0o700 });
    await symlink(outside, join(testRoot, "database"));

    expect(() => resolveQaliPaths({ channel: "test", appData })).toThrow(
      "outside the Qali data root",
    );
    expect(await readlink(join(testRoot, "database"))).toBe(outside);
  });

  test("scopes the OS writer lock to the resolved root and focuses on relaunch", async () => {
    const appData = await makeTemporaryRoot();
    const paths = resolveQaliPaths({ channel: "test", appData });
    const events = new Map<string, () => void>();
    const calls: string[] = [];
    const application = {
      setPath(name: "userData", path: string) {
        calls.push(`set:${name}:${path}`);
      },
      requestSingleInstanceLock(data?: Record<string, string>) {
        calls.push(`lock:${data?.root}`);
        return true;
      },
      on(event: "second-instance", listener: () => void) {
        events.set(event, listener);
      },
    };
    const window = {
      focus: () => calls.push("focus"),
      isMinimized: () => true,
      restore: () => calls.push("restore"),
      show: () => calls.push("show"),
    };

    expect(acquireWriterLock(paths, application, () => [window])).toBe(true);
    events.get("second-instance")?.();

    expect(calls).toEqual([
      `set:userData:${paths.root}`,
      `lock:${paths.root}`,
      "restore",
      "show",
      "focus",
    ]);
  });

  test("keeps the explicit writer lock for packaged macOS launches", async () => {
    const appData = await makeTemporaryRoot();
    const paths = resolveQaliPaths({ channel: "test", appData });
    const calls: string[] = [];
    const application = {
      setPath(name: "userData", path: string) {
        calls.push(`set:${name}:${path}`);
      },
      requestSingleInstanceLock() {
        calls.push("electron-lock");
        return false;
      },
      on() {
        calls.push("electron-event");
      },
    };

    expect(acquireWriterLock(paths, application, () => [])).toBe(false);
    expect(calls).toEqual([
      `set:userData:${paths.root}`,
      "electron-lock",
    ]);
  });
});
