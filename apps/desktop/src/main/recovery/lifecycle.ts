export type RecoveryOperation = "restore" | "reset";

export class RecoveryLifecycle {
  #active: RecoveryOperation | null = null;
  #activeRun: Promise<void> | null = null;
  #closing = false;
  #drainPromise: Promise<void> | null = null;
  #drained = false;
  #completed = false;

  constructor(private readonly drainOwnedResources: () => Promise<void>) {}

  drain(): Promise<void> {
    if (this.#drained) return Promise.resolve();
    if (this.#drainPromise) return this.#drainPromise;
    const draining = this.drainOwnedResources()
      .then(() => { this.#drained = true; })
      .catch((error) => {
        if (this.#drainPromise === draining) this.#drainPromise = null;
        throw error;
      });
    this.#drainPromise = draining;
    return draining;
  }

  run(operation: RecoveryOperation, mutation: () => Promise<void>): Promise<void> {
    if (this.#closing) return Promise.reject(new Error("RECOVERY_UNAVAILABLE"));
    if (this.#active) return Promise.reject(new Error("RECOVERY_IN_PROGRESS"));
    if (this.#completed) return Promise.reject(new Error("RECOVERY_RESTART_REQUIRED"));
    this.#active = operation;
    const run = (async () => {
      await this.drain();
      await mutation();
      this.#completed = true;
    })().finally(() => {
      if (this.#activeRun === run) this.#activeRun = null;
      this.#active = null;
    });
    this.#activeRun = run;
    return run;
  }

  async shutdown(): Promise<void> {
    this.#closing = true;
    const activeRun = this.#activeRun;
    if (activeRun) await activeRun.catch(() => undefined);
    await this.drain();
  }
}

export function createGoogleIpcDrainStep(options: Readonly<{
  dispose(): Promise<void>;
  afterDispose(): void;
}>): () => Promise<void> {
  return async () => {
    await options.dispose();
    options.afterDispose();
  };
}

export function createOwnedResourceDrain(resources: Readonly<{
  revokeIpcProducers(): void | Promise<void>;
  stopProviderMigration(): Promise<void>;
  stopOnlineMonitor(): void | Promise<void>;
  disposeGoogleIpc(): void | Promise<void>;
  disposeAssistant(): void | Promise<void>;
  stopGoogleWorker(): Promise<void>;
  closeCalendarBroker(): Promise<void>;
  drainConvex(): Promise<void>;
  stopConvex(): Promise<void>;
  closeAuthIssuer(): Promise<void>;
}>): () => Promise<void> {
  return async () => {
    let firstError: unknown;
    const attempt = async (operation: () => void | Promise<void>) => {
      try {
        await operation();
      } catch (error) {
        firstError ??= error;
      }
    };
    await attempt(resources.revokeIpcProducers);
    await attempt(resources.stopProviderMigration);
    await attempt(resources.stopOnlineMonitor);
    await attempt(resources.disposeGoogleIpc);
    await attempt(resources.disposeAssistant);
    await attempt(resources.stopGoogleWorker);
    await attempt(resources.closeCalendarBroker);
    await attempt(resources.drainConvex);
    await attempt(resources.stopConvex);
    await attempt(resources.closeAuthIssuer);
    if (firstError) throw firstError;
  };
}
