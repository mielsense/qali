import { describe, expect, test } from "bun:test";

import {
  cleanupLegacyProviderReferences,
  LegacyProviderMigrationCoordinator,
  requireLegacyProviderMigration,
} from "../src/main/migration/provider-cleanup";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe("legacy provider reference cleanup", () => {
  test("does nothing until the Keychain-backed Google connection is established", async () => {
    let calls = 0;
    await expect(cleanupLegacyProviderReferences({
      googleStatus: async () => ({ kind: "disconnected" }),
      cleanupPage: async () => { calls += 1; return { done: true }; },
    })).resolves.toEqual({ kind: "deferred", reason: "disconnected" });
    expect(calls).toBe(0);
  });

  test("runs bounded pages idempotently only after a connected status", async () => {
    const cursors: Array<string | undefined> = [];
    await expect(cleanupLegacyProviderReferences({
      googleStatus: async () => ({ kind: "connected" }),
      cleanupPage: async (cursor) => {
        cursors.push(cursor);
        return cursors.length === 1
          ? { done: false, cursor: "page-2", cleared: 25 }
          : { done: true, cleared: 0 };
      },
    })).resolves.toEqual({ kind: "completed", cleared: 25 });
    expect(cursors).toEqual([undefined, "page-2"]);
  });

  test("fails closed on an unbounded or malformed cursor loop", async () => {
    await expect(cleanupLegacyProviderReferences({
      googleStatus: async () => ({ kind: "connected" }),
      cleanupPage: async () => ({ done: false, cursor: "same", cleared: 1 }),
    })).rejects.toThrow("MIGRATION_CURSOR_REPEATED");
  });

  test("a deferred migration resumes single-flight and contracts only after cleanup", async () => {
    let connected = false;
    let cleanupCalls = 0;
    let contractions = 0;
    const coordinator = new LegacyProviderMigrationCoordinator({
      googleStatus: async () => ({ kind: connected ? "connected" : "disconnected" }),
      cleanupPage: async () => {
        cleanupCalls += 1;
        return { done: true, cleared: 2 };
      },
      completeMigration: async () => { contractions += 1; },
    });

    await expect(coordinator.resume()).resolves.toEqual({
      kind: "deferred",
      reason: "disconnected",
    });
    expect(contractions).toBe(0);
    connected = true;
    await Promise.all([coordinator.resume(), coordinator.resume(), coordinator.resume()]);
    await coordinator.resume();
    expect(cleanupCalls).toBe(1);
    expect(contractions).toBe(1);
  });

  test("defers a retryable cleanup failure and contracts once after every retry page completes", async () => {
    let cleanupAttempt = 0;
    const calls: Array<string | undefined> = [];
    let contractions = 0;
    const coordinator = new LegacyProviderMigrationCoordinator({
      googleStatus: async () => ({ kind: "connected" }),
      cleanupPage: async (cursor) => {
        calls.push(cursor);
        cleanupAttempt += 1;
        if (cleanupAttempt === 1) throw new Error("temporary broker failure");
        return cleanupAttempt === 2
          ? { done: false, cursor: "page-2", cleared: 1 }
          : { done: true, cleared: 2 };
      },
      completeMigration: async () => { contractions += 1; },
    });

    await expect(coordinator.resume()).resolves.toEqual({
      kind: "deferred",
      reason: "cleanup-failed",
    });
    expect(contractions).toBe(0);

    await expect(coordinator.resume()).resolves.toEqual({
      kind: "completed",
      cleared: 3,
    });
    await coordinator.resume();

    expect(calls).toEqual([undefined, undefined, "page-2"]);
    expect(contractions).toBe(1);
  });

  test("defers a retryable schema contraction readiness failure for a later resume", async () => {
    let contractions = 0;
    const coordinator = new LegacyProviderMigrationCoordinator({
      googleStatus: async () => ({ kind: "connected" }),
      cleanupPage: async () => ({ done: true, cleared: 1 }),
      completeMigration: async () => {
        contractions += 1;
        if (contractions === 1) {
          throw new Error("Local calendar service is not ready for schema contraction");
        }
      },
    });

    await expect(coordinator.resume()).resolves.toEqual({
      kind: "deferred",
      reason: "migration-failed",
    });
    await expect(coordinator.resume()).resolves.toEqual({
      kind: "completed",
      cleared: 1,
    });
    expect(contractions).toBe(2);
  });

  test("shares one in-flight resume across concurrent callers", async () => {
    const cleanupStarted = deferred<void>();
    const finishCleanup = deferred<void>();
    let cleanupCalls = 0;
    let contractions = 0;
    const coordinator = new LegacyProviderMigrationCoordinator({
      googleStatus: async () => ({ kind: "connected" }),
      cleanupPage: async () => {
        cleanupCalls += 1;
        cleanupStarted.resolve();
        await finishCleanup.promise;
        return { done: true, cleared: 1 };
      },
      completeMigration: async () => { contractions += 1; },
    });

    const first = coordinator.resume();
    await cleanupStarted.promise;
    const second = coordinator.resume();
    const third = coordinator.resume();
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(cleanupCalls).toBe(1);

    finishCleanup.resolve();
    await expect(Promise.all([first, second, third])).resolves.toEqual([
      { kind: "completed", cleared: 1 },
      { kind: "completed", cleared: 1 },
      { kind: "completed", cleared: 1 },
    ]);
    expect(contractions).toBe(1);
  });

  test("keeps the schema expanded when cleanup cursors repeat or exhaust the page bound", async () => {
    let contractions = 0;
    const repeatedCursor = new LegacyProviderMigrationCoordinator({
      googleStatus: async () => ({ kind: "connected" }),
      cleanupPage: async () => ({ done: false, cursor: "same", cleared: 0 }),
      completeMigration: async () => { contractions += 1; },
    });
    let pages = 0;
    const boundedPages = new LegacyProviderMigrationCoordinator({
      googleStatus: async () => ({ kind: "connected" }),
      cleanupPage: async () => {
        pages += 1;
        return { done: false, cursor: `page-${pages}`, cleared: 0 };
      },
      completeMigration: async () => { contractions += 1; },
    });

    await expect(repeatedCursor.resume()).resolves.toEqual({
      kind: "deferred",
      reason: "cleanup-failed",
    });
    await expect(boundedPages.resume()).resolves.toEqual({
      kind: "deferred",
      reason: "cleanup-failed",
    });

    expect(pages).toBe(100);
    expect(contractions).toBe(0);
  });

  test("stop joins in-flight cleanup and prevents a later schema contraction", async () => {
    const cleanupStarted = deferred<void>();
    const finishCleanup = deferred<void>();
    let contractions = 0;
    const coordinator = new LegacyProviderMigrationCoordinator({
      googleStatus: async () => ({ kind: "connected" }),
      cleanupPage: async () => {
        cleanupStarted.resolve();
        await finishCleanup.promise;
        return { done: true, cleared: 1 };
      },
      completeMigration: async () => { contractions += 1; },
    });

    const resume = coordinator.resume();
    await cleanupStarted.promise;
    let stopped = false;
    const stop = coordinator.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);

    finishCleanup.resolve();
    await expect(resume).resolves.toEqual({ kind: "deferred", reason: "stopped" });
    await stop;
    await expect(coordinator.resume()).resolves.toEqual({
      kind: "deferred",
      reason: "stopped",
    });
    expect(contractions).toBe(0);
  });

  test("restore verification fails controlled while disconnected and never contracts", async () => {
    let contractions = 0;
    await expect(requireLegacyProviderMigration({
      googleStatus: async () => ({ kind: "disconnected" }),
      cleanupPage: async () => ({ done: true }),
      completeMigration: async () => { contractions += 1; },
    })).rejects.toThrow("RESTORE_MIGRATION_DEFERRED");
    expect(contractions).toBe(0);
  });

  test("restore verification cleans legacy rows before schema contraction", async () => {
    const calls: string[] = [];
    await requireLegacyProviderMigration({
      googleStatus: async () => ({ kind: "connected" }),
      cleanupPage: async () => { calls.push("cleanup"); return { done: true }; },
      completeMigration: async () => { calls.push("contract"); },
    });
    expect(calls).toEqual(["cleanup", "contract"]);
  });
});
