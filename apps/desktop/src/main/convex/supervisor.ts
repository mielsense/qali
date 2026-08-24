import { EventEmitter } from "node:events";

import type { OwnedBackendProcess } from "./process-driver";

export const SUPERVISOR_STATES = [
  "stopped",
  "resolving",
  "backing-up",
  "spawning",
  "awaiting-readiness",
  "authenticating",
  "deploying/migrating",
  "healthy",
  "degraded",
  "draining",
  "blocked",
] as const;

export type SupervisorState = (typeof SUPERVISOR_STATES)[number];

export type ResolvedConvexRuntime = Readonly<{
  backendExecutable: string;
  databaseDirectory: string;
  deploymentUrl: string;
  siteUrl: string;
  instanceName: string;
  instanceSecret: string;
  expectedVersion: string;
  buildMarker: string;
  adminCredential?: string;
}>;

export type HealthyConvex = Readonly<{
  deploymentUrl: string;
  siteUrl: string;
}>;

export type VersionProof = Readonly<{
  status: number;
  version: string;
}>;

export interface ConvexSupervisorDriver {
  resolve(): Promise<ResolvedConvexRuntime>;
  createUpgradeBackup(runtime: ResolvedConvexRuntime): Promise<void>;
  spawn(runtime: ResolvedConvexRuntime): Promise<OwnedBackendProcess>;
  probeVersion(runtime: ResolvedConvexRuntime): Promise<VersionProof>;
  deploy(runtime: ResolvedConvexRuntime): Promise<void>;
  contract(runtime: ResolvedConvexRuntime): Promise<void>;
  authenticateIdentity(runtime: ResolvedConvexRuntime): Promise<boolean>;
  commitBuildMarker(runtime: ResolvedConvexRuntime): Promise<void>;
}

export type SupervisorErrorCode =
  | "BACKEND_START_FAILED"
  | "BACKEND_VERSION_MISMATCH"
  | "BACKEND_IDENTITY_MISMATCH"
  | "BACKEND_RESTART_BUDGET_EXHAUSTED";

export class ConvexSupervisorError extends Error {
  readonly startupStage?: SupervisorState;

  constructor(
    readonly code: SupervisorErrorCode,
    message: string,
    options: { cause?: unknown; startupStage?: SupervisorState } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ConvexSupervisorError";
    this.startupStage = options.startupStage;
  }
}

function asSupervisorError(
  error: unknown,
  startupStage?: SupervisorState,
): ConvexSupervisorError {
  if (error instanceof ConvexSupervisorError && error.startupStage) return error;
  if (error instanceof ConvexSupervisorError) {
    return new ConvexSupervisorError(error.code, error.message, {
      cause: error.cause,
      startupStage,
    });
  }
  return new ConvexSupervisorError(
    "BACKEND_START_FAILED",
    "Local calendar service failed to start",
    { cause: error, startupStage },
  );
}

export class ConvexSupervisor {
  readonly #events = new EventEmitter();
  readonly #maxRestarts: number;
  #current: OwnedBackendProcess | null = null;
  #generation = 0;
  #healthy: HealthyConvex | null = null;
  #restartPromise: Promise<void> | null = null;
  #startPromise: Promise<HealthyConvex> | null = null;
  #migrationPromise: Promise<void> | null = null;
  #migrationRuntime: ResolvedConvexRuntime | null = null;
  #stopping = false;
  #restartCount = 0;
  #state: SupervisorState = "stopped";

  constructor(
    readonly driver: ConvexSupervisorDriver,
    options: { maxRestarts?: number } = {},
  ) {
    const maxRestarts = options.maxRestarts ?? 2;
    if (!Number.isInteger(maxRestarts) || maxRestarts < 0 || maxRestarts > 5) {
      throw new Error("Invalid Convex restart budget");
    }
    this.#maxRestarts = maxRestarts;
  }

  get state(): SupervisorState {
    return this.#state;
  }

  onState(listener: (state: SupervisorState) => void): () => void {
    this.#events.on("state", listener);
    return () => this.#events.off("state", listener);
  }

