import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import {
  reclaimVerifiedOrphanBackend,
  spawnBackend,
  type BackendSpawn,
} from "../src/main/convex/process-driver";

const runtime = {
  backendExecutable: "/missing/convex-local-backend",
  databaseDirectory: "/tmp/qali-test/database",
  deploymentUrl: "http://127.0.0.1:43210",
  siteUrl: "http://127.0.0.1:43211",
  instanceName: "qali-test",
  instanceSecret: "a".repeat(64),
};

describe("spawnBackend", () => {
  test("turns an asynchronous spawn error into a controlled acquisition failure", async () => {
    class FakeChild extends EventEmitter {
      pid = 4242;
      stdout = new PassThrough();
      stderr = new PassThrough();
      exitCode: number | null = null;
      signalCode: NodeJS.Signals | null = null;
      unhandledSpawnError = false;

      override emit(event: string | symbol, ...args: unknown[]): boolean {
        if (event === "error" && this.listenerCount("error") === 0) {
          this.unhandledSpawnError = true;
          return false;
        }
        return super.emit(event, ...args);
      }
    }
    const child = new FakeChild();
    const spawn = (() => {
      queueMicrotask(() => {
        const error = Object.assign(new Error("spawn ENOENT"), {
          code: "ENOENT",
        });
        child.emit("error", error);
      });
      return child;
    }) as unknown as BackendSpawn;

    await expect(spawnBackend(runtime, () => undefined, spawn)).rejects.toThrow(
      "Convex backend could not start",
    );
    expect(child.unhandledSpawnError).toBe(false);
    expect(child.stdout.listenerCount("data")).toBe(0);
    expect(child.stderr.listenerCount("data")).toBe(0);
  });

  test("reclaims a force-quit orphan only from its signed ownership receipt", async () => {
    const root = await mkdtemp(join(tmpdir(), "qali-backend-reclaim-"));
    const receiptPath = join(root, "convex-backend-owner.json");
    class FakeChild extends EventEmitter {
      pid = 4242;
      stdout = new PassThrough();
      stderr = new PassThrough();
      exitCode: number | null = null;
      signalCode: NodeJS.Signals | null = null;
    }
    const child = new FakeChild();
    const spawn = (() => {
      queueMicrotask(() => child.emit("spawn"));
      return child;
    }) as unknown as BackendSpawn;
    const processIdentity = {
      pid: 4242,
      parentPid: 1,
      processGroupId: 4242,
      executable: runtime.backendExecutable,
      workingDirectory: runtime.databaseDirectory,
      startedAtMs: Date.now() - 1_000,
    };

    try {
      await spawnBackend(
        runtime,
        () => undefined,
        spawn,
        5_000,
        receiptPath,
        async () => processIdentity,
      );
      const receipt = await readFile(receiptPath, "utf8");
      expect(receipt).not.toContain(runtime.instanceSecret);
      expect((await stat(receiptPath)).mode & 0o777).toBe(0o600);

      let alive = true;
      const signals: NodeJS.Signals[] = [];
      const dependencies = {
        async inspectProcess(pid) {
          return { ...processIdentity, pid };
        },
        async findListeningProcess() {
          return 4242;
        },
        processGroupAlive: () => alive,
        signalProcessGroup(_pid, signal) {
          signals.push(signal);
          alive = false;
        },
        sleep: async () => undefined,
      } as const;

      const tampered = JSON.parse(receipt) as {
        payload: { workingDirectory: string };
      };
      tampered.payload.workingDirectory = "/tmp/not-qali";
      await writeFile(receiptPath, JSON.stringify(tampered));
      await expect(
        reclaimVerifiedOrphanBackend(runtime, receiptPath, dependencies),
      ).resolves.toBe(false);
      expect(signals).toEqual([]);

      await writeFile(receiptPath, receipt);
      processIdentity.parentPid = 999;
      await expect(
        reclaimVerifiedOrphanBackend(runtime, receiptPath, dependencies),
      ).resolves.toBe(false);
      expect(signals).toEqual([]);

      processIdentity.parentPid = 1;
      processIdentity.executable = "/usr/bin/unrelated";
      await expect(
        reclaimVerifiedOrphanBackend(runtime, receiptPath, dependencies),
      ).resolves.toBe(false);
      expect(signals).toEqual([]);

      processIdentity.executable = runtime.backendExecutable;
      const originalStart = processIdentity.startedAtMs;
      processIdentity.startedAtMs = Date.now() + 60_000;
      await expect(
        reclaimVerifiedOrphanBackend(runtime, receiptPath, dependencies),
      ).resolves.toBe(false);
      expect(signals).toEqual([]);

      processIdentity.startedAtMs = originalStart;
      await expect(
        reclaimVerifiedOrphanBackend(runtime, receiptPath, dependencies),
      ).resolves.toBe(true);
      expect(signals).toEqual(["SIGTERM"]);
      await expect(readFile(receiptPath, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("publishes the detached child identity before slow ownership inspection", async () => {
    const root = await mkdtemp(join(tmpdir(), "qali-backend-intent-"));
    const receiptPath = join(root, "convex-backend-owner.json");
    class FakeChild extends EventEmitter {
      pid = 999_999;
      stdout = new PassThrough();
      stderr = new PassThrough();
      exitCode: number | null = null;
      signalCode: NodeJS.Signals | null = null;
    }
    const child = new FakeChild();
    const spawn = (() => {
      queueMicrotask(() => child.emit("spawn"));
      return child;
    }) as unknown as BackendSpawn;
    let rejectInspection!: (error: Error) => void;

    try {
      const abandonedSpawn = spawnBackend(
        runtime,
        () => undefined,
        spawn,
        0,
        receiptPath,
        async () =>
          await new Promise<never>((_resolve, reject) => {
            rejectInspection = reject;
          }),
      );
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const receipt = await readFile(receiptPath, "utf8").catch(() => "");
        if (receipt.includes('"phase":"spawned"')) break;
        await Bun.sleep(5);
      }

      let alive = true;
      const signals: NodeJS.Signals[] = [];
      const startedAtMs = Date.now();
      let discoveryAttempts = 0;
      const identity = {
        pid: child.pid,
        parentPid: 1,
        processGroupId: child.pid,
        executable: runtime.backendExecutable,
        workingDirectory: runtime.databaseDirectory,
        startedAtMs,
      };
      await expect(
        reclaimVerifiedOrphanBackend(runtime, receiptPath, {
          inspectProcess: async () => identity,
          findListeningProcess: async () => {
            discoveryAttempts += 1;
            return null;
          },
          processGroupAlive: () => alive,
          signalProcessGroup(_pid, signal) {
            signals.push(signal);
            alive = false;
          },
          sleep: async () => undefined,
        }),
      ).resolves.toBe(true);
      expect(discoveryAttempts).toBe(0);
      expect(signals).toEqual(["SIGTERM"]);

      rejectInspection(new Error("parent exited before ownership acquisition"));
      await expect(abandonedSpawn).rejects.toThrow(
        "Convex backend ownership receipt could not be secured",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not wait thirty seconds on a legacy intent with no process evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "qali-backend-stale-intent-"));
    const receiptPath = join(root, "convex-backend-owner.json");
    class FakeChild extends EventEmitter {
      pid = 424_242;
      stdout = new PassThrough();
      stderr = new PassThrough();
      exitCode: number | null = null;
      signalCode: NodeJS.Signals | null = null;
    }
    const child = new FakeChild();
    const spawn = (() => child) as unknown as BackendSpawn;
    const pending = spawnBackend(
      runtime,
      () => undefined,
      spawn,
      0,
      receiptPath,
    );

    try {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (await readFile(receiptPath, "utf8").catch(() => "")) break;
        await Bun.sleep(5);
      }

      let discoveryAttempts = 0;
      let sleeps = 0;
      await expect(
        reclaimVerifiedOrphanBackend(runtime, receiptPath, {
          inspectProcess: async () => null,
          findListeningProcess: async () => {
            discoveryAttempts += 1;
            return null;
          },
          processGroupAlive: () => false,
          signalProcessGroup: () => undefined,
          sleep: async () => {
            sleeps += 1;
          },
        }),
      ).resolves.toBe(false);
      expect(discoveryAttempts).toBe(1);
      expect(sleeps).toBe(0);
    } finally {
      child.emit("error", new Error("stop pending fake spawn"));
      await pending.catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });
});
