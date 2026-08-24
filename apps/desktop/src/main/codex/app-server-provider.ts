import { mkdir, readFile } from "node:fs/promises";

import { type AssistantProviderStatus } from "@qali/desktop-contracts";
import type {
  AssistantAttemptId,
  AssistantCoordinatorAttemptId,
  AssistantLoginAttemptId,
} from "@qali/desktop-contracts";

import type { CodexPhaseRunner } from "./coordinator";
import {
  createCodexAppServerContainmentAuthority,
  type CodexRuntimeAuthority,
} from "./boundary";
import {
  CODEX_APP_SERVER_ARGS,
  createCodexAppServerContainment,
  type CodexAppServerContainment,
} from "./app-server-containment";
import {
  resolveCodexInstallation,
  type CodexCompatibilityDependencies,
  type CodexInstallationEvidence,
  type CodexInstallationResolution,
} from "./app-server-compatibility";
import {
  createCodexAppServerClientV2,
  type CodexAppServerClientV2,
  type TurnStartResult,
} from "./app-server-client-v2";
import {
  createCodexAppServerTransportGeneration,
  type CodexAppServerTransportGeneration,
  type NativeMessage,
} from "./app-server-transport";
import type { CodexAppServerChild } from "./app-server-driver";
import { publishCodexLoginEvent, type CodexLoginEventChannel } from "./events";
import { loadCodexManifest } from "./manifest";
import type { CodexProviderManifest } from "./manifest";
import {
  cancelCodexAppServerAttempt,
  runCodexAppServerPhase,
} from "./app-server-driver";
import { createCodexCalendarAssistantAdapter } from "./calendar-assistant-adapter";
import { parseFinalizerJson, parsePlannerJson } from "./schemas";

export const QALI_CODEX_MODEL = "gpt-5.6-luna";
export const QALI_CODEX_REASONING_EFFORT = "high" as const;

export type InstalledCodexAppServer = Readonly<{
  executable: string;
  installationEvidence: CodexInstallationEvidence;
  home: string;
  cwd: string;
  tmpdir: string;
  plannerSchema: unknown;
  finalizerSchema: unknown;
}>;

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

/**
 * Verify the exact locally installed Codex binary. Authentication and account
 * readiness are intentionally established later through the App Server
 * protocol; installation discovery never reads credentials or runs login.
 */
export async function resolveInstalledCodexAppServer(
  input: Readonly<{
    resourceRoot: string;
    home: string;
    runtimeRoot: string;
    selectedPath?: string;
  }>,
): Promise<InstalledCodexAppServer | null> {
  try {
    const manifest = await loadCodexManifest(
      `${input.resourceRoot}/codex-provider-manifest.json`,
    );
    const installation = await resolveCodexInstallation({
      manifest,
      selectedPath: input.selectedPath,
    });
    if (installation.kind !== "supported") return null;

    const cwd = `${input.runtimeRoot}/codex-assistant-work`;
    const tmpdir = `${input.runtimeRoot}/codex-assistant-tmp`;
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    await mkdir(tmpdir, { recursive: true, mode: 0o700 });
    return Object.freeze({
      executable: installation.evidence.executablePath,
      installationEvidence: installation.evidence,
      home: input.home,
      cwd,
      tmpdir,
      plannerSchema: await readJson(
        `${input.resourceRoot}/codex-planner-output.schema.json`,
      ),
      finalizerSchema: await readJson(
        `${input.resourceRoot}/codex-finalizer-output.schema.json`,
      ),
    });
  } catch {
    return null;
  }
}

export function createCodexAppServerPhaseRunner(
  provider: InstalledCodexAppServer,
): CodexPhaseRunner {
  return {
    async run(request) {
      const outputSchema =
        request.phase === "planner"
          ? provider.plannerSchema
          : provider.finalizerSchema;
      const result = await runCodexAppServerPhase({
        attemptId: request.attemptId,
        executable: provider.executable,
        home: provider.home,
        cwd: provider.cwd,
        tmpdir: provider.tmpdir,
        prompt: request.prompt,
        outputSchema,
        timeoutMs: 60_000,
      });
      if (request.phase === "planner") parsePlannerJson(result.finalText);
      else parseFinalizerJson(result.finalText);
      return result;
    },
    async cancel(attemptId) {
      cancelCodexAppServerAttempt(attemptId);
    },
  };
}

export function createReadyCodexAssistantRuntime(): Readonly<{
  status(): Promise<AssistantProviderStatus>;
  login(attemptId: string, signal: AbortSignal): Promise<void>;
  cancel(attemptId: string): boolean;
}> {
  const runtime: {
    status(): Promise<AssistantProviderStatus>;
    login(attemptId: string, signal: AbortSignal): Promise<void>;
    cancel(attemptId: string): boolean;
  } = {
    status: async () => ({ kind: "ready" as const }),
    async login(_attemptId: string, signal: AbortSignal) {
      if (signal.aborted) {
        throw Object.assign(new Error("cancelled"), {
          code: "CODEX_CANCELLED",
        });
      }
    },
    cancel: cancelCodexAppServerAttempt,
  };
  return Object.freeze(runtime);
}

