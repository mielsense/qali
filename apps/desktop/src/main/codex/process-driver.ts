import { spawn as nodeSpawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { assistantLoginAttemptIdSchema } from "@qali/desktop-contracts";

import { assertNoFileCredentials, buildCodexInvocation, CodexBoundaryError } from "./auth";
import {
  verifyCodexRuntimeBoundary,
  resolveCodexRuntimeAuthority,
  resolveCodexReleaseAuthority,
  type CodexReleaseAuthority,
  type CodexRuntimeAuthority,
  type CodexRuntimeBoundary,
  type VerifiedCodexBoundary,
} from "./boundary";
import { codexSandboxMetadataPathArguments } from "./sandbox-metadata";
import {
  MAX_CODEX_FRAME_BYTES,
  hasCodexLoginEventSubscriber,
  observeCodexLoginEventUnsubscribe,
  parseCodexJsonLine,
  parseCodexLoginLine,
  publishCodexLoginEvent,
  type CodexEvent,
  type CodexLoginEvent,
} from "./events";
import { validateCodexManifest } from "./manifest";

export type CodexChild = NodeJS.EventEmitter & {
  pid?: number;
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals): boolean;
  killOwnedGroup?(signal: NodeJS.Signals): void;
};

type SpawnOptions = {
  cwd: string;
  detached: true;
  env: Record<string, string>;
  shell: false;
  stdio: ["pipe", "pipe", "pipe"];
};
export type CodexSpawn = (command: string, args: string[], options: SpawnOptions) => CodexChild;

export type CodexPhaseRequest = Readonly<{
  authority: CodexRuntimeAuthority;
  phase?: "planner" | "finalizer";
  attemptId: string;
  prompt: string;
  timeoutMs: number;
  validateFinalOutput(text: string): void;
}>;

type ResolvedCodexPhaseRequest = CodexRuntimeBoundary &
  Omit<CodexPhaseRequest, "authority"> & { schemaPath: string };

export type CodexReleasePhaseRequest = Readonly<{
  authority: CodexReleaseAuthority;
  phase?: "planner" | "finalizer";
  attemptId: string;
  prompt: string;
  timeoutMs: number;
  validateFinalOutput(text: string): void;
}>;
type ResolvedCodexReleasePhaseRequest = ResolvedCodexPhaseRequest & Readonly<{
  testProvider: { id: string; baseUrl: string; model: string };
}>;

export type CodexPhaseResult = Readonly<{
  attemptId: string;
  events: readonly CodexEvent[];
  finalText: string;
}>;

export type CodexDriverDependencies = Readonly<{
  spawnProcess?: CodexSpawn;
  verifyBoundary?: (
    boundary: CodexRuntimeBoundary,
    options: Readonly<{
      allowBlockedCapability?: boolean;
      allowCapabilityProvider?: boolean;
    }>,
  ) => Promise<VerifiedCodexBoundary>;
  processGroupAlive?: (pid: number) => boolean;
  signalOwnedGroup?: (child: CodexChild, signal: NodeJS.Signals) => void;
  wait?: (milliseconds: number) => Promise<void>;
}>;
type DriverDependencies = CodexDriverDependencies;

export type CodexLoginRequest = Readonly<{
  authority: CodexRuntimeAuthority;
  attemptId: string;
  signal?: AbortSignal;
  timeoutMs: number;
}>;
export type CodexLoginResult = Readonly<{
  attemptId: string;
  events: readonly CodexLoginEvent[];
}>;

const attempts = new Map<string, { cancel(): boolean }>();
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_LOGIN_EVENTS = 128;
const MAX_TOTAL_STDOUT_BYTES = 512 * 1024;
const TERMINATE_GRACE_MS = 500;
const KILL_GRACE_MS = 500;

function processGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

