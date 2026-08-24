import {
  monitorOnlineRestoration,
  type GoogleSyncStatus,
  type SyncWakeTrigger,
} from "./sync-worker";

export interface SyncCycleGate {
  run<T>(task: () => Promise<T>): Promise<T>;
}

type SyncWorker = Readonly<{
  status: GoogleSyncStatus;
  start(): void;
  wake(trigger: SyncWakeTrigger): void;
  drain(): Promise<void>;
  stop(): Promise<void>;
  onStatus(listener: (status: GoogleSyncStatus) => void): () => void;
}>;

type GoogleSyncSupervisorOptions = Readonly<{
  listAccountIds(): Promise<readonly string[]>;
  createWorker(accountId: string, gate: SyncCycleGate): SyncWorker;
  maxConcurrentCycles?: number;
  staggerMs?: number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}>;

type OnlineMonitorOptions = Readonly<{
  isOnline(): boolean;
  intervalMs?: number;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
}>;

class BoundedSyncCycleGate implements SyncCycleGate {
  readonly #limit: number;
  #active = 0;
  readonly #queue: Array<() => void> = [];

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 8) {
      throw new Error("GOOGLE_SYNC_CYCLE_LIMIT_INVALID");
    }
    this.#limit = limit;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.#acquire();
    try {
      return await task();
    } finally {
      this.#release();
    }
  }

  async #acquire(): Promise<void> {
    if (this.#active < this.#limit) {
      this.#active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.#queue.push(resolve));
  }

  #release(): void {
    const next = this.#queue.shift();
    if (next) {
      next();
      return;
    }
    this.#active -= 1;
  }
}

type WorkerEntry = {
  worker: SyncWorker;
  status: GoogleSyncStatus;
  stopStatus: () => void;
  startTimer: ReturnType<typeof setTimeout> | null;
};

export class GoogleSyncSupervisor {
  readonly #clearTimer: typeof clearTimeout;
  readonly #createWorker: GoogleSyncSupervisorOptions["createWorker"];
  readonly #gate: SyncCycleGate;
  readonly #listAccountIds: GoogleSyncSupervisorOptions["listAccountIds"];
  readonly #setTimer: typeof setTimeout;
  readonly #staggerMs: number;
  readonly #statusListeners = new Set<() => void>();
  readonly #workers = new Map<string, WorkerEntry>();
  #onlineMonitorStop: (() => void) | null = null;
  #started = false;
  #stopped = false;
  #refreshGeneration = 0;

  constructor(options: GoogleSyncSupervisorOptions) {
    const staggerMs = options.staggerMs ?? 250;
    if (!Number.isInteger(staggerMs) || staggerMs < 0 || staggerMs > 30_000) {
      throw new Error("GOOGLE_SYNC_STAGGER_INVALID");
    }
    this.#clearTimer = options.clearTimer ?? clearTimeout;
    this.#createWorker = options.createWorker;
    this.#gate = new BoundedSyncCycleGate(options.maxConcurrentCycles ?? 2);
    this.#listAccountIds = options.listAccountIds;
    this.#setTimer = options.setTimer ?? setTimeout;
    this.#staggerMs = staggerMs;
  }

