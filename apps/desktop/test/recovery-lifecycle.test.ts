import { describe, expect, test } from "bun:test";

import { createOwnedResourceDrain, RecoveryLifecycle } from "../src/main/recovery/lifecycle";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("recovery lifecycle", () => {
  test("uses one drain promise and rejects concurrent restore/reset mutations", async () => {
    const draining = deferred();
    let drains = 0;
    const lifecycle = new RecoveryLifecycle(async () => {
      drains += 1;
      await draining.promise;
    });
    let restored = false;
    const restore = lifecycle.run("restore", async () => {
      restored = true;
    });
    await Promise.resolve();

    await expect(lifecycle.run("reset", async () => {})).rejects.toThrow("RECOVERY_IN_PROGRESS");
    draining.resolve();
    await restore;
    expect(drains).toBe(1);
    expect(restored).toBe(true);
  });

  test("retries drain failure and safely reuses a completed drain after mutation failure", async () => {
    let drains = 0;
    const lifecycle = new RecoveryLifecycle(async () => {
      drains += 1;
      if (drains === 1) throw new Error("drain failed");
    });
    await expect(lifecycle.run("restore", async () => {})).rejects.toThrow("drain failed");
    await expect(
      lifecycle.run("restore", async () => {
        throw new Error("restore failed");
      }),
    ).rejects.toThrow("restore failed");
    await expect(lifecycle.run("restore", async () => {})).resolves.toBeUndefined();
    expect(drains).toBe(2);
  });

  test("drains every owned producer before closing the database and auth issuer", async () => {
    const calls: string[] = [];
    const drain = createOwnedResourceDrain({
      revokeIpcProducers: async () => {
        calls.push("revoke-ipc");
      },
      stopProviderMigration: async () => {
        calls.push("migration");
      },
      stopOnlineMonitor: async () => {
        calls.push("online");
      },
      disposeGoogleIpc: async () => {
        calls.push("google-ipc");
      },
      disposeAssistant: async () => {
        calls.push("assistant");
      },
      stopGoogleWorker: async () => {
        calls.push("google-worker");
      },
      closeCalendarBroker: async () => {
        calls.push("broker");
      },
      drainConvex: async () => {
        calls.push("convex-drain");
      },
      stopConvex: async () => {
        calls.push("convex-stop");
      },
      closeAuthIssuer: async () => {
        calls.push("auth");
      },
    });

    await drain();
    expect(calls).toEqual([
      "revoke-ipc",
      "migration",
      "online",
      "google-ipc",
      "assistant",
      "google-worker",
      "broker",
      "convex-drain",
      "convex-stop",
      "auth",
    ]);
  });

  test("shutdown joins an active recovery mutation before it resolves", async () => {
    const mutation = deferred();
    const lifecycle = new RecoveryLifecycle(async () => {});
    let mutationFinished = false;
    const restore = lifecycle.run("restore", async () => {
      await mutation.promise;
      mutationFinished = true;
    });
    await Promise.resolve();

    let shutdownFinished = false;
    const shutdown = lifecycle.shutdown().then(() => {
      shutdownFinished = true;
    });
    await Promise.resolve();
    expect(shutdownFinished).toBe(false);
    await expect(lifecycle.run("reset", async () => {})).rejects.toThrow("RECOVERY_UNAVAILABLE");

    mutation.resolve();
    await Promise.all([restore, shutdown]);
    expect(mutationFinished).toBe(true);
    expect(shutdownFinished).toBe(true);
  });

  test("shutdown retries a failed drain and fails closed until a later retry succeeds", async () => {
    let drains = 0;
    const lifecycle = new RecoveryLifecycle(async () => {
      drains += 1;
      if (drains < 3) throw new Error(`drain-${drains}`);
    });
    await expect(lifecycle.run("restore", async () => {})).rejects.toThrow("drain-1");
    await expect(lifecycle.shutdown()).rejects.toThrow("drain-2");
    await expect(lifecycle.run("reset", async () => {})).rejects.toThrow("RECOVERY_UNAVAILABLE");
    await expect(lifecycle.shutdown()).resolves.toBeUndefined();
    expect(drains).toBe(3);
  });

  test("owned drain attempts every later resource when an earlier disposer fails", async () => {
    const calls: string[] = [];
    const drain = createOwnedResourceDrain({
      revokeIpcProducers: () => {
        calls.push("revoke");
      },
      stopProviderMigration: async () => {
        calls.push("migration");
      },
      stopOnlineMonitor: () => {
        calls.push("online");
      },
      disposeGoogleIpc: async () => {
        calls.push("google");
        throw new Error("dispose failed");
      },
      disposeAssistant: async () => {
        calls.push("assistant");
      },
      stopGoogleWorker: async () => {
        calls.push("worker");
      },
      closeCalendarBroker: async () => {
        calls.push("broker");
      },
      drainConvex: async () => {
        calls.push("convex-drain");
      },
      stopConvex: async () => {
        calls.push("convex-stop");
      },
      closeAuthIssuer: async () => {
        calls.push("auth");
      },
    });

    await expect(drain()).rejects.toThrow("dispose failed");
    expect(calls).toEqual([
      "revoke",
      "migration",
      "online",
      "google",
      "assistant",
      "worker",
      "broker",
      "convex-drain",
      "convex-stop",
      "auth",
    ]);
  });
});
