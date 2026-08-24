import { describe, expect, test } from "bun:test";

import {
  GoogleSyncSupervisor,
  type SyncCycleGate,
} from "../src/main/google/sync-supervisor";
import type {
  GoogleSyncStatus,
  SyncWakeTrigger,
} from "../src/main/google/sync-worker";

class FakeClock {
  readonly timers: Array<{ cancelled: boolean; delay: number; run(): void }> =
    [];
  readonly setTimer = ((run: () => void, delay = 0) => {
    this.timers.push({ cancelled: false, delay, run });
    return this.timers.length;
  }) as unknown as typeof setTimeout;
  readonly clearTimer = ((id: number) => {
    const timer = this.timers[id - 1];
    if (timer) timer.cancelled = true;
  }) as unknown as typeof clearTimeout;

  runAll(): void {
    for (const timer of this.timers.sort((a, b) => a.delay - b.delay)) {
      if (!timer.cancelled) timer.run();
    }
    this.timers.length = 0;
  }
}

class FakeWorker {
  readonly calls: string[] = [];
  readonly #listeners = new Set<(status: GoogleSyncStatus) => void>();
  status: GoogleSyncStatus = { kind: "idle" };

  constructor(
    readonly accountId: string,
    readonly gate: SyncCycleGate,
  ) {}

  start(): void {
    this.calls.push("start");
  }

  wake(trigger: SyncWakeTrigger): void {
    this.calls.push(`wake:${trigger}`);
  }

  async drain(): Promise<void> {
    this.calls.push("drain");
  }

  async stop(): Promise<void> {
    this.calls.push("stop");
  }