  async start(): Promise<void> {
    if (this.#started || this.#stopped) return;
    this.#started = true;
    await this.refreshAccounts();
  }

  async refreshAccounts(): Promise<void> {
    if (this.#stopped) return;
    const generation = ++this.#refreshGeneration;
    const discovered = await this.#listAccountIds();
    if (this.#stopped || generation !== this.#refreshGeneration) return;
    if (discovered.length > 8) throw new Error("GOOGLE_ACCOUNT_LIMIT_REACHED");
    const accountIds = [...new Set(discovered)];
    if (
      accountIds.length !== discovered.length ||
      accountIds.some((accountId) => !accountId || accountId.length > 128)
    ) {
      throw new Error("GOOGLE_ACCOUNT_LIST_INVALID");
    }
    const wanted = new Set(accountIds);
    for (const [accountId, entry] of [...this.#workers]) {
      if (wanted.has(accountId)) continue;
      this.#cancelStart(entry);
      entry.stopStatus();
      if (this.#workers.get(accountId) !== entry) continue;
      this.#workers.delete(accountId);
      this.#emitStatus();
      await entry.worker.drain();
      await entry.worker.stop();
      if (this.#stopped || generation !== this.#refreshGeneration) return;
    }

    const added: WorkerEntry[] = [];
    for (const accountId of accountIds) {
      if (this.#workers.has(accountId)) continue;
      const worker = this.#createWorker(accountId, this.#gate);
      const entry: WorkerEntry = {
        worker,
        status: worker.status,
        stopStatus: () => {},
        startTimer: null,
      };
      entry.stopStatus = worker.onStatus((status) => {
        entry.status = status;
        this.#emitStatus();
      });
      this.#workers.set(accountId, entry);
      this.#emitStatus();
      added.push(entry);
    }
    if (!this.#started) return;
    added.forEach((entry, index) => {
      const delay = index * this.#staggerMs;
      if (delay === 0) {
        entry.worker.start();
        return;
      }
      entry.startTimer = this.#setTimer(() => {
        entry.startTimer = null;
        if (!this.#stopped) entry.worker.start();
      }, delay);
    });
  }

  wake(trigger: SyncWakeTrigger, accountId?: string): void {
    if (this.#stopped) return;
    if (accountId !== undefined) {
      this.#workers.get(accountId)?.worker.wake(trigger);
      return;
    }
    for (const entry of this.#workers.values()) entry.worker.wake(trigger);
  }

  async drain(accountId?: string): Promise<void> {
    if (accountId !== undefined) {
      const entry = this.#workers.get(accountId);
      if (!entry) return;
      this.#cancelStart(entry);
      await entry.worker.drain();
      return;
    }
    await Promise.all(
      [...this.#workers.values()].map((entry) => entry.worker.drain()),
    );
  }

  statuses(): Readonly<Record<string, GoogleSyncStatus>> {
    return Object.freeze(
      Object.fromEntries(
        [...this.#workers].map(([accountId, entry]) => [
          accountId,
          entry.status,
        ]),
      ),
    );
  }

  onStatus(listener: () => void): () => void {
    this.#statusListeners.add(listener);
    return () => this.#statusListeners.delete(listener);
  }

  monitorOnline(options: OnlineMonitorOptions): void {
    if (this.#onlineMonitorStop !== null || this.#stopped) return;
    this.#onlineMonitorStop = monitorOnlineRestoration({
      ...options,
      wake: (trigger) => this.wake(trigger),
    });
  }

  async stop(accountId?: string): Promise<void> {
    if (accountId !== undefined) {
      const entry = this.#workers.get(accountId);
      if (!entry) return;
      this.#cancelStart(entry);
      entry.stopStatus();
      await entry.worker.drain();
      await entry.worker.stop();
      this.#workers.delete(accountId);
      this.#emitStatus();
      return;
    }
    if (this.#stopped) return;
    this.#stopped = true;
    this.#refreshGeneration += 1;
    this.#onlineMonitorStop?.();
    this.#onlineMonitorStop = null;
    for (const entry of this.#workers.values()) {
      this.#cancelStart(entry);
      entry.stopStatus();
    }
    await Promise.all(
      [...this.#workers.values()].map(async (entry) => {
        await entry.worker.drain();
        await entry.worker.stop();
      }),
    );
    this.#workers.clear();
    this.#emitStatus();
  }

  #cancelStart(entry: WorkerEntry): void {
    if (entry.startTimer === null) return;
    this.#clearTimer(entry.startTimer);
    entry.startTimer = null;
  }

  #emitStatus(): void {
    for (const listener of this.#statusListeners) listener();
  }
}