function signalOwnedGroup(child: CodexChild, signal: NodeJS.Signals): void {
  if (child.killOwnedGroup) {
    child.killOwnedGroup(signal);
    return;
  }
  const pid = child.pid;
  if (pid && pid > 1) {
    try {
      process.kill(-pid, signal);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  child.kill(signal);
}

async function waitForOwnedGroupDrain(
  child: CodexChild,
  dependencies: DriverDependencies,
): Promise<void> {
  const pid = child.pid;
  if (!pid || pid <= 1) return;
  const alive = dependencies.processGroupAlive ?? processGroupAlive;
  const wait = dependencies.wait ?? ((milliseconds) => new Promise<void>((resolvePromise) => {
    setTimeout(resolvePromise, milliseconds);
  }));
  const waitUntilGone = async (milliseconds: number): Promise<boolean> => {
    const deadline = Date.now() + milliseconds;
    do {
      if (!alive(pid)) return true;
      await wait(20);
    } while (Date.now() < deadline);
    return !alive(pid);
  };
  if (await waitUntilGone(TERMINATE_GRACE_MS)) return;
  (dependencies.signalOwnedGroup ?? signalOwnedGroup)(child, "SIGKILL");
  if (!(await waitUntilGone(KILL_GRACE_MS))) {
    throw new CodexBoundaryError("CODEX_TERMINATION_TIMEOUT", "Codex process group did not terminate");
  }
}

function validateRequestShape(request: Pick<CodexPhaseRequest, "phase" | "attemptId" | "prompt" | "timeoutMs" | "validateFinalOutput">): void {
  if (
    request.phase !== undefined &&
    request.phase !== "planner" &&
    request.phase !== "finalizer"
  ) {
    throw new CodexBoundaryError("CODEX_INVALID_PHASE", "Codex phase is invalid");
  }
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(request.attemptId) || attempts.has(request.attemptId)) {
    throw new CodexBoundaryError("CODEX_INVALID_ATTEMPT", "Codex attempt identity is invalid or active");
  }
  if (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > 120_000) {
    throw new CodexBoundaryError("CODEX_INVALID_TIMEOUT", "Codex timeout is invalid");
  }
  if (Buffer.byteLength(request.prompt, "utf8") > 128 * 1024) {
    throw new CodexBoundaryError("CODEX_INPUT_OVERFLOW", "Codex input is oversized");
  }
  if (typeof request.validateFinalOutput !== "function") {
    throw new CodexBoundaryError("CODEX_OUTPUT_VALIDATOR_REQUIRED", "A final output validator is required");
  }
}

export function cancelCodexAttempt(attemptId: string): boolean {
  return attempts.get(attemptId)?.cancel() ?? false;
}

export async function runCodexPhase(
  request: CodexPhaseRequest,
  spawnProcessOrDependencies: CodexSpawn | DriverDependencies = {},
): Promise<CodexPhaseResult> {
  validateRequestShape(request);
  const boundary = resolveCodexRuntimeAuthority(request.authority);
  const manifest = validateCodexManifest(boundary.manifest);
  if (manifest.capability.status !== "ready") {
    throw new CodexBoundaryError("CODEX_CAPABILITY_BLOCKED", "Codex capability evidence is not ready");
  }
  const dependencies: DriverDependencies = typeof spawnProcessOrDependencies === "function"
    ? { spawnProcess: spawnProcessOrDependencies }
    : spawnProcessOrDependencies;
  const { authority: _authority, ...phase } = request;
  return runCodexPhaseCore({
    ...boundary,
    ...phase,
    schemaPath: boundary.phaseSchemaPaths[request.phase ?? "planner"],
  }, false, dependencies);
}

/** Release-only primitive. It permits a blocked capability manifest solely so
 * deterministic evidence can be collected, while retaining every other exact
 * binary/profile/proxy/auth boundary check. */
export async function runCodexReleasePhase(
  request: CodexReleasePhaseRequest,
  dependencies: DriverDependencies = {},
): Promise<CodexPhaseResult> {
  validateRequestShape(request);
  const release = resolveCodexReleaseAuthority(request.authority);
  validateCodexManifest(release.boundary.manifest);
  const { authority: _authority, ...phase } = request;
  return runCodexPhaseCore({
    ...release.boundary,
    ...phase,
    schemaPath: release.boundary.phaseSchemaPaths[request.phase ?? "planner"],
    testProvider: release.testProvider,
  }, true, dependencies);
}

async function runCodexPhaseCore(
  request: ResolvedCodexPhaseRequest | ResolvedCodexReleasePhaseRequest,
  allowBlockedCapability: boolean,
  dependencies: DriverDependencies,
): Promise<CodexPhaseResult> {
  const verifyBoundary = dependencies.verifyBoundary ?? verifyCodexRuntimeBoundary;
  const verified = await verifyBoundary(request, {
    allowBlockedCapability,
    allowCapabilityProvider: allowBlockedCapability,
  });
  if (verified.executablePath !== request.manifest.executable.resolvedPath) {
    throw new CodexBoundaryError("CODEX_BINARY_INCOMPATIBLE", "Verified Codex target changed");
  }
  const codexHome = verified.codexHome ?? request.codexHome;
  const cwd = verified.cwd ?? request.cwd;
  const credentialCheck = () => assertNoFileCredentials(codexHome, request.keyringHealthProbe);
  // Repeat immediately before construction so a credential file cannot race the
  // more expensive binary/profile verification.
  await credentialCheck();
  const invocation = buildCodexInvocation({
    kind: "exec",
    codexHome,
    cwd,
    schemaPath: request.schemaPath,
    proxyUrl: verified.proxyUrl,
    testProvider: "testProvider" in request ? request.testProvider : undefined,
  });
  const sandboxArgs = [
    ...codexSandboxMetadataPathArguments([codexHome, cwd]),
    "-D", `CODEX_HOME=${codexHome}`,
    "-D", `CODEX_CWD=${cwd}`,
    "-D", `CODEX_SCHEMA=${request.schemaPath}`,
    "-D", `CODEX_EXECUTABLE=${verified.executablePath}`,
    "-D", `CODEX_PROXY_ENDPOINT=${verified.proxyEndpoint}`,
    "-f", request.sandboxProfilePath,
    verified.executablePath,
    ...invocation.args,
  ];
  const spawnProcess = dependencies.spawnProcess ?? nodeSpawn as unknown as CodexSpawn;
  const child = spawnProcess("/usr/bin/sandbox-exec", sandboxArgs, invocation.options);

  return new Promise<CodexPhaseResult>((resolvePromise, rejectPromise) => {
    let finalized = false;
    let finalizing = false;
    let spawned = false;
    let stdoutBuffer = Buffer.alloc(0);
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let exitCode: number | null = null;
    let protocolState: "initial" | "thread" | "turn" | "completed" = "initial";
    let finalText: string | undefined;
    let pendingFailure: CodexBoundaryError | undefined;
    let forcedCloseTimer: ReturnType<typeof setTimeout> | undefined;
    const events: CodexEvent[] = [];

    const cleanup = () => {
      clearTimeout(timeout);
      if (forcedCloseTimer) clearTimeout(forcedCloseTimer);
      attempts.delete(request.attemptId);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("error", onError);
      child.off("spawn", onSpawn);
      child.off("exit", onExit);
      child.off("close", onClose);
    };

    const finalize = async () => {
      if (finalized || finalizing) return;
      finalizing = true;
      clearTimeout(timeout);
      if (forcedCloseTimer) clearTimeout(forcedCloseTimer);
      let outcome = pendingFailure;
      if (!outcome && stdoutBuffer.byteLength !== 0) {
        outcome = new CodexBoundaryError("CODEX_PROTOCOL_INVALID", "Codex ended with a partial JSONL frame");
      }
      if (!outcome && (exitCode !== 0 || protocolState !== "completed" || finalText === undefined)) {
        outcome = new CodexBoundaryError(
          exitCode !== 0 ? "CODEX_PROCESS_FAILED" : "CODEX_PROTOCOL_INVALID",
          spawned ? "Codex exited without a trusted completed response" : "Codex did not start",
        );
      }
      try {
        // A closed leader can still leave descendants in its process group.
        if (child.pid && (dependencies.processGroupAlive ?? processGroupAlive)(child.pid)) {
          (dependencies.signalOwnedGroup ?? signalOwnedGroup)(child, "SIGTERM");
        }
        await waitForOwnedGroupDrain(child, dependencies);
      } catch (error) {
        outcome = error instanceof CodexBoundaryError
          ? error
          : new CodexBoundaryError("CODEX_TERMINATION_TIMEOUT", "Codex process group cleanup failed");
      }
      try {
        await credentialCheck();
      } catch (error) {
        outcome = error instanceof CodexBoundaryError
          ? error
          : new CodexBoundaryError("CODEX_FILE_CREDENTIALS", "Credential-file state is untrusted");
      }
      if (!outcome && finalText !== undefined) {
        try {
          request.validateFinalOutput(finalText);
        } catch {
          outcome = new CodexBoundaryError("CODEX_OUTPUT_INVALID", "Codex final output failed validation");
        }
      }
      finalized = true;
      cleanup();
      if (outcome) rejectPromise(outcome);
      else resolvePromise({ attemptId: request.attemptId, events, finalText: finalText! });
    };

    const requestFailure = (error: CodexBoundaryError) => {
      if (pendingFailure || finalized) return;
      pendingFailure = error;
      try { (dependencies.signalOwnedGroup ?? signalOwnedGroup)(child, "SIGTERM"); } catch { /* finalized as cleanup failure */ }
      if (forcedCloseTimer) clearTimeout(forcedCloseTimer);
      forcedCloseTimer = setTimeout(() => {
        try { (dependencies.signalOwnedGroup ?? signalOwnedGroup)(child, "SIGKILL"); } catch { /* finalized below */ }
        void finalize();
      }, TERMINATE_GRACE_MS + KILL_GRACE_MS);
      forcedCloseTimer.unref?.();
    };

    const acceptEvent = (event: CodexEvent) => {
      if (event.kind === "lifecycle") {
        if (event.type === "thread.started" && protocolState === "initial") protocolState = "thread";
        else if (event.type === "turn.started" && protocolState === "thread") protocolState = "turn";
        else if (event.type === "turn.completed" && protocolState === "turn" && finalText !== undefined) protocolState = "completed";
        else if (event.type === "turn.failed" || event.type === "error") {
          throw new CodexBoundaryError("CODEX_PROTOCOL_INVALID", "Codex reported a failed turn");
        } else {
          throw new CodexBoundaryError("CODEX_PROTOCOL_INVALID", "Codex lifecycle ordering is invalid");
        }
      } else {
        if (protocolState !== "turn") {
          throw new CodexBoundaryError("CODEX_PROTOCOL_INVALID", "Codex item occurred outside an active turn");
        }
        if (event.kind === "assistant-message") {
          if (finalText !== undefined) throw new CodexBoundaryError("CODEX_PROTOCOL_INVALID", "Codex emitted multiple final messages");
          finalText = event.text;
        }
      }
      events.push(event);
    };

    const onStdout = (chunk: Buffer | string) => {
      if (pendingFailure) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutBytes += bytes.byteLength;
      if (stdoutBytes > MAX_TOTAL_STDOUT_BYTES) {
        requestFailure(new CodexBoundaryError("CODEX_PROTOCOL_OVERFLOW", "Codex output exceeded its total bound"));
        return;
      }
      stdoutBuffer = Buffer.concat([stdoutBuffer, bytes]);
      if (stdoutBuffer.byteLength > MAX_CODEX_FRAME_BYTES && !stdoutBuffer.includes(0x0a)) {
        requestFailure(new CodexBoundaryError("CODEX_PROTOCOL_OVERFLOW", "Codex partial frame exceeded its bound"));
        return;
      }
      for (;;) {
        const newline = stdoutBuffer.indexOf(0x0a);
        if (newline < 0) break;
        const frame = stdoutBuffer.subarray(0, newline);
        stdoutBuffer = stdoutBuffer.subarray(newline + 1);
        if (frame.byteLength === 0) continue;
        try {
          const line = new TextDecoder("utf-8", { fatal: true }).decode(frame);
          acceptEvent(parseCodexJsonLine(line));
        } catch (error) {
          requestFailure(error instanceof CodexBoundaryError
            ? error
            : new CodexBoundaryError("CODEX_PROTOCOL_INVALID", "Codex emitted invalid UTF-8"));
          return;
        }
      }
    };
    const onStderr = (chunk: Buffer | string) => {
      stderrBytes += Buffer.isBuffer(chunk) ? chunk.byteLength : Buffer.byteLength(chunk);
      if (stderrBytes > MAX_STDERR_BYTES) {
        requestFailure(new CodexBoundaryError("CODEX_DIAGNOSTIC_OVERFLOW", "Codex diagnostics exceeded their bound"));
      }
    };
    const onError = () => requestFailure(new CodexBoundaryError("CODEX_PROCESS_FAILED", "Codex process failed"));
    const onSpawn = () => {
      spawned = true;
      child.stdin.on("error", () => requestFailure(new CodexBoundaryError("CODEX_PROCESS_FAILED", "Codex input pipe failed")));
      child.stdin.end(`${request.prompt}\n`);
    };
    const onExit = (code: number | null) => { exitCode = code; };
    const onClose = (code: number | null) => {
      if (exitCode === null) exitCode = code;
      void finalize();
    };
    const timeout = setTimeout(() => requestFailure(new CodexBoundaryError("CODEX_TIMEOUT", "Codex phase timed out")), request.timeoutMs);
    attempts.set(request.attemptId, {
      cancel() {
        if (pendingFailure || finalized) return false;
        requestFailure(new CodexBoundaryError("CODEX_CANCELLED", "Codex phase was cancelled"));
        return true;
      },
    });
    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("error", onError);
    child.once("spawn", onSpawn);
    child.once("exit", onExit);
    child.once("close", onClose);
  });
}

export async function superviseCodexDeviceLogin(input: Readonly<{
  boundary: CodexRuntimeBoundary;
  verified: VerifiedCodexBoundary;
  attemptId: string;
  signal?: AbortSignal;
  timeoutMs: number;
}>, dependencies: DriverDependencies = {}): Promise<CodexLoginResult> {
  if (
    !assistantLoginAttemptIdSchema.safeParse(input.attemptId).success ||
    attempts.has(input.attemptId)
  ) {
    throw new CodexBoundaryError("CODEX_INVALID_ATTEMPT", "Codex login attempt identity is invalid or active");
  }
  if (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 300_000) {
    throw new CodexBoundaryError("CODEX_INVALID_TIMEOUT", "Codex login timeout is invalid");
  }
  const boundary = input.boundary;
  const loginEvents = boundary.loginEvents;
  if (!loginEvents || !hasCodexLoginEventSubscriber(loginEvents)) {
    throw new CodexBoundaryError("CODEX_LOGIN_EVENT_SINK_CLOSED", "A live application login event subscriber is required");
  }
  const codexHome = input.verified.codexHome ?? boundary.codexHome;
  const cwd = input.verified.cwd ?? boundary.cwd;
  const credentialCheck = () => assertNoFileCredentials(codexHome, boundary.keyringHealthProbe);
  const deadline = Date.now() + input.timeoutMs;
  let cancelActive: ((error: CodexBoundaryError) => void) | undefined;
  let pendingCancellation: CodexBoundaryError | undefined;
  let sinkClosed: CodexBoundaryError | undefined;
  const cancellationError = () => new CodexBoundaryError(
    "CODEX_CANCELLED",
    "Codex login was cancelled",
  );
  const throwIfCancelled = () => {
    if (input.signal?.aborted) pendingCancellation ??= cancellationError();
    if (pendingCancellation) throw pendingCancellation;
  };
  const stopObservingSink = observeCodexLoginEventUnsubscribe(loginEvents, () => {
    sinkClosed = new CodexBoundaryError("CODEX_LOGIN_EVENT_SINK_CLOSED", "Login event subscriber closed while authentication was pending");
    cancelActive?.(sinkClosed);
  });
  attempts.set(input.attemptId, {
    cancel() {
      pendingCancellation ??= cancellationError();
      cancelActive?.(pendingCancellation);
      return true;
    },
  });
  const abortAttempt = () => {
    attempts.get(input.attemptId)?.cancel();
  };
  input.signal?.addEventListener("abort", abortAttempt, { once: true });

  const runChild = async (kind: "login" | "status"): Promise<{ events: CodexLoginEvent[] }> => {
    throwIfCancelled();
    if (sinkClosed) throw sinkClosed;
    const invocation = buildCodexInvocation({
      kind,
      codexHome,
      cwd,
      proxyUrl: input.verified.proxyUrl,
    });
    const sandboxArgs = [
      ...codexSandboxMetadataPathArguments([codexHome, cwd]),
      "-D", `CODEX_HOME=${codexHome}`,
      "-D", `CODEX_CWD=${cwd}`,
      "-D",
      `CODEX_SCHEMA=${
        boundary.phaseSchemaPaths?.planner ??
        (boundary as CodexRuntimeBoundary & { schemaPath?: string }).schemaPath ??
        ""
      }`,
      "-D", `CODEX_EXECUTABLE=${input.verified.executablePath}`,
      "-D", `CODEX_PROXY_ENDPOINT=${input.verified.proxyEndpoint}`,
      "-f", boundary.sandboxProfilePath,
      input.verified.executablePath,
      ...invocation.args,
    ];
    throwIfCancelled();
    const child = (dependencies.spawnProcess ?? nodeSpawn as unknown as CodexSpawn)(
      "/usr/bin/sandbox-exec",
      sandboxArgs,
      invocation.options,
    );
    return new Promise((resolvePromise, rejectPromise) => {
      let buffer = Buffer.alloc(0);
      let outputBytes = 0;
      let diagnosticBytes = 0;
      let failure: CodexBoundaryError | undefined;
      let exitCode: number | null = null;
      let finalized = false;
      let forcedTimer: ReturnType<typeof setTimeout> | undefined;
      const events: CodexLoginEvent[] = [];
      const statusLines: string[] = [];
      let publications = Promise.resolve();
      const cleanup = () => {
        clearTimeout(timeout);
        if (forcedTimer) clearTimeout(forcedTimer);
        child.stdout.off("data", onStdout);
        child.stderr.off("data", onStderr);
        cancelActive = undefined;
      };
      const acceptLine = (frame: Buffer) => {
        if (frame.byteLength === 0) return;
        let line: string;
        try { line = new TextDecoder("utf-8", { fatal: true }).decode(frame); } catch {
          throw new CodexBoundaryError("CODEX_LOGIN_PROTOCOL_INVALID", "Codex login emitted invalid UTF-8");
        }
        if (kind === "login") {
          if (events.length >= MAX_LOGIN_EVENTS) {
            throw new CodexBoundaryError("CODEX_LOGIN_PROTOCOL_OVERFLOW", "Codex login emitted too many events");
          }
          const event = parseCodexLoginLine(line);
          events.push(event);
          publications = publications.then(async () => {
            let publicationTimer: ReturnType<typeof setTimeout> | undefined;
            try {
              await Promise.race([
                publishCodexLoginEvent(loginEvents, { attemptId: input.attemptId, event }),
                new Promise<never>((_resolvePromise, rejectPromise) => {
                  publicationTimer = setTimeout(() => rejectPromise(new CodexBoundaryError(
                    "CODEX_TIMEOUT",
                    "Codex login timed out",
                  )), Math.max(1, deadline - Date.now()));
                  publicationTimer.unref?.();
                }),
              ]);
            } finally {
              if (publicationTimer) clearTimeout(publicationTimer);
            }
          });
          void publications.catch((error) => requestFailure(error instanceof CodexBoundaryError
            ? error
            : new CodexBoundaryError("CODEX_LOGIN_EVENT_SINK_FAILED", "Login event delivery failed")));
        } else statusLines.push(line.trim());
      };
      const finalize = async (code: number | null) => {
        if (finalized) return;
        finalized = true;
        let outcome = failure;
        if (!outcome && code !== 0) outcome = new CodexBoundaryError("CODEX_PROCESS_FAILED", "Codex login process failed");
        if (!outcome) {
          try { acceptLine(buffer); } catch (error) {
            outcome = error instanceof CodexBoundaryError
              ? error
              : new CodexBoundaryError("CODEX_LOGIN_PROTOCOL_INVALID", "Codex login output was invalid");
          }
        }
        try {
          await publications;
        } catch {
          outcome = failure ?? new CodexBoundaryError("CODEX_LOGIN_EVENT_SINK_FAILED", "Login event delivery failed");
        }
        if (!outcome && failure) outcome = failure;
        try {
          if (child.pid && (dependencies.processGroupAlive ?? processGroupAlive)(child.pid)) {
            (dependencies.signalOwnedGroup ?? signalOwnedGroup)(child, "SIGTERM");
          }
          await waitForOwnedGroupDrain(child, dependencies);
          await credentialCheck();
        } catch (error) {
          outcome = error instanceof CodexBoundaryError
            ? error
            : new CodexBoundaryError("CODEX_PROCESS_FAILED", "Codex login cleanup failed");
        }
        if (!outcome && kind === "login") {
          const kinds = new Set(events.map((event) => event.kind));
          const stored = events.some((event) => event.kind === "progress" && event.stage === "credentials-stored");
          if (!kinds.has("challenge-url") || !kinds.has("challenge-code") || !stored) {
            outcome = new CodexBoundaryError("CODEX_LOGIN_PROTOCOL_INVALID", "Codex device login did not complete its challenge");
          }
        }
        if (!outcome && kind === "status" && (statusLines.length !== 1 || statusLines[0] !== "Logged in using ChatGPT")) {
          outcome = new CodexBoundaryError("CODEX_LOGIN_NOT_AUTHENTICATED", "Codex subscription authentication was not proven");
        }
        cleanup();
        if (outcome) rejectPromise(outcome);
        else resolvePromise({ events });
      };
      const requestFailure = (error: CodexBoundaryError) => {
        if (failure || finalized) return;
        failure = error;
        try { (dependencies.signalOwnedGroup ?? signalOwnedGroup)(child, "SIGTERM"); } catch { /* finalized below */ }
        forcedTimer = setTimeout(() => {
          try { (dependencies.signalOwnedGroup ?? signalOwnedGroup)(child, "SIGKILL"); } catch { /* finalized below */ }
          void finalize(null);
        }, TERMINATE_GRACE_MS + KILL_GRACE_MS);
        forcedTimer.unref?.();
      };
      const onStdout = (chunk: Buffer | string) => {
        if (failure) return;
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        outputBytes += bytes.byteLength;
        if (outputBytes > MAX_STDERR_BYTES) {
          requestFailure(new CodexBoundaryError("CODEX_LOGIN_PROTOCOL_OVERFLOW", "Codex login output exceeded its bound"));
          return;
        }
        buffer = Buffer.concat([buffer, bytes]);
        for (;;) {
          const newline = buffer.indexOf(0x0a);
          if (newline < 0) break;
          const frame = buffer.subarray(0, newline);
          buffer = buffer.subarray(newline + 1);
          try { acceptLine(frame); } catch (error) {
            requestFailure(error instanceof CodexBoundaryError
              ? error
              : new CodexBoundaryError("CODEX_LOGIN_PROTOCOL_INVALID", "Codex login output was invalid"));
            return;
          }
        }
      };
      const onStderr = (chunk: Buffer | string) => {
        diagnosticBytes += Buffer.isBuffer(chunk) ? chunk.byteLength : Buffer.byteLength(chunk);
        if (diagnosticBytes > MAX_STDERR_BYTES) {
          requestFailure(new CodexBoundaryError("CODEX_DIAGNOSTIC_OVERFLOW", "Codex login diagnostics exceeded their bound"));
        }
      };
      const remaining = Math.max(1, deadline - Date.now());
      const timeout = setTimeout(() => requestFailure(new CodexBoundaryError("CODEX_TIMEOUT", "Codex login timed out")), remaining);
      cancelActive = requestFailure;
      child.stdout.on("data", onStdout);
      child.stderr.on("data", onStderr);
      child.once("error", () => requestFailure(new CodexBoundaryError("CODEX_PROCESS_FAILED", "Codex login process failed")));
      child.once("spawn", () => child.stdin.end());
      child.once("exit", (code) => { exitCode = code; });
      child.once("close", (code) => { void finalize(exitCode ?? code); });
    });
  };

  try {
    throwIfCancelled();
    await credentialCheck();
    throwIfCancelled();
    const login = await runChild("login");
    throwIfCancelled();
    await runChild("status");
    throwIfCancelled();
    return { attemptId: input.attemptId, events: login.events };
  } finally {
    attempts.delete(input.attemptId);
    cancelActive = undefined;
    input.signal?.removeEventListener("abort", abortAttempt);
    stopObservingSink();
  }
}

export async function runCodexLogin(
  request: CodexLoginRequest,
  dependencies: DriverDependencies = {},
): Promise<CodexLoginResult> {
  const throwIfCancelled = () => {
    if (request.signal?.aborted) {
      throw new CodexBoundaryError("CODEX_CANCELLED", "Codex login was cancelled");
    }
  };
  throwIfCancelled();
  if (
    !assistantLoginAttemptIdSchema.safeParse(request.attemptId).success ||
    attempts.has(request.attemptId)
  ) {
    throw new CodexBoundaryError("CODEX_INVALID_ATTEMPT", "Codex login attempt identity is invalid or active");
  }
  if (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > 300_000) {
    throw new CodexBoundaryError("CODEX_INVALID_TIMEOUT", "Codex login timeout is invalid");
  }
  const boundary = resolveCodexRuntimeAuthority(request.authority);
  const manifest = validateCodexManifest(boundary.manifest);
  if (manifest.capability.status !== "ready") {
    throw new CodexBoundaryError("CODEX_CAPABILITY_BLOCKED", "Codex capability evidence is not ready");
  }
  const verifyBoundary = dependencies.verifyBoundary ?? verifyCodexRuntimeBoundary;
  throwIfCancelled();
  const verified = await verifyBoundary(boundary, {});
  throwIfCancelled();
  if (verified.executablePath !== manifest.executable.resolvedPath) {
    throw new CodexBoundaryError("CODEX_BINARY_INCOMPATIBLE", "Verified Codex target changed");
  }
  return superviseCodexDeviceLogin({
    boundary,
    verified,
    attemptId: request.attemptId,
    signal: request.signal,
    timeoutMs: request.timeoutMs,
  }, dependencies);
}