  onStatus(listener: (status: GoogleSyncStatus) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  emit(status: GoogleSyncStatus): void {
    this.status = status;
    for (const listener of this.#listeners) listener(status);
  }
}

describe("GoogleSyncSupervisor", () => {
  test("ignores account discovery that completes after stop", async () => {
    let resolve!: (ids: readonly string[]) => void;
    const discovery = new Promise<readonly string[]>((done) => {
      resolve = done;
    });
    const workers: FakeWorker[] = [];
    const supervisor = new GoogleSyncSupervisor({
      createWorker: (accountId, gate) => {
        const worker = new FakeWorker(accountId, gate);
        workers.push(worker);
        return worker;
      },
      listAccountIds: async () => await discovery,
    });
    const starting = supervisor.start();
    await supervisor.stop();
    resolve(["gacc_late"]);
    await starting;
    expect(workers).toEqual([]);
  });

  test("latest overlapping refresh wins and stale discovery cannot remove it", async () => {
    const resolvers: Array<(ids: readonly string[]) => void> = [];
    const workers = new Map<string, FakeWorker>();
    const supervisor = new GoogleSyncSupervisor({
      createWorker: (accountId, gate) => {
        const worker = new FakeWorker(accountId, gate);
        workers.set(accountId, worker);
        return worker;
      },
      listAccountIds: async () =>
        await new Promise<readonly string[]>((resolve) =>
          resolvers.push(resolve),
        ),
      staggerMs: 0,
    });
    const stale = supervisor.start();
    const latest = supervisor.refreshAccounts();
    resolvers[1]!(["gacc_current"]);
    await latest;
    resolvers[0]!([]);
    await stale;
    expect(supervisor.statuses()).toEqual({ gacc_current: { kind: "idle" } });
    expect(workers.get("gacc_current")!.calls).not.toContain("stop");
  });

  test("a refresh that resumes from drain cannot overwrite the newer account set", async () => {
    let accountIds: readonly string[] = ["gacc_current"];
    let releaseDrain!: () => void;
    let reportDrainStarted!: () => void;
    const drainBarrier = new Promise<void>((resolve) => {
      releaseDrain = resolve;
    });
    const drainStarted = new Promise<void>((resolve) => {
      reportDrainStarted = resolve;
    });
    const workers: FakeWorker[] = [];
    const supervisor = new GoogleSyncSupervisor({
      createWorker: (accountId, gate) => {
        const worker = new FakeWorker(accountId, gate);
        if (workers.length === 0) {
          worker.drain = async () => {
            worker.calls.push("drain");
            reportDrainStarted();
            await drainBarrier;
          };
        }
        workers.push(worker);
        return worker;
      },
      listAccountIds: async () => accountIds,
      staggerMs: 0,
    });
    await supervisor.start();

    accountIds = ["gacc_stale"];
    const staleRemoval = supervisor.refreshAccounts();
    await drainStarted;
    accountIds = ["gacc_current"];
    await supervisor.refreshAccounts();
    releaseDrain();
    await staleRemoval;

    expect(workers).toHaveLength(2);
    expect(supervisor.statuses()).toEqual({
      gacc_current: { kind: "idle" },
    });
    expect(workers[1]!.calls).not.toContain("stop");
  });

  test("discovers accounts, staggers starts, and shares a two-cycle gate", async () => {
    const clock = new FakeClock();
    const workers: FakeWorker[] = [];
    const supervisor = new GoogleSyncSupervisor({
      createWorker: (accountId, gate) => {
        const worker = new FakeWorker(accountId, gate);
        workers.push(worker);
        return worker;
      },
      listAccountIds: async () => ["gacc_a", "gacc_b", "gacc_c"],
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      staggerMs: 100,
    });

    await supervisor.start();

    expect(workers.map((worker) => worker.accountId)).toEqual([
      "gacc_a",
      "gacc_b",
      "gacc_c",
    ]);
    expect(workers.map((worker) => worker.calls)).toEqual([["start"], [], []]);
    clock.runAll();
    expect(workers.map((worker) => worker.calls)).toEqual([
      ["start"],
      ["start"],
      ["start"],
    ]);
    expect(new Set(workers.map((worker) => worker.gate)).size).toBe(1);

    let active = 0;
    let maximum = 0;
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    const attempts = workers.map((worker) =>
      worker.gate.run(async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        await blocker;
        active -= 1;
      }),
    );
    await Promise.resolve();
    expect(active).toBe(2);
    expect(maximum).toBe(2);
    release();
    await Promise.all(attempts);
  });

  test("targets disconnect drain to one account and fans one online monitor out to all accounts", async () => {
    const workers: FakeWorker[] = [];
    let poll!: () => void;
    let online = false;
    let intervalCount = 0;
    const supervisor = new GoogleSyncSupervisor({
      createWorker: (accountId, gate) => {
        const worker = new FakeWorker(accountId, gate);
        workers.push(worker);
        return worker;
      },
      listAccountIds: async () => ["gacc_a", "gacc_b"],
      staggerMs: 0,
    });
    await supervisor.start();
    supervisor.monitorOnline({
      isOnline: () => online,
      setInterval: ((listener: () => void) => {
        intervalCount += 1;
        poll = listener;
        return 1;
      }) as any,
      clearInterval: (() => {}) as any,
    });
    supervisor.monitorOnline({
      isOnline: () => online,
      setInterval: (() => {
        intervalCount += 1;
        return 2;
      }) as any,
      clearInterval: (() => {}) as any,
    });

    await supervisor.drain("gacc_a");
    online = true;
    poll();

    expect(intervalCount).toBe(1);
    expect(workers[0]!.calls).toContain("drain");
    expect(workers[1]!.calls).not.toContain("drain");
    expect(workers[0]!.calls).toContain("wake:online");
    expect(workers[1]!.calls).toContain("wake:online");
  });

  test("target drain cancels that account's pending staggered start", async () => {
    const clock = new FakeClock();
    const workers: FakeWorker[] = [];
    const supervisor = new GoogleSyncSupervisor({
      createWorker: (accountId, gate) => {
        const worker = new FakeWorker(accountId, gate);
        workers.push(worker);
        return worker;
      },
      listAccountIds: async () => ["gacc_a", "gacc_b"],
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      staggerMs: 100,
    });
    await supervisor.start();

    await supervisor.drain("gacc_b");
    clock.runAll();

    expect(workers[1]!.calls).toEqual(["drain"]);
  });

  test("tracks status per account and removes only accounts no longer discovered", async () => {
    let accountIds = ["gacc_a", "gacc_b"];
    const workers = new Map<string, FakeWorker>();
    const supervisor = new GoogleSyncSupervisor({
      createWorker: (accountId, gate) => {
        const worker = new FakeWorker(accountId, gate);
        workers.set(accountId, worker);
        return worker;
      },
      listAccountIds: async () => accountIds,
      staggerMs: 0,
    });
    await supervisor.start();
    workers.get("gacc_b")!.emit({ kind: "authentication-required" });
    expect(supervisor.statuses()).toEqual({
      gacc_a: { kind: "idle" },
      gacc_b: { kind: "authentication-required" },
    });

    accountIds = ["gacc_b", "gacc_c"];
    await supervisor.refreshAccounts();

    expect(workers.get("gacc_a")!.calls).toContain("stop");
    expect(supervisor.statuses()).toEqual({
      gacc_b: { kind: "authentication-required" },
      gacc_c: { kind: "idle" },
    });
  });
});