export type StructuredTurnInput = Readonly<{
  text: string;
  outputSchema: unknown;
}>;

export type StructuredTurnResult = Readonly<{
  finalText: string;
  threadId: string;
  turnId: string;
}>;

export type CancellationMilestone =
  | "requested"
  | "interrupt-sent"
  | "interrupt-acknowledged"
  | "semantically-interrupted"
  | "completed-before-interrupt"
  | "owned-process-terminated"
  | "outcome-unknown";

export type CancellationMilestoneReporter = (
  milestone: CancellationMilestone,
) => Promise<void>;

export type InterruptOutcome = Readonly<{
  terminal:
    | "semantically-interrupted"
    | "completed-before-interrupt"
    | "outcome-unknown";
  milestones: readonly CancellationMilestone[];
}>;

export const CODEX_DEADLINES = Object.freeze({
  spawnMs: 5_000,
  initializeMs: 5_000,
  accountMs: 5_000,
  threadMs: 5_000,
  turnAckMs: 10_000,
  modelAbsoluteMs: 120_000,
  interruptAckMs: 5_000,
  interruptGraceMs: 5_000,
  shutdownMs: 10_000,
} as const);

export interface DeadlineScheduler {
  now(): number;
  set(delayMs: number, callback: () => void): unknown;
  clear(handle: unknown): void;
}

const systemDeadlineScheduler: DeadlineScheduler = {
  now: Date.now,
  set: (delayMs, callback) => setTimeout(callback, delayMs),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface CodexAttemptLease {
  startThread(): Promise<string>;
  runTurn(input: StructuredTurnInput): Promise<StructuredTurnResult>;
  interrupt(report?: CancellationMilestoneReporter): Promise<InterruptOutcome>;
  release(): Promise<void>;
}

export interface CodexAppServerHost {
  status(): Promise<AssistantProviderStatus>;
  acquireAttempt(
    attemptId: AssistantCoordinatorAttemptId,
  ): Promise<CodexAttemptLease>;
  login(attemptId: AssistantLoginAttemptId, signal: AbortSignal): Promise<void>;
  cancel(attemptId: AssistantAttemptId): Promise<boolean>;
  close(): Promise<void>;
}

type ContainedClientDependencies = Readonly<{
  createAuthority: typeof createCodexAppServerContainmentAuthority;
  createContainment: typeof createCodexAppServerContainment;
  createTransport(
    child: CodexAppServerChild,
  ): CodexAppServerTransportGeneration;
  createClient(
    transport: CodexAppServerTransportGeneration,
  ): CodexAppServerClientV2;
}>;

const CONTAINED_TRANSPORT_LIMITS = Object.freeze({
  maxFrameBytes: 256 * 1024,
  maxReceiveBufferBytes: 256 * 1024,
  maxPendingRequests: 8,
  maxQueuedWriteBytes: 512 * 1024,
  maxStderrBytes: 32 * 1024,
});

/** Creates one opaque-containment-owned transport/client generation. */
export async function createContainedCodexAppServerClient(
  runtimeAuthority: CodexRuntimeAuthority,
  evidence: CodexInstallationEvidence,
  overrides: Partial<ContainedClientDependencies> = {},
): Promise<CodexAppServerClientV2> {
  const dependencies: ContainedClientDependencies = {
    createAuthority: createCodexAppServerContainmentAuthority,
    createContainment: createCodexAppServerContainment,
    createTransport: (child) =>
      createCodexAppServerTransportGeneration(
        child,
        CONTAINED_TRANSPORT_LIMITS,
      ),
    createClient: (transport) => createCodexAppServerClientV2(transport),
    ...overrides,
  };
  const authority = dependencies.createAuthority(runtimeAuthority, evidence);
  const containment: CodexAppServerContainment =
    await dependencies.createContainment(authority);
  const child = containment.spawn(CODEX_APP_SERVER_ARGS);
  const client = dependencies.createClient(dependencies.createTransport(child));
  let closePromise: Promise<void> | null = null;
  const ownedClient: CodexAppServerClientV2 = {
    initialize: () => client.initialize(),
    accountRead: () => client.accountRead(),
    accountLoginStart: () => client.accountLoginStart(),
    threadStart: (input) => client.threadStart(input),
    turnStart: (input) => client.turnStart(input),
    turnInterrupt: (input) => client.turnInterrupt(input),
    subscribe: (listener) => client.subscribe(listener),
    subscribeTermination: (listener) =>
      client.subscribeTermination?.(listener) ?? (() => {}),
    close() {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        let failure: unknown;
        try {
          await client.close();
        } catch (error) {
          failure = error;
        }
        try {
          await containment.release(child);
        } catch (error) {
          failure ??= error;
        }
        try {
          await containment.close();
        } catch (error) {
          failure ??= error;
        }
        if (failure) throw failure;
      })();
      return closePromise;
    },
  };
  return Object.freeze(ownedClient);
}