  #transition(state: SupervisorState): void {
    this.#state = state;
    this.#events.emit("state", state);
  }

  #isActive(generation: number): boolean {
    return !this.#stopping && generation === this.#generation;
  }

  #assertActive(generation: number): void {
    if (!this.#isActive(generation)) {
      throw new ConvexSupervisorError(
        "BACKEND_START_FAILED",
        "Local calendar service startup was cancelled",
      );
    }
  }

  #assertCapturedProcess(
    process: OwnedBackendProcess,
    generation: number,
    message: string,
  ): void {
    this.#assertActive(generation);
    if (this.#current !== process) {
      throw new ConvexSupervisorError("BACKEND_START_FAILED", message);
    }
  }

  start(): Promise<HealthyConvex> {
    if (this.#state === "healthy" && this.#healthy) {
      return Promise.resolve(this.#healthy);
    }
    if (this.#startPromise) return this.#startPromise;
    this.#stopping = false;
    const generation = ++this.#generation;
    const trackedStart = this.#startLifecycle(generation).finally(() => {
      if (this.#startPromise === trackedStart) this.#startPromise = null;
    });
    this.#startPromise = trackedStart;
    return trackedStart;
  }

  async #startLifecycle(generation: number): Promise<HealthyConvex> {
    try {
      this.#assertActive(generation);
      this.#transition("resolving");
      const runtime = await this.driver.resolve();
      this.#assertActive(generation);
      this.#transition("backing-up");
      await this.driver.createUpgradeBackup(runtime);
      this.#assertActive(generation);
      const healthy = await this.#launch(runtime, generation);
      this.#assertActive(generation);
      this.#restartCount = 0;
      this.#healthy = healthy;
      this.#migrationRuntime = runtime;
      return healthy;
    } catch (error) {
      const startupStage = this.#state;
      await this.#stopCurrent();
      if (this.#isActive(generation)) this.#transition("blocked");
      throw asSupervisorError(error, startupStage);
    }
  }

  async #launch(
    runtime: ResolvedConvexRuntime,
    generation: number,
  ): Promise<HealthyConvex> {
    this.#assertActive(generation);
    this.#transition("spawning");
    const process = await this.driver.spawn(runtime);
    this.#current = process;
    process.once("exit", () => {
      if (this.#current !== process) return;
      this.#current = null;
      if (!this.#isActive(generation)) return;
      if (this.#state === "healthy") this.#beginRestart();
    });
    this.#assertCapturedProcess(
      process,
      generation,
      "The captured local calendar service stopped while spawning",
    );

    this.#transition("awaiting-readiness");
    const proof = await this.driver.probeVersion(runtime);
    this.#assertCapturedProcess(
      process,
      generation,
      "The captured local calendar service stopped before readiness",
    );
    if (proof.status !== 200 || proof.version !== runtime.expectedVersion) {
      throw new ConvexSupervisorError(
        "BACKEND_VERSION_MISMATCH",
        "Bundled local calendar service identity does not match the release manifest",
      );
    }

    this.#transition("deploying/migrating");
    await this.driver.deploy(runtime);
    this.#assertCapturedProcess(
      process,
      generation,
      "The captured local calendar service stopped during deployment",
    );
    this.#transition("authenticating");
    const authenticated = await this.driver.authenticateIdentity(runtime);
    this.#assertCapturedProcess(
      process,
      generation,
      "The captured local calendar service stopped during authentication",
    );
    if (!authenticated) {
      throw new ConvexSupervisorError(
        "BACKEND_IDENTITY_MISMATCH",
        "Local calendar service authentication proof failed",
      );
    }
    this.#transition("healthy");
    return { deploymentUrl: runtime.deploymentUrl, siteUrl: runtime.siteUrl };
  }

  completeMigration(): Promise<void> {
    if (this.#migrationPromise) return this.#migrationPromise;
    const runtime = this.#migrationRuntime;
    const process = this.#current;
    const generation = this.#generation;
    if (!runtime || !process || this.#state !== "healthy") {
      return Promise.reject(new ConvexSupervisorError(
        "BACKEND_START_FAILED",
        "Local calendar service is not ready for schema contraction",
      ));
    }
    const completion = (async () => {
      this.#transition("deploying/migrating");
      try {
        await this.driver.contract(runtime);
        this.#assertCapturedProcess(
          process,
          generation,
          "The captured local calendar service stopped during schema contraction",
        );
        await this.driver.commitBuildMarker(runtime);
        this.#assertCapturedProcess(
          process,
          generation,
          "The captured local calendar service stopped before the migration marker completed",
        );
        this.#transition("healthy");
      } catch (error) {
        if (this.#isActive(generation) && this.#current === process) {
          this.#transition("healthy");
        }
        throw error;
      }
    })().finally(() => {
      if (this.#migrationPromise === completion) this.#migrationPromise = null;
    });
    this.#migrationPromise = completion;
    return completion;
  }

  #beginRestart(): void {
    if (this.#restartPromise || this.#stopping) return;
    const generation = ++this.#generation;
    const trackedRestart = this.#restartAfterUnexpectedExit(generation).finally(() => {
      if (this.#restartPromise === trackedRestart) this.#restartPromise = null;
    });
    this.#restartPromise = trackedRestart;
    void trackedRestart.catch((error) => {
      if (this.#isActive(generation)) {
        this.#events.emit("supervisor-error", asSupervisorError(error, this.#state));
      }
    });
  }

  async #restartAfterUnexpectedExit(generation: number): Promise<void> {
    this.#transition("degraded");
    while (this.#isActive(generation)) {
      if (this.#restartCount >= this.#maxRestarts) {
        this.#transition("blocked");
        this.#events.emit(
          "supervisor-error",
          new ConvexSupervisorError(
            "BACKEND_RESTART_BUDGET_EXHAUSTED",
            "Local calendar service repeatedly stopped unexpectedly",
          ),
        );
        return;
      }
      this.#restartCount += 1;
      try {
        const runtime = await this.driver.resolve();
        this.#assertActive(generation);
        const healthy = await this.#launch(runtime, generation);
        this.#assertActive(generation);
        this.#healthy = healthy;
        return;
      } catch {
        await this.#stopCurrent();
        if (!this.#isActive(generation)) return;
      }
    }
  }

  async drain(): Promise<void> {
    if (this.#state === "stopped") return;
    this.#stopping = true;
    this.#transition("draining");
  }

  async #stopCurrent(): Promise<void> {
    const process = this.#current;
    this.#current = null;
    if (process) await process.stop();
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    this.#generation += 1;
    const pending: Promise<unknown>[] = [];
    if (this.#startPromise) pending.push(this.#startPromise);
    if (this.#restartPromise) pending.push(this.#restartPromise);
    if (this.#migrationPromise) pending.push(this.#migrationPromise);
    await this.#stopCurrent();
    await Promise.allSettled(pending);
    await this.#stopCurrent();
    this.#healthy = null;
    this.#migrationRuntime = null;
    this.#transition("stopped");
  }
}