/** Binds the coordinator's two sequential phases to one native host lease. */
export function createCodexAppServerHostPhaseRunner(
  host: Pick<CodexAppServerHost, "acquireAttempt">,
  outputSchemas: Readonly<{ planner: unknown; finalizer: unknown }>,
): CodexPhaseRunner {
  return createCodexCalendarAssistantAdapter(host, outputSchemas);
}

export type CodexAppServerHostDependencies = Readonly<{
  resolveInstallation(): Promise<CodexInstallationResolution>;
  createClient(
    evidence: CodexInstallationEvidence,
  ): Promise<CodexAppServerClientV2>;
  /**
   * Proves model, quota, and entitlement readiness independently from
   * account/read. It must not perform inference in ordinary deterministic
   * tests; production supplies evidence from its supported capability lane.
   */
  probeReadiness(
    client: CodexAppServerClientV2,
    evidence: CodexInstallationEvidence,
  ): Promise<Readonly<{ kind: "ready" | "ready-degraded" }>>;
  waitForLoginCompletion(
    client: CodexAppServerClientV2,
    input: Readonly<{ loginId: string; signal: AbortSignal }>,
  ): Promise<void>;
  loginEvents: CodexLoginEventChannel;
  workRoot: string;
  shutdownTimeoutMs?: number;
  deadlineScheduler?: DeadlineScheduler;
}>;

export type CodexInstallationSelectionResult =
  | Readonly<{
      kind: "supported";
      status: Exclude<AssistantProviderStatus, { kind: "offline" }>;
    }>
  | Readonly<{ kind: "missing" }>
  | Readonly<{
      kind: "incompatible";
      status: Exclude<AssistantProviderStatus, { kind: "offline" }>;
    }>;

export type CodexInstallationSelection = Readonly<{
  validate(path: string): Promise<CodexInstallationSelectionResult>;
  selectedEvidence(): CodexInstallationEvidence | null;
}>;

/**
 * Manual selection is deliberately an in-memory process session. Every path
 * is passed through Task 1 compatibility before its evidence becomes active.
 */
export function createCodexInstallationSelection(
  input: Readonly<{
    manifest: CodexProviderManifest;
    compatibilityDependencies?: CodexCompatibilityDependencies;
    onSelected(
      evidence: CodexInstallationEvidence,
    ): Promise<Exclude<AssistantProviderStatus, { kind: "offline" }>>;
  }>,
): CodexInstallationSelection {
  let selected: CodexInstallationEvidence | null = null;
  return Object.freeze({
    selectedEvidence: () => selected,
    async validate(path) {
      const resolution = await resolveCodexInstallation({
        manifest: input.manifest,
        selectedPath: path,
        dependencies: input.compatibilityDependencies,
      });
      if (resolution.kind === "missing") return { kind: "missing" };
      if (resolution.kind !== "supported") {
        return {
          kind: "incompatible",
          status: installationStatus(resolution),
        };
      }
      const status = await input.onSelected(resolution.evidence);
      selected = resolution.evidence;
      return { kind: "supported", status };
    },
  });
}

type CodedError = Error & { code: string };

function providerError(code: string, message: string): CodedError {
  return Object.assign(new Error(message), { code });
}

function nativeCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : "";
}

function mapProviderFailure(error: unknown): CodedError {
  const code = nativeCode(error);
  if (/QUOTA|RATE.?LIMIT/i.test(code)) {
    return providerError("CODEX_QUOTA_EXCEEDED", "Codex quota is unavailable");
  }
  if (/MODEL/i.test(code)) {
    return providerError(
      "CODEX_MODEL_UNAVAILABLE",
      "The selected Codex model is unavailable",
    );
  }
  if (/ENTITLEMENT|SUBSCRIPTION/i.test(code)) {
    return providerError(
      "CODEX_ENTITLEMENT_REQUIRED",
      "Codex entitlement is required",
    );
  }
  if (/AUTH|LOGIN|CREDENTIAL/i.test(code)) {
    return providerError(
      "CODEX_AUTHENTICATION_REQUIRED",
      "Codex authentication is required",
    );
  }
  return error instanceof Error
    ? Object.assign(error, { code: code || "CODEX_PROVIDER_FAILED" })
    : providerError("CODEX_PROVIDER_FAILED", "Codex provider operation failed");
}

function terminalStatusForFailure(
  error: CodedError,
): Exclude<AssistantProviderStatus, { kind: "offline" }> {
  switch (error.code) {
    case "CODEX_AUTHENTICATION_REQUIRED":
      return { kind: "authentication-required" };
    case "CODEX_NEEDS_REPROBE":
      return { kind: "needs-reprobe" };
    case "CODEX_INCOMPATIBLE":
      return { kind: "incompatible" };
    case "CODEX_UNAVAILABLE":
    case "CODEX_HOST_CLOSED":
      return { kind: "unavailable" };
    default:
      return { kind: "probe-failed" };
  }
}

function installationStatus(
  resolution: Exclude<CodexInstallationResolution, { kind: "supported" }>,
): Exclude<AssistantProviderStatus, { kind: "offline" }> {
  switch (resolution.kind) {
    case "missing":
      return { kind: "unavailable" };
    case "needs-reprobe":
      return { kind: "needs-reprobe" };
    case "incompatible":
      return { kind: "incompatible" };
    case "probe-failed":
      return { kind: "probe-failed" };
  }
}

function identityOf(evidence: CodexInstallationEvidence): string {
  return [
    evidence.executablePath,
    evidence.version,
    evidence.sha256,
    evidence.generatedSchemaSha256,
  ].join("\u0000");
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isDefiniteTurnRejection(error: unknown): boolean {
  const code = nativeCode(error);
  return code === "CODEX_NATIVE_ERROR" || code === "CODEX_NATIVE_REJECTED";
}

/**
 * Owns one initialized App Server generation and admits one application
 * attempt at a time. Installation probing is repeated at every admission so a
 * changed binary can never inherit a prior generation's readiness evidence.
 */
export function createCodexAppServerHost(
  dependencies: CodexAppServerHostDependencies,
): CodexAppServerHost {
  let providerStatus: AssistantProviderStatus = { kind: "probing" };
  let firstStatusObservation = true;
  let refreshInFlight: Promise<AssistantProviderStatus> | null = null;
  let client: CodexAppServerClientV2 | null = null;
  let installationIdentity: string | null = null;
  let accepting = true;
  let closePromise: Promise<void> | null = null;
  let activeAttemptId: AssistantAttemptId | null = null;
  let activeLease: (CodexAttemptLease & { drain(): Promise<void> }) | null =
    null;
  let staleGeneration = false;
  const deadlineScheduler =
    dependencies.deadlineScheduler ?? systemDeadlineScheduler;
  const withDeadline = <T>(
    code: string,
    delayMs: number,
    operation: Promise<T>,
  ): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      let settled = false;
      const timer = deadlineScheduler.set(delayMs, () => {
        if (settled) return;
        settled = true;
        reject(providerError(code, "Codex operation timed out"));
      });
      void operation.then(
        (value) => {
          if (settled) return;
          settled = true;
          deadlineScheduler.clear(timer);
          resolve(value);
        },
        (error) => {
          if (settled) return;
          settled = true;
          deadlineScheduler.clear(timer);
          reject(error);
        },
      );
    });
  const loginControllers = new Map<string, AbortController>();
  const loginOperations = new Set<Promise<void>>();

  const ensureAccepting = () => {
    if (!accepting)
      throw providerError("CODEX_HOST_CLOSED", "Codex host is closed");
  };

  const closeClient = async () => {
    const owned = client;
    client = null;
    installationIdentity = null;
    if (!owned) return;
    await withDeadline(
      "CODEX_SHUTDOWN_TIMED_OUT",
      CODEX_DEADLINES.shutdownMs,
      owned.close(),
    );
  };

  const refresh = (): Promise<AssistantProviderStatus> => {
    if (refreshInFlight) return refreshInFlight;
    const operation = (async () => {
      ensureAccepting();
      providerStatus = { kind: "probing" };
      const resolution = await withDeadline(
        "CODEX_RESOLVE_TIMED_OUT",
        CODEX_DEADLINES.spawnMs,
        dependencies.resolveInstallation(),
      );
      ensureAccepting();
      if (resolution.kind !== "supported") {
        if (activeLease && client) {
          staleGeneration = true;
          providerStatus = installationStatus(resolution);
          return providerStatus;
        }
        await closeClient();
        providerStatus = installationStatus(resolution);
        return providerStatus;
      }
      const nextIdentity = identityOf(resolution.evidence);
      if (client && installationIdentity !== nextIdentity) {
        if (activeLease) {
          staleGeneration = true;
          providerStatus = { kind: "needs-reprobe" };
          return providerStatus;
        }
        await closeClient();
      }
      if (!client) {
        const creation = dependencies.createClient(resolution.evidence);
        let nextClient: CodexAppServerClientV2;
        try {
          nextClient = await withDeadline(
            "CODEX_SPAWN_TIMED_OUT",
            CODEX_DEADLINES.spawnMs,
            creation,
          );
        } catch (error) {
          // If a spawn promise resolves after its admission deadline, it is
          // still ours. Close that late generation instead of retaining a
          // poisoned or orphaned client.
          void creation
            .then((lateClient) =>
              withDeadline(
                "CODEX_SHUTDOWN_TIMED_OUT",
                CODEX_DEADLINES.shutdownMs,
                lateClient.close(),
              ),
            )
            .catch(() => {});
          throw error;
        }
        try {
          ensureAccepting();
          await withDeadline(
            "CODEX_INITIALIZE_TIMED_OUT",
            CODEX_DEADLINES.initializeMs,
            nextClient.initialize(),
          );
          ensureAccepting();
        } catch (error) {
          await withDeadline(
            "CODEX_SHUTDOWN_TIMED_OUT",
            CODEX_DEADLINES.shutdownMs,
            nextClient.close(),
          ).catch(() => {});
          throw error;
        }
        client = nextClient;
        installationIdentity = nextIdentity;
      }
      const account = await withDeadline(
        "CODEX_ACCOUNT_TIMED_OUT",
        CODEX_DEADLINES.accountMs,
        client.accountRead(),
      );
      ensureAccepting();
      if (account.account?.type !== "chatgpt") {
        providerStatus = { kind: "authentication-required" };
        return providerStatus;
      }
      try {
        providerStatus = await withDeadline(
          "CODEX_PROBE_TIMED_OUT",
          CODEX_DEADLINES.accountMs,
          dependencies.probeReadiness(client, resolution.evidence),
        );
        return providerStatus;
      } catch (error) {
        const mapped = mapProviderFailure(error);
        if (mapped.code === "CODEX_AUTHENTICATION_REQUIRED") {
          providerStatus = { kind: "authentication-required" };
        }
        throw mapped;
      }
    })();
    const wrapped = operation.finally(() => {
      if (refreshInFlight === wrapped) refreshInFlight = null;
    });
    refreshInFlight = wrapped;
    void wrapped.catch(() => {});
    return wrapped;
  };

  const rejectForStatus = (status: AssistantProviderStatus): never => {
    switch (status.kind) {
      case "authentication-required":
        throw providerError(
          "CODEX_AUTHENTICATION_REQUIRED",
          "Codex authentication is required",
        );
      case "needs-reprobe":
        throw providerError(
          "CODEX_NEEDS_REPROBE",
          "Codex installation must be reprobed",
        );
      case "incompatible":
        throw providerError(
          "CODEX_INCOMPATIBLE",
          "Codex installation is incompatible",
        );
      case "probe-failed":
        throw providerError(
          "CODEX_PROBE_FAILED",
          "Codex installation probe failed",
        );
      case "unavailable":
        throw providerError(
          "CODEX_UNAVAILABLE",
          "Codex installation is unavailable",
        );
      case "offline":
        throw providerError(
          "CODEX_UNAVAILABLE",
          "Codex provider is unavailable",
        );
      case "probing":
        throw providerError("CODEX_PROBING", "Codex installation is probing");
      case "ready":
      case "ready-degraded":
        throw providerError("CODEX_PROVIDER_FAILED", "Codex provider failed");
    }
  };

  const reserve = (attemptId: AssistantAttemptId) => {
    ensureAccepting();
    if (activeAttemptId !== null) {
      throw providerError("CODEX_BUSY", "Another Codex attempt is active");
    }
    activeAttemptId = attemptId;
  };

  const host: CodexAppServerHost = {
    async status() {
      if (!accepting) return { kind: "unavailable" };
      if (firstStatusObservation) {
        firstStatusObservation = false;
        void refresh();
        return { kind: "probing" };
      }
      try {
        return await refresh();
      } catch {
        return providerStatus.kind === "probing"
          ? { kind: "probe-failed" }
          : providerStatus;
      }
    },
    async acquireAttempt(attemptId) {
      reserve(attemptId);
      try {
        const status = await refresh();
        if (status.kind !== "ready" && status.kind !== "ready-degraded") {
          return rejectForStatus(status);
        }
        const ownedClient = client!;
        let released = false;
        let threadId: string | null = null;
        let threadStartInFlight: Promise<string> | null = null;
        let turnId: string | null = null;
        let finalText: string | null = null;
        let cancelled = false;
        let terminal = true;
        let resolveTurnTerminal:
          | ((outcome: "completed" | "interrupted" | "outcome-unknown") => void)
          | null = null;
        let turnTerminal: Promise<
          "completed" | "interrupted" | "outcome-unknown"
        > | null = null;
        let modelDeadline: unknown = null;
        let interruptInFlight: Promise<InterruptOutcome> | null = null;
        let ownedTerminationObserved = false;
        let turnAdmissionState:
          "not-sent" | "pending" | "acknowledged" | "uncertain" = "not-sent";
        let rejectTurnAdmission: ((error: CodedError) => void) | null = null;
        const operations = new Set<Promise<unknown>>();
        const requireLease = () => {
          if (released || activeAttemptId !== attemptId) {
            throw providerError(
              "CODEX_ATTEMPT_RELEASED",
              "Codex attempt lease is released",
            );
          }
        };
        const track = <T>(operation: Promise<T>): Promise<T> => {
          operations.add(operation);
          void operation
            .finally(() => operations.delete(operation))
            .catch(() => {});
          return operation;
        };
        const startThread = () => {
          requireLease();
          if (threadId) return Promise.resolve(threadId);
          if (threadStartInFlight) return threadStartInFlight;
          const operation = withDeadline(
            "CODEX_THREAD_TIMED_OUT",
            CODEX_DEADLINES.threadMs,
            ownedClient.threadStart({
              cwd: dependencies.workRoot,
              approvalPolicy: "never",
              sandbox: "read-only",
              ephemeral: true,
              model: QALI_CODEX_MODEL,
            }),
          ).then((result) => {
            threadId = result.thread.id;
            return threadId;
          });
          threadStartInFlight = operation;
          void operation
            .finally(() => {
              if (threadStartInFlight === operation) {
                threadStartInFlight = null;
              }
            })
            .catch(() => {});
          return operation;
        };
        const release = async () => {
          if (released) return;
          await Promise.allSettled([...operations]);
          released = true;
          if (activeAttemptId === attemptId) activeAttemptId = null;
          if (activeLease === lease) activeLease = null;
          if (staleGeneration) {
            staleGeneration = false;
            await closeClient();
          }
        };
        const lease: CodexAttemptLease & { drain(): Promise<void> } = {
          startThread: () => track(startThread()),
          runTurn(input) {
            requireLease();
            if (!terminal) {
              return Promise.reject(
                providerError("CODEX_BUSY", "Codex turn is active"),
              );
            }
            terminal = false;
            cancelled = false;
            turnId = null;
            finalText = null;
            let unsubscribeTurn = () => {};
            let unsubscribeTermination = () => {};
            let replayPreAckMessages = () => {};
            ownedTerminationObserved = false;
            turnAdmissionState = "not-sent";
            const preAckMessages: NativeMessage[] = [];
            const operation = (async () => {
              const nativeThreadId = await startThread();
              if (cancelled) {
                throw providerError(
                  "CODEX_SEMANTIC_INTERRUPTED",
                  "Codex attempt was cancelled",
                );
              }
              turnTerminal = new Promise<
                "completed" | "interrupted" | "outcome-unknown"
              >((resolve) => {
                resolveTurnTerminal = resolve;
                const acceptTurnMessage = (message: NativeMessage) => {
                  const params = record(message.params) ? message.params : {};
                  if (
                    turnId === null &&
                    turnAdmissionState === "pending" &&
                    (message.method === "item/completed" ||
                      message.method === "turn/completed") &&
                    params.threadId === nativeThreadId
                  ) {
                    if (preAckMessages.length >= 64) {
                      turnAdmissionState = "uncertain";
                      resolve("outcome-unknown");
                      void closeClient().catch(() => {});
                    } else {
                      preAckMessages.push(message);
                    }
                    return;
                  }
                  if (message.method === "item/completed") {
                    const item = record(params.item) ? params.item : null;
                    if (
                      params.threadId !== nativeThreadId ||
                      params.turnId !== turnId
                    )
                      return;
                    if (
                      item?.type === "agentMessage" &&
                      typeof item.text === "string"
                    ) {
                      finalText = item.text;
                    }
                    return;
                  }
                  if (message.method !== "turn/completed") return;
                  const notifiedTurn = record(params.turn) ? params.turn : null;
                  if (
                    notifiedTurn?.id !== turnId ||
                    params.threadId !== nativeThreadId
                  )
                    return;
                  unsubscribeTurn();
                  const completed = notifiedTurn.status === "completed";
                  resolve(completed ? "completed" : "interrupted");
                };
                unsubscribeTurn = ownedClient.subscribe(acceptTurnMessage);
                replayPreAckMessages = () => {
                  for (const message of preAckMessages.splice(0)) {
                    acceptTurnMessage(message);
                  }
                };
              });
              unsubscribeTermination =
                ownedClient.subscribeTermination?.(() => {
                  ownedTerminationObserved = true;
                  resolveTurnTerminal?.("outcome-unknown");
                  void closeClient().catch(() => {});
                }) ?? (() => {});
              const nativeAdmission = ownedClient.turnStart({
                threadId: nativeThreadId,
                input: [{ type: "text", text: input.text, text_elements: [] }],
                approvalPolicy: "never",
                sandboxPolicy: { type: "readOnly" },
                outputSchema: input.outputSchema,
                model: QALI_CODEX_MODEL,
                effort: QALI_CODEX_REASONING_EFFORT,
              });
              // Once turn/start is written, a missing response cannot prove
              // rejection. Keep the provider promise observed after our
              // deadline/cancel wins and quarantine this generation.
              turnAdmissionState = "pending";
              const admissionCancelled = new Promise<never>((_, reject) => {
                rejectTurnAdmission = reject;
              });
              let started: TurnStartResult;
              try {
                started = await withDeadline(
                  "CODEX_TURN_ACK_TIMED_OUT",
                  CODEX_DEADLINES.turnAckMs,
                  Promise.race([nativeAdmission, admissionCancelled]),
                );
              } catch (error) {
                if (isDefiniteTurnRejection(error)) throw error;
                turnAdmissionState = "uncertain";
                resolveTurnTerminal?.("outcome-unknown");
                await closeClient().catch(() => {});
                throw providerError(
                  "CODEX_OUTCOME_UNKNOWN",
                  "Codex turn admission outcome is unknown",
                );
              } finally {
                rejectTurnAdmission = null;
              }
              turnAdmissionState = "acknowledged";
              turnId = started.turn.id;
              replayPreAckMessages();
              modelDeadline = deadlineScheduler.set(
                CODEX_DEADLINES.modelAbsoluteMs,
                () => {
                  // A turn may have reached the provider even when no more
                  // semantic frame can be trusted. Stop only this captured
                  // generation and retain an unknown outcome rather than
                  // replaying a possibly side-effecting request.
                  resolveTurnTerminal?.("outcome-unknown");
                  void closeClient().catch(() => {});
                },
              );
              if (cancelled) {
                void lease.interrupt();
              }
              const outcome = await turnTerminal;
              if (outcome === "outcome-unknown") {
                throw providerError(
                  "CODEX_OUTCOME_UNKNOWN",
                  "Codex turn outcome is unknown",
                );
              }
              if (outcome === "interrupted") {
                throw providerError(
                  "CODEX_SEMANTIC_INTERRUPTED",
                  "Codex attempt was interrupted",
                );
              }
              if (finalText === null) {
                throw providerError(
                  "CODEX_OUTPUT_MISSING",
                  "Codex returned no final message",
                );
              }
              return { finalText, threadId: nativeThreadId, turnId };
            })()
              .catch((error) => {
                throw mapProviderFailure(error);
              })
              .finally(() => {
                unsubscribeTurn();
                unsubscribeTermination();
                if (modelDeadline !== null) {
                  deadlineScheduler.clear(modelDeadline);
                  modelDeadline = null;
                }
                terminal = true;
                resolveTurnTerminal = null;
                turnTerminal = null;
                interruptInFlight = null;
                rejectTurnAdmission = null;
              });
            return track(operation);
          },
          async interrupt(report) {
            requireLease();
            if (terminal) {
              return {
                terminal: "completed-before-interrupt",
                milestones: ["completed-before-interrupt"],
              };
            }
            if (interruptInFlight) return interruptInFlight;
            cancelled = true;
            if (!threadId || !turnId || !turnTerminal) {
              if (
                turnAdmissionState === "pending" ||
                turnAdmissionState === "uncertain"
              ) {
                turnAdmissionState = "uncertain";
                const failure = providerError(
                  "CODEX_OUTCOME_UNKNOWN",
                  "Codex turn admission outcome is unknown",
                );
                rejectTurnAdmission?.(failure);
                resolveTurnTerminal?.("outcome-unknown");
                await closeClient().catch(() => {});
                await report?.("outcome-unknown");
                return {
                  terminal: "outcome-unknown",
                  milestones: ["outcome-unknown"],
                };
              }
              await report?.("semantically-interrupted");
              return {
                terminal: "semantically-interrupted",
                milestones: ["semantically-interrupted"],
              };
            }
            const nativeThreadId = threadId;
            const nativeTurnId = turnId;
            const semanticTerminal = turnTerminal;
            interruptInFlight = (async () => {
              const milestones: CancellationMilestone[] = ["interrupt-sent"];
              try {
                await report?.("interrupt-sent");
                await withDeadline(
                  "CODEX_INTERRUPT_ACK_TIMED_OUT",
                  CODEX_DEADLINES.interruptAckMs,
                  ownedClient.turnInterrupt({
                    threadId: nativeThreadId,
                    turnId: nativeTurnId,
                  }),
                );
                milestones.push("interrupt-acknowledged");
                await report?.("interrupt-acknowledged");
                const semantic = await new Promise<
                  | "completed"
                  | "interrupted"
                  | "outcome-unknown"
                  | "grace-expired"
                >((resolve) => {
                  let settled = false;
                  let timer: unknown;
                  const settle = (
                    value:
                      | "completed"
                      | "interrupted"
                      | "outcome-unknown"
                      | "grace-expired",
                  ) => {
                    if (settled) return;
                    settled = true;
                    deadlineScheduler.clear(timer);
                    resolve(value);
                  };
                  timer = deadlineScheduler.set(
                    CODEX_DEADLINES.interruptGraceMs,
                    () => settle("grace-expired"),
                  );
                  void semanticTerminal.then(settle);
                });
                if (semantic === "completed") {
                  milestones.push("completed-before-interrupt");
                  await report?.("completed-before-interrupt");
                  return {
                    terminal: "completed-before-interrupt" as const,
                    milestones,
                  };
                }
                if (semantic === "interrupted") {
                  milestones.push("semantically-interrupted");
                  await report?.("semantically-interrupted");
                  return {
                    terminal: "semantically-interrupted" as const,
                    milestones,
                  };
                }
              } catch {
                // A missing native acknowledgement is still not a semantic
                // cancellation. Fall through to terminate only this owner.
              }
              resolveTurnTerminal?.("outcome-unknown");
              await closeClient().catch(() => {});
              // Client close initiates cleanup but does not prove that every
              // owned descendant has exited. Do not claim termination until
              // the containment layer can observe it; this is deliberately
              // an unknown outcome rather than fabricated evidence.
              if (ownedTerminationObserved) {
                milestones.push("owned-process-terminated");
                await report?.("owned-process-terminated");
              }
              milestones.push("outcome-unknown");
              await report?.("outcome-unknown");
              return { terminal: "outcome-unknown" as const, milestones };
            })();
            return interruptInFlight;
          },
          release,
          async drain() {
            if (!terminal) await lease.interrupt().catch(() => {});
            await Promise.allSettled([...operations]);
            await release();
          },
        };
        activeLease = lease;
        return lease;
      } catch (error) {
        if (activeAttemptId === attemptId) activeAttemptId = null;
        throw mapProviderFailure(error);
      }
    },
    login(attemptId, signal) {
      reserve(attemptId);
      const controller = new AbortController();
      const abort = () => controller.abort();
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
      loginControllers.set(attemptId, controller);
      const operation = (async () => {
        let challengePublished = false;
        let terminalPublicationAttempted = false;
        const publishTerminalStatus = async (
          status: Exclude<AssistantProviderStatus, { kind: "offline" }>,
        ) => {
          terminalPublicationAttempted = true;
          await publishCodexLoginEvent(dependencies.loginEvents, {
            attemptId,
            event: { kind: "status", status },
          });
        };
        try {
          if (controller.signal.aborted) {
            throw providerError("CODEX_CANCELLED", "Codex login was cancelled");
          }
          const status = await refresh();
          if (status.kind !== "authentication-required" || !client) {
            return rejectForStatus(status);
          }
          const loginClient = client;
          await publishCodexLoginEvent(dependencies.loginEvents, {
            attemptId,
            event: { kind: "progress", stage: "requesting-code" },
          });
          const challenge = await loginClient.accountLoginStart();
          if (controller.signal.aborted) {
            throw providerError("CODEX_CANCELLED", "Codex login was cancelled");
          }
          await publishCodexLoginEvent(dependencies.loginEvents, {
            attemptId,
            event: { kind: "challenge-url", url: challenge.verificationUrl },
          });
          await publishCodexLoginEvent(dependencies.loginEvents, {
            attemptId,
            event: { kind: "challenge-code", code: challenge.userCode },
          });
          challengePublished = true;
          await dependencies.waitForLoginCompletion(loginClient, {
            loginId: challenge.loginId,
            signal: controller.signal,
          });
          if (controller.signal.aborted) {
            throw providerError("CODEX_CANCELLED", "Codex login was cancelled");
          }
          const terminalStatus = await refresh();
          if (terminalStatus.kind === "offline") {
            return rejectForStatus(terminalStatus);
          }
          await publishTerminalStatus(terminalStatus);
          if (
            terminalStatus.kind !== "ready" &&
            terminalStatus.kind !== "ready-degraded"
          ) {
            return rejectForStatus(terminalStatus);
          }
        } catch (error) {
          if (controller.signal.aborted) {
            throw providerError("CODEX_CANCELLED", "Codex login was cancelled");
          }
          const mapped = mapProviderFailure(error);
          if (mapped.code === "CODEX_CANCELLED") throw mapped;
          if (challengePublished && !terminalPublicationAttempted) {
            await publishTerminalStatus(terminalStatusForFailure(mapped));
          }
          throw mapped;
        } finally {
          signal.removeEventListener("abort", abort);
          loginControllers.delete(attemptId);
          if (activeAttemptId === attemptId) activeAttemptId = null;
        }
      })();
      loginOperations.add(operation);
      void operation
        .finally(() => loginOperations.delete(operation))
        .catch(() => {});
      return operation;
    },
    async cancel(attemptId) {
      if (activeAttemptId !== attemptId) return false;
      if (attemptId.startsWith("login_")) {
        const controller = loginControllers.get(attemptId);
        if (!controller) return false;
        controller.abort();
        return true;
      }
      if (!activeLease) return false;
      const outcome = await activeLease.interrupt();
      return outcome.terminal !== "completed-before-interrupt";
    },
    close() {
      if (closePromise) return closePromise;
      accepting = false;
      closePromise = (async () => {
        for (const controller of loginControllers.values()) controller.abort();
        const drain = activeLease?.drain() ?? Promise.resolve();
        const pendingRefresh = refreshInFlight;
        const drained = Promise.allSettled([
          drain,
          ...loginOperations,
          ...(pendingRefresh ? [pendingRefresh] : []),
        ]).then(() => undefined);
        const timeoutMs =
          dependencies.shutdownTimeoutMs ?? CODEX_DEADLINES.shutdownMs;
        await withDeadline(
          "CODEX_SHUTDOWN_TIMED_OUT",
          timeoutMs,
          drained,
        ).catch(() => {});
        activeAttemptId = null;
        activeLease = null;
        await closeClient().catch(() => {});
        providerStatus = { kind: "unavailable" };
      })();
      return closePromise;
    },
  };
  return Object.freeze(host);
}
