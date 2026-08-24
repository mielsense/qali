import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import {
  CODEX_DEADLINES,
  createContainedCodexAppServerClient,
  createCodexAppServerHost,
  createCodexAppServerHostPhaseRunner,
  createCodexInstallationSelection,
  type CodexAppServerHost,
  type CodexAppServerHostDependencies,
} from "../src/main/codex/app-server-provider";
import { CODEX_APP_SERVER_ARGS } from "../src/main/codex/app-server-containment";
import { loadCodexManifest } from "../src/main/codex/manifest";
import {
  createCodexLoginEventChannel,
  subscribeCodexLoginEvents,
} from "../src/main/codex/events";

const ATTEMPT_A = `assistant_${"a".repeat(32)}`;
const ATTEMPT_B = `assistant_${"b".repeat(32)}`;
const LOGIN_A = `login_${"a".repeat(32)}`;

function fakeDeadlineScheduler() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { due: number; callback: () => void }>();
  return {
    now: () => now,
    set(delayMs: number, callback: () => void) {
      const id = nextId++;
      timers.set(id, { due: now + delayMs, callback });
      return id;
    },
    clear(handle: unknown) {
      timers.delete(handle as number);
    },
    advance(delayMs: number) {
      now += delayMs;
      // Run due timers by deadline, then insertion order. A callback can
      // schedule another timer that is already due, and that work must run in
      // this advance rather than getting stranded behind a later assertion.
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.due <= now)
          .sort(([leftId, left], [rightId, right]) =>
            left.due === right.due ? leftId - rightId : left.due - right.due,
          )[0];
        if (!due) return;
        const [id, timer] = due;
        timers.delete(id);
        timer.callback();
      }
    },
  };
}

async function flushMicrotasks(rounds = 8): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await Promise.resolve();
  }
}

function fakeHost(overrides: Partial<CodexAppServerHostDependencies> = {}) {
  const loginEvents = createCodexLoginEventChannel();
  const events: unknown[] = [];
  const unsubscribe = subscribeCodexLoginEvents(loginEvents, (event) => {
    events.push(event);
  });
  let identity = "a".repeat(64);
  let account: { type: string } | null = { type: "chatgpt" };
  let initializeCalls = 0;
  let closeCalls = 0;
  let interruptCalls = 0;
  let finishTurn: ((status?: string) => void) | undefined;
  let markTurnStarted!: () => void;
  const turnStarted = new Promise<void>((resolve) => {
    markTurnStarted = resolve;
  });
  const listeners = new Set<(message: any) => void>();
  const terminationListeners = new Set<() => void>();
  const client = {
    async initialize() {
      initializeCalls += 1;
      return {};
    },
    async accountRead() {
      return { account, requiresOpenaiAuth: true };
    },
    async accountLoginStart() {
      return {
        type: "chatgptDeviceCode" as const,
        loginId: "login-native",
        verificationUrl: "https://auth.openai.com/device",
        userCode: "ABCD-EFGH",
      };
    },
    async threadStart() {
      return { thread: { id: "thread-1" } };
    },
    async turnStart() {
      queueMicrotask(() => {
        queueMicrotask(() => {
          queueMicrotask(() => {
            for (const listener of listeners) {
              listener({
                method: "turn/started",
                params: { turn: { id: "turn-1" } },
              });
              listener({
                method: "item/completed",
                params: {
                  threadId: "thread-1",
                  turnId: "turn-1",
                  item: {
                    type: "agentMessage",
                    text: "done",
                  },
                },
              });
            }
          });
        });
      });
      queueMicrotask(() => {
        queueMicrotask(() => {
          queueMicrotask(markTurnStarted);
        });
      });
      finishTurn = (status = "completed") =>
        queueMicrotask(() => {
          for (const listener of listeners) {
            listener({
              method: "turn/completed",
              params: {
                threadId: "thread-1",
                turn: { id: "turn-1", status },
              },
            });
          }
        });
      return { turn: { id: "turn-1" } };
    },
    async turnInterrupt() {
      interruptCalls += 1;
      finishTurn?.();
    },
    subscribe(listener: (message: any) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeTermination(listener: () => void) {
      terminationListeners.add(listener);
      return () => terminationListeners.delete(listener);
    },
    async close() {
      closeCalls += 1;
    },
  };
  const dependencies: CodexAppServerHostDependencies = {
    async resolveInstallation() {
      return {
        kind: "supported",
        evidence: {
          executablePath: "/Applications/Codex",
          version: "codex-cli 0.147.0",
          arch: "arm64",
          format: "Mach-O 64-bit executable arm64",
          sha256: identity,
          generatedSchemaSha256: "b".repeat(64),
        },
      };
    },
    async createClient() {
      return client;
    },
    async probeReadiness() {
      return { kind: "ready" };
    },
    async waitForLoginCompletion() {
      account = { type: "chatgpt" };
    },
    loginEvents,
    workRoot: "/private/qali-work",
    shutdownTimeoutMs: 100,
    ...overrides,
  };
  return {
    client,
    dependencies,
    events,
    finishTurn: (status?: string) => finishTurn?.(status),
    emit(message: any) {
      for (const listener of listeners) listener(message);
    },
    emitTermination() {
      for (const listener of terminationListeners) listener();
    },
    setAccount(value: { type: string } | null) {
      account = value;
    },
    setIdentity(value: string) {
      identity = value;
    },
    counts: () => ({ closeCalls, initializeCalls, interruptCalls }),
    listenerCount: () => listeners.size,
    turnStarted,
    unsubscribe,
  };
}

describe("long-lived Codex App Server host", () => {
  test("composes one contained client generation and closes its owner", async () => {
    const calls: string[] = [];
    const evidence = {
      executablePath: "/Applications/Codex",
      version: "codex-cli 0.147.0",
      arch: "arm64",
      format: "Mach-O 64-bit executable arm64",
      sha256: "a".repeat(64),
      generatedSchemaSha256: "b".repeat(64),
    };
    const fake = fakeHost();
    const nativeClient = {
      ...fake.client,
      async close() {
        calls.push("client-close");
      },
    };
    const client = await createContainedCodexAppServerClient(
      {} as never,
      evidence,
      {
        createAuthority(_runtimeAuthority, receivedEvidence) {
          expect(receivedEvidence).toBe(evidence);
          return {} as never;
        },
        async createContainment() {
          return {
            spawn(args) {
              expect(args).toEqual(CODEX_APP_SERVER_ARGS);
              calls.push("spawn");
              return {} as never;
            },
            workRoot: () => "/private/qali-work",
            async release() {
              calls.push("release");
            },
            async close() {
              calls.push("containment-close");
            },
          };
        },
        createTransport() {
          return {} as never;
        },
        createClient() {
          return nativeClient;
        },
      },
    );

    await client.close();
    await client.close();
    expect(calls).toEqual([
      "spawn",
      "client-close",
      "release",
      "containment-close",
    ]);
    fake.unsubscribe();
  });

  test("adapts both coordinator phases onto one application host lease", async () => {
    const acquired: string[] = [];
    const schemas: unknown[] = [];
    let released = 0;
    const outputs = [
      JSON.stringify({ kind: "reads", reads: [] }),
      JSON.stringify({ markdown: "Nothing scheduled.", proposals: [] }),
    ];
    const host = {
      async acquireAttempt(attemptId: string) {
        acquired.push(attemptId);
        return {
          async startThread() {
            return "thread-1";
          },
          async runTurn(input: { outputSchema: unknown }) {
            schemas.push(input.outputSchema);
            return {
              finalText: outputs.shift()!,
              threadId: "thread-1",
              turnId: `turn-${schemas.length}`,
            };
          },
          async interrupt() {
            return {
              terminal: "semantically-interrupted" as const,
              milestones: ["semantically-interrupted"] as const,
            };
          },
          async release() {
            released += 1;
          },
        };
      },
    } as Pick<CodexAppServerHost, "acquireAttempt">;
    const plannerSchema = { title: "planner" };
    const finalizerSchema = { title: "finalizer" };
    const runner = createCodexAppServerHostPhaseRunner(host, {
      planner: plannerSchema,
      finalizer: finalizerSchema,
    });

    await runner.run({
      phase: "planner",
      attemptId: `${ATTEMPT_A}_planner`,
      prompt: "plan",
    });
    await runner.run({
      phase: "finalizer",
      attemptId: `${ATTEMPT_A}_finalizer`,
      prompt: "finish",
    });
    await runner.releaseAttempt?.(ATTEMPT_A);

    expect(acquired).toEqual([ATTEMPT_A]);
    expect(schemas).toEqual([plannerSchema, finalizerSchema]);
    expect(released).toBe(1);
  });

  test("refuses a finalizer without acquiring a second native thread", async () => {
    let acquired = false;
    const runner = createCodexAppServerHostPhaseRunner(
      {
        async acquireAttempt() {
          acquired = true;
          throw new Error("must not acquire");
        },
      },
      { planner: {}, finalizer: {} },
    );

    await expect(
      runner.run({
        phase: "finalizer",
        attemptId: `${ATTEMPT_A}_finalizer`,
        prompt: "finalize",
      }),
    ).rejects.toMatchObject({ code: "CODEX_PLANNER_REQUIRED" });
    expect(acquired).toBe(false);
  });

  test("keeps a Task-1-validated manual installation only for this process session", async () => {
    const manifest = await loadCodexManifest(
      resolve(import.meta.dir, "../resources/codex-provider-manifest.json"),
    );
    const entry = manifest.appServerCompatibility[0]!;
    const selected: string[] = [];
    const stat = {
      dev: 1,
      ino: 2,
      size: 3,
      mtimeMs: 4,
      mode: 0o755,
      isFile: () => true,
      isSymbolicLink: () => false,
    };
    const session = createCodexInstallationSelection({
      manifest,
      compatibilityDependencies: {
        canonicalize: async (path) => path,
        lstat: async () => stat,
        inspectArchitecture: async () => entry.format,
        hashFile: async () => entry.sha256,
        probeVersion: async () => ({
          stdout: entry.version,
          stderr: "",
          exitCode: 0,
        }),
        probeGeneratedSchema: async () => entry.generatedSchema.sha256,
      },
      onSelected: async (evidence) => {
        selected.push(evidence.executablePath);
        return { kind: "ready-degraded" };
      },
    });
    const path = "/Applications/Codex.app/Contents/MacOS/codex";
    await expect(session.validate(path)).resolves.toEqual({
      kind: "supported",
      status: { kind: "ready-degraded" },
    });
    expect(session.selectedEvidence()?.executablePath).toBe(path);
    expect(selected).toEqual([path]);
  });

  test("initializes one generation and serializes application attempts", async () => {
    const fake = fakeHost();
    const host = createCodexAppServerHost(fake.dependencies);
    expect(await host.status()).toEqual({ kind: "probing" });
    const first = await host.acquireAttempt(ATTEMPT_A);
    await expect(host.acquireAttempt(ATTEMPT_B)).rejects.toMatchObject({
      code: "CODEX_BUSY",
    });
    await first.release();
    const second = await host.acquireAttempt(ATTEMPT_B);
    await second.release();
    expect(fake.counts().initializeCalls).toBe(1);
    await host.close();
    fake.unsubscribe();
  });

  test("does not infer model or entitlement readiness from account/read", async () => {
    const fake = fakeHost({
      async probeReadiness() {
        return { kind: "ready-degraded" };
      },
    });
    const host = createCodexAppServerHost(fake.dependencies);
    expect(await host.status()).toEqual({ kind: "probing" });
    expect(await host.status()).toEqual({ kind: "ready-degraded" });
    fake.setAccount(null);
    fake.setIdentity("c".repeat(64));
    await expect(host.acquireAttempt(ATTEMPT_A)).rejects.toMatchObject({
      code: "CODEX_AUTHENTICATION_REQUIRED",
    });
    expect(await host.status()).toEqual({ kind: "authentication-required" });
    await host.close();
    fake.unsubscribe();
  });

  test("publishes device authorization only through the trusted login channel", async () => {
    const fake = fakeHost();
    fake.setAccount(null);
    const host = createCodexAppServerHost(fake.dependencies);
    await host.login(LOGIN_A, new AbortController().signal);
    expect(fake.events).toEqual([
      {
        attemptId: LOGIN_A,
        event: { kind: "progress", stage: "requesting-code" },
      },
      {
        attemptId: LOGIN_A,
        event: { kind: "challenge-url", url: "https://auth.openai.com/device" },
      },
      {
        attemptId: LOGIN_A,
        event: { kind: "challenge-code", code: "ABCD-EFGH" },
      },
      {
        attemptId: LOGIN_A,
        event: { kind: "status", status: { kind: "ready" } },
      },
    ]);
    await host.close();
    fake.unsubscribe();
  });

  test("publishes a safe terminal status when account refresh fails after the device code", async () => {
    const fake = fakeHost();
    fake.setAccount(null);
    const accountRead = fake.client.accountRead;
    let accountReads = 0;
    fake.client.accountRead = async () => {
      accountReads += 1;
      if (accountReads === 2) {
        throw Object.assign(new Error("account refresh timed out"), {
          code: "CODEX_ACCOUNT_READ_TIMEOUT",
        });
      }
      return accountRead();
    };
    const host = createCodexAppServerHost(fake.dependencies);

    await expect(
      host.login(LOGIN_A, new AbortController().signal),
    ).rejects.toMatchObject({ code: "CODEX_ACCOUNT_READ_TIMEOUT" });
    expect(fake.events).toEqual([
      {
        attemptId: LOGIN_A,
        event: { kind: "progress", stage: "requesting-code" },
      },
      {
        attemptId: LOGIN_A,
        event: { kind: "challenge-url", url: "https://auth.openai.com/device" },
      },
      {
        attemptId: LOGIN_A,
        event: { kind: "challenge-code", code: "ABCD-EFGH" },
      },
      {
        attemptId: LOGIN_A,
        event: { kind: "status", status: { kind: "probe-failed" } },
      },
    ]);

    await host.close();
    fake.unsubscribe();
  });

  test("keeps device login cancellation owned after publishing the challenge", async () => {
    let markCompletionStarted!: () => void;
    const completionStarted = new Promise<void>((resolve) => {
      markCompletionStarted = resolve;
    });
    const fake = fakeHost({
      waitForLoginCompletion: async (_client, input) => {
        markCompletionStarted();
        await new Promise<void>((_resolve, reject) => {
          input.signal.addEventListener(
            "abort",
            () =>
              reject(
                Object.assign(new Error("cancelled"), {
                  code: "CODEX_CANCELLED",
                }),
              ),
            { once: true },
          );
        });
      },
    });
    fake.setAccount(null);
    const host = createCodexAppServerHost(fake.dependencies);
    const login = host.login(LOGIN_A, new AbortController().signal);
    await completionStarted;

    await expect(host.cancel(LOGIN_A)).resolves.toBe(true);
    await expect(login).rejects.toMatchObject({ code: "CODEX_CANCELLED" });
    expect(
      fake.events.find((envelope: any) => envelope.event?.kind === "status"),
    ).toBeUndefined();

    await host.close();
    fake.unsubscribe();
  });

  test("keeps quota, model, entitlement, and authentication failures distinct", async () => {
    for (const [nativeCode, expectedCode] of [
      ["CODEX_NATIVE_QUOTA_EXCEEDED", "CODEX_QUOTA_EXCEEDED"],
      ["CODEX_NATIVE_MODEL_NOT_FOUND", "CODEX_MODEL_UNAVAILABLE"],
      ["CODEX_NATIVE_ENTITLEMENT_REQUIRED", "CODEX_ENTITLEMENT_REQUIRED"],
      ["CODEX_NATIVE_AUTHENTICATION_REQUIRED", "CODEX_AUTHENTICATION_REQUIRED"],
    ] as const) {
      const fake = fakeHost({
        async probeReadiness() {
          throw Object.assign(new Error(nativeCode), { code: nativeCode });
        },
      });
      const host = createCodexAppServerHost(fake.dependencies);
      await expect(host.acquireAttempt(ATTEMPT_A)).rejects.toMatchObject({
        code: expectedCode,
      });
      await host.close();
      fake.unsubscribe();
    }
  });

  test("invalidates a changed binary and initializes a fresh generation", async () => {
    const fake = fakeHost();
    const host = createCodexAppServerHost(fake.dependencies);
    const first = await host.acquireAttempt(ATTEMPT_A);
    await first.release();
    fake.setIdentity("d".repeat(64));
    const second = await host.acquireAttempt(ATTEMPT_B);
    await second.release();
    expect(fake.counts()).toMatchObject({ initializeCalls: 2, closeCalls: 1 });
    await host.close();
    fake.unsubscribe();
  });

  test("defers changed-binary invalidation until the active lease releases", async () => {
    const fake = fakeHost();
    const host = createCodexAppServerHost(fake.dependencies);
    expect(await host.status()).toEqual({ kind: "probing" });
    expect(await host.status()).toEqual({ kind: "ready" });
    const lease = await host.acquireAttempt(ATTEMPT_A);
    fake.setIdentity("e".repeat(64));

    await expect(host.status()).resolves.toEqual({ kind: "needs-reprobe" });
    expect(fake.counts()).toMatchObject({ initializeCalls: 1, closeCalls: 0 });

    await lease.release();
    expect(fake.counts().closeCalls).toBe(1);
    const next = await host.acquireAttempt(ATTEMPT_B);
    await next.release();
    expect(fake.counts().initializeCalls).toBe(2);
    await host.close();
    fake.unsubscribe();
  });

  test("shares one in-flight native thread start across lease callers", async () => {
    const fake = fakeHost();
    let threadStartCalls = 0;
    let releaseThreadStart!: () => void;
    const threadStartGate = new Promise<void>((resolve) => {
      releaseThreadStart = resolve;
    });
    fake.client.threadStart = async () => {
      threadStartCalls += 1;
      await threadStartGate;
      return { thread: { id: "thread-1" } };
    };
    const host = createCodexAppServerHost(fake.dependencies);
    const lease = await host.acquireAttempt(ATTEMPT_A);

    const explicitStart = lease.startThread();
    const turn = lease.runTurn({ text: "hello", outputSchema: {} });
    expect(threadStartCalls).toBe(1);
    releaseThreadStart();
    await expect(explicitStart).resolves.toBe("thread-1");
    await fake.turnStarted;
    fake.finishTurn();
    await expect(turn).resolves.toMatchObject({ threadId: "thread-1" });
    expect(threadStartCalls).toBe(1);

    await lease.release();
    await host.close();
    fake.unsubscribe();
  });

  test("pins Qali turns to Luna with high reasoning", async () => {
    const fake = fakeHost();
    const threadInputs: Record<string, unknown>[] = [];
    const turnInputs: Record<string, unknown>[] = [];
    const originalThreadStart = fake.client.threadStart;
    const originalTurnStart = fake.client.turnStart;
    fake.client.threadStart = async (input: Record<string, unknown>) => {
      threadInputs.push(input);
      return originalThreadStart();
    };
    fake.client.turnStart = async (input: Record<string, unknown>) => {
      turnInputs.push(input);
      return originalTurnStart();
    };
    const host = createCodexAppServerHost(fake.dependencies);
    const lease = await host.acquireAttempt(ATTEMPT_A);

    const turn = lease.runTurn({ text: "hello", outputSchema: {} });
    await fake.turnStarted;
    fake.finishTurn();
    await expect(turn).resolves.toMatchObject({ threadId: "thread-1" });
    expect(threadInputs).toEqual([
      expect.objectContaining({ model: "gpt-5.6-luna" }),
    ]);
    expect(turnInputs).toEqual([
      expect.objectContaining({
        model: "gpt-5.6-luna",
        effort: "high",
      }),
    ]);

    await lease.release();
    await host.close();
    fake.unsubscribe();
  });

  test("shutdown preserves a native completion that wins the interrupt race", async () => {
    const fake = fakeHost();
    const host = createCodexAppServerHost(fake.dependencies);
    const lease = await host.acquireAttempt(ATTEMPT_A);
    const turn = lease.runTurn({
      text: "hello",
      outputSchema: { type: "object" },
    });
    await fake.turnStarted;
    await host.close();
    await expect(turn).resolves.toMatchObject({ threadId: "thread-1" });
    expect(fake.counts()).toMatchObject({ interruptCalls: 1, closeCalls: 1 });
    fake.unsubscribe();
  });

  test("does not treat an interrupt acknowledgement as a cancelled semantic outcome", async () => {
    const scheduler = fakeDeadlineScheduler();
    const fake = fakeHost({ deadlineScheduler: scheduler });
    fake.client.turnInterrupt = async () => {
      // The native request is acknowledged but the server never emits a
      // semantic turn terminal notification.
    };
    const host = createCodexAppServerHost(fake.dependencies);
    const lease = await host.acquireAttempt(ATTEMPT_A);
    const turn = lease.runTurn({ text: "hello", outputSchema: {} });
    await fake.turnStarted;
    await flushMicrotasks();

    const interrupted = lease.interrupt();
    await flushMicrotasks();
    scheduler.advance(CODEX_DEADLINES.interruptGraceMs);

    await expect(interrupted).resolves.toEqual({
      terminal: "outcome-unknown",
      milestones: [
        "interrupt-sent",
        "interrupt-acknowledged",
        "outcome-unknown",
      ],
    });
    await expect(turn).rejects.toMatchObject({ code: "CODEX_OUTCOME_UNKNOWN" });
    expect(fake.counts()).toMatchObject({ closeCalls: 1, interruptCalls: 0 });
    fake.unsubscribe();
  });

  test("classifies a native semantic interruption separately from its acknowledgement", async () => {
    const fake = fakeHost();
    fake.client.turnInterrupt = async () => {
      fake.finishTurn("interrupted");
    };
    const host = createCodexAppServerHost(fake.dependencies);
    const lease = await host.acquireAttempt(ATTEMPT_A);
    const turn = lease.runTurn({ text: "hello", outputSchema: {} });
    await fake.turnStarted;
    await flushMicrotasks();

    await expect(lease.interrupt()).resolves.toEqual({
      terminal: "semantically-interrupted",
      milestones: [
        "interrupt-sent",
        "interrupt-acknowledged",
        "semantically-interrupted",
      ],
    });
    await expect(turn).rejects.toMatchObject({
      code: "CODEX_SEMANTIC_INTERRUPTED",
    });
    await host.close();
    fake.unsubscribe();
  });

  test("reports completed-before-interrupt without cancelling a completed attempt", async () => {
    const fake = fakeHost();
    const host = createCodexAppServerHost(fake.dependencies);
    const lease = await host.acquireAttempt(ATTEMPT_A);
    const turn = lease.runTurn({ text: "hello", outputSchema: {} });
    await fake.turnStarted;
    fake.finishTurn();
    await expect(turn).resolves.toMatchObject({ threadId: "thread-1" });

    await expect(lease.interrupt()).resolves.toEqual({
      terminal: "completed-before-interrupt",
      milestones: ["completed-before-interrupt"],
    });
    await lease.release();
    await host.close();
    fake.unsubscribe();
  });

  test("terminates only the owned generation when a model turn becomes outcome-unknown", async () => {
    const scheduler = fakeDeadlineScheduler();
    const fake = fakeHost({ deadlineScheduler: scheduler });
    const host = createCodexAppServerHost(fake.dependencies);
    const lease = await host.acquireAttempt(ATTEMPT_A);
    const turn = lease.runTurn({ text: "hello", outputSchema: {} });
    await fake.turnStarted;
    await flushMicrotasks();

    scheduler.advance(CODEX_DEADLINES.modelAbsoluteMs);
    await flushMicrotasks();

    expect(fake.counts().closeCalls).toBe(1);
    await expect(turn).rejects.toMatchObject({ code: "CODEX_OUTCOME_UNKNOWN" });
    await host.close();
    fake.unsubscribe();
  });

  test("replaces a generation closed for an unknown outcome before admitting another attempt", async () => {
    const scheduler = fakeDeadlineScheduler();
    const fake = fakeHost({ deadlineScheduler: scheduler });
    const host = createCodexAppServerHost(fake.dependencies);
    const first = await host.acquireAttempt(ATTEMPT_A);
    const turn = first.runTurn({ text: "hello", outputSchema: {} });
    await fake.turnStarted;
    await flushMicrotasks();
    scheduler.advance(CODEX_DEADLINES.modelAbsoluteMs);
    await expect(turn).rejects.toMatchObject({ code: "CODEX_OUTCOME_UNKNOWN" });
    await first.release();

    const second = await host.acquireAttempt(ATTEMPT_B);
    await second.release();
    expect(fake.counts().initializeCalls).toBe(2);
    await host.close();
    fake.unsubscribe();
  });

  test("maps an observed child crash after turn admission to outcome-unknown and recreates its generation", async () => {
    const fake = fakeHost();
    const host = createCodexAppServerHost(fake.dependencies);
    const first = await host.acquireAttempt(ATTEMPT_A);
    const turn = first.runTurn({ text: "hello", outputSchema: {} });
    await fake.turnStarted;
    fake.emitTermination();
    await expect(turn).rejects.toMatchObject({ code: "CODEX_OUTCOME_UNKNOWN" });
    await first.release();

    const second = await host.acquireAttempt(ATTEMPT_B);
    await second.release();
    expect(fake.counts()).toMatchObject({ closeCalls: 1, initializeCalls: 2 });
    await host.close();
    fake.unsubscribe();
  });

  test("records owned-process termination only when the captured child close is observed", async () => {
    const fake = fakeHost();
    fake.client.turnInterrupt = async () => {};
    const host = createCodexAppServerHost(fake.dependencies);
    const lease = await host.acquireAttempt(ATTEMPT_A);
    const turn = lease.runTurn({ text: "hello", outputSchema: {} });
    await fake.turnStarted;
    await flushMicrotasks();
    const milestones: string[] = [];
    const interrupted = lease.interrupt(async (milestone) => {
      milestones.push(milestone);
    });
    await flushMicrotasks();
    fake.emitTermination();

    await expect(interrupted).resolves.toEqual({
      terminal: "outcome-unknown",
      milestones: [
        "interrupt-sent",
        "interrupt-acknowledged",
        "owned-process-terminated",
        "outcome-unknown",
      ],
    });
    expect(milestones).toEqual([
      "interrupt-sent",
      "interrupt-acknowledged",
      "owned-process-terminated",
      "outcome-unknown",
    ]);
    await expect(turn).rejects.toMatchObject({ code: "CODEX_OUTCOME_UNKNOWN" });
    fake.unsubscribe();
  });

  test("settles outcome-unknown even when terminating the owned generation fails", async () => {
    const scheduler = fakeDeadlineScheduler();
    const fake = fakeHost({ deadlineScheduler: scheduler });
    fake.client.turnInterrupt = async () => {};
    fake.client.close = async () => {
      throw new Error("close failed");
    };
    const host = createCodexAppServerHost(fake.dependencies);
    const lease = await host.acquireAttempt(ATTEMPT_A);
    const turn = lease.runTurn({ text: "hello", outputSchema: {} });
    await fake.turnStarted;
    await flushMicrotasks();

    const interrupted = lease.interrupt();
    await flushMicrotasks();
    scheduler.advance(CODEX_DEADLINES.interruptGraceMs);
    await expect(interrupted).resolves.toMatchObject({
      terminal: "outcome-unknown",
    });
    await expect(turn).rejects.toMatchObject({ code: "CODEX_OUTCOME_UNKNOWN" });
    fake.unsubscribe();
  });

  test("ignores notifications for another native thread or turn", async () => {
    const fake = fakeHost();
    const host = createCodexAppServerHost(fake.dependencies);
    const lease = await host.acquireAttempt(ATTEMPT_A);
    const turn = lease.runTurn({ text: "hello", outputSchema: {} });
    await fake.turnStarted;
    await Promise.resolve();

    fake.emit({
      method: "turn/completed",
      params: {
        threadId: "other-thread",
        turn: { id: "other-turn", status: "completed" },
      },
    });
    await Promise.resolve();
    expect(fake.listenerCount()).toBe(1);
    fake.finishTurn();
    await expect(turn).resolves.toMatchObject({ turnId: "turn-1" });
    await lease.release();
    await host.close();
    fake.unsubscribe();
  });

  test("removes the native subscription when turn admission fails", async () => {
    const fake = fakeHost();
    fake.client.turnStart = async () => {
      throw Object.assign(new Error("rejected"), {
        code: "CODEX_NATIVE_REJECTED",
      });
    };
    const host = createCodexAppServerHost(fake.dependencies);
    const lease = await host.acquireAttempt(ATTEMPT_A);
    await expect(
      lease.runTurn({ text: "hello", outputSchema: {} }),
    ).rejects.toMatchObject({
      code: "CODEX_NATIVE_REJECTED",
    });
    expect(fake.listenerCount()).toBe(0);
    await lease.release();
    await host.close();
    fake.unsubscribe();
  });

  test("shutdown joins an in-flight probe without leaking a late generation", async () => {
    const fake = fakeHost();
    const resolveInstallation = fake.dependencies.resolveInstallation;
    let releaseProbe!: () => void;
    const probeGate = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    const host = createCodexAppServerHost({
      ...fake.dependencies,
      async resolveInstallation() {
        await probeGate;
        return resolveInstallation();
      },
    });
    expect(await host.status()).toEqual({ kind: "probing" });
    let closed = false;
    const close = host.close().then(() => {
      closed = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closed).toBe(false);
    releaseProbe();
    await close;
    expect(fake.counts().initializeCalls).toBe(fake.counts().closeCalls);
    fake.unsubscribe();
  });

  test("bounds spawn, readiness, and owned shutdown with the injected clock", async () => {
    const spawnScheduler = fakeDeadlineScheduler();
    const spawnFake = fakeHost({ deadlineScheduler: spawnScheduler });
    spawnFake.dependencies.createClient = async () =>
      await new Promise<never>(() => {});
    const spawnHost = createCodexAppServerHost(spawnFake.dependencies);
    const spawn = spawnHost.acquireAttempt(ATTEMPT_A);
    await flushMicrotasks();
    spawnScheduler.advance(CODEX_DEADLINES.spawnMs);
    await expect(spawn).rejects.toMatchObject({
      code: "CODEX_SPAWN_TIMED_OUT",
    });
    spawnFake.unsubscribe();

    const probeScheduler = fakeDeadlineScheduler();
    const probeFake = fakeHost({
      deadlineScheduler: probeScheduler,
      async probeReadiness() {
        return await new Promise<never>(() => {});
      },
    });
    const probeHost = createCodexAppServerHost(probeFake.dependencies);
    const probe = probeHost.acquireAttempt(ATTEMPT_A);
    await flushMicrotasks();
    probeScheduler.advance(CODEX_DEADLINES.accountMs);
    await expect(probe).rejects.toMatchObject({
      code: "CODEX_PROBE_TIMED_OUT",
    });
    probeFake.unsubscribe();

    const shutdownScheduler = fakeDeadlineScheduler();
    const shutdownFake = fakeHost({ deadlineScheduler: shutdownScheduler });
    shutdownFake.client.close = async () => await new Promise<never>(() => {});
    const shutdownHost = createCodexAppServerHost(shutdownFake.dependencies);
    const lease = await shutdownHost.acquireAttempt(ATTEMPT_A);
    await lease.release();
    const close = shutdownHost.close();
    await flushMicrotasks();
    shutdownScheduler.advance(CODEX_DEADLINES.shutdownMs);
    await expect(close).resolves.toBeUndefined();
    shutdownFake.unsubscribe();
  });

  test("bounds installation resolution before any client generation is created", async () => {
    const scheduler = fakeDeadlineScheduler();
    const fake = fakeHost({ deadlineScheduler: scheduler });
    fake.dependencies.resolveInstallation = async () =>
      await new Promise<never>(() => {});
    const host = createCodexAppServerHost(fake.dependencies);

    const acquisition = host.acquireAttempt(ATTEMPT_A);
    await flushMicrotasks();
    scheduler.advance(CODEX_DEADLINES.spawnMs);

    await expect(acquisition).rejects.toMatchObject({
      code: "CODEX_RESOLVE_TIMED_OUT",
    });
    expect(fake.counts()).toMatchObject({ initializeCalls: 0, closeCalls: 0 });
    fake.unsubscribe();
  });

  test("bounds cleanup after initialization times out", async () => {
    const scheduler = fakeDeadlineScheduler();
    const fake = fakeHost({ deadlineScheduler: scheduler });
    fake.client.initialize = async () => await new Promise<never>(() => {});
    fake.client.close = async () => await new Promise<never>(() => {});
    const host = createCodexAppServerHost(fake.dependencies);

    const acquisition = host.acquireAttempt(ATTEMPT_A);
    await flushMicrotasks();
    scheduler.advance(CODEX_DEADLINES.initializeMs);
    await flushMicrotasks();
    scheduler.advance(CODEX_DEADLINES.shutdownMs);

    await expect(acquisition).rejects.toMatchObject({
      code: "CODEX_INITIALIZE_TIMED_OUT",
    });
    fake.unsubscribe();
  });

  test("quarantines a generation when the turn-start acknowledgement is lost", async () => {
    const scheduler = fakeDeadlineScheduler();
    const fake = fakeHost({ deadlineScheduler: scheduler });
    let turnStartCalls = 0;
    fake.client.turnStart = async () => {
      turnStartCalls += 1;
      return await new Promise<never>(() => {});
    };
    const host = createCodexAppServerHost(fake.dependencies);
    const first = await host.acquireAttempt(ATTEMPT_A);

    const turn = first.runTurn({ text: "hello", outputSchema: {} });
    await flushMicrotasks();
    scheduler.advance(CODEX_DEADLINES.turnAckMs);

    await expect(turn).rejects.toMatchObject({ code: "CODEX_OUTCOME_UNKNOWN" });
    await first.release();
    const second = await host.acquireAttempt(ATTEMPT_B);
    await second.release();
    expect(turnStartCalls).toBe(1);
    expect(fake.counts()).toMatchObject({ closeCalls: 1, initializeCalls: 2 });
    await host.close();
    fake.unsubscribe();
  });

  test("classifies cancellation during uncertain turn admission as outcome-unknown", async () => {
    const fake = fakeHost();
    let admitTurn!: (value: { turn: { id: string } }) => void;
    fake.client.turnStart = async () =>
      await new Promise<{ turn: { id: string } }>((resolve) => {
        admitTurn = resolve;
      });
    const host = createCodexAppServerHost(fake.dependencies);
    const lease = await host.acquireAttempt(ATTEMPT_A);
    const turn = lease.runTurn({ text: "hello", outputSchema: {} });
    await flushMicrotasks();

    await expect(lease.interrupt()).resolves.toMatchObject({
      terminal: "outcome-unknown",
      milestones: ["outcome-unknown"],
    });
    await expect(turn).rejects.toMatchObject({ code: "CODEX_OUTCOME_UNKNOWN" });

    // A late acknowledgement belongs to the quarantined generation and must
    // be observed without reviving it or producing an unhandled rejection.
    admitTurn({ turn: { id: "late-turn" } });
    await flushMicrotasks();
    await lease.release();
    const next = await host.acquireAttempt(ATTEMPT_B);
    await next.release();
    expect(fake.counts()).toMatchObject({ closeCalls: 1, initializeCalls: 2 });
    await host.close();
    fake.unsubscribe();
  });

  test("correlates a second turn whose completion arrives before its acknowledgement", async () => {
    const scheduler = fakeDeadlineScheduler();
    const fake = fakeHost({ deadlineScheduler: scheduler });
    let turnStartCalls = 0;
    let admitSecond!: (value: { turn: { id: string } }) => void;
    fake.client.turnStart = async () => {
      turnStartCalls += 1;
      if (turnStartCalls === 1) return { turn: { id: "turn-1" } };
      return await new Promise<{ turn: { id: string } }>((resolve) => {
        admitSecond = resolve;
      });
    };
    const host = createCodexAppServerHost(fake.dependencies);
    const lease = await host.acquireAttempt(ATTEMPT_A);

    const first = lease.runTurn({ text: "plan", outputSchema: {} });
    await flushMicrotasks();
    fake.emit({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { type: "agentMessage", text: "planned" },
      },
    });
    fake.emit({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "completed" },
      },
    });
    await expect(first).resolves.toMatchObject({
      finalText: "planned",
      turnId: "turn-1",
    });

    const second = lease.runTurn({ text: "finalize", outputSchema: {} });
    await flushMicrotasks();
    fake.emit({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-2",
        item: { type: "agentMessage", text: "finalized" },
      },
    });
    fake.emit({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { id: "turn-2", status: "completed" },
      },
    });
    admitSecond({ turn: { id: "turn-2" } });
    await flushMicrotasks();
    scheduler.advance(CODEX_DEADLINES.modelAbsoluteMs);

    await expect(second).resolves.toMatchObject({
      finalText: "finalized",
      turnId: "turn-2",
    });
    await lease.release();
    await host.close();
    fake.unsubscribe();
  });

  test("does not interrupt the completed first turn while the second acknowledgement is pending", async () => {
    const scheduler = fakeDeadlineScheduler();
    const fake = fakeHost({ deadlineScheduler: scheduler });
    let turnStartCalls = 0;
    let admitSecond!: (value: { turn: { id: string } }) => void;
    const interruptedTurns: Array<{ threadId: string; turnId: string }> = [];
    fake.client.turnStart = async () => {
      turnStartCalls += 1;
      if (turnStartCalls === 1) return { turn: { id: "turn-1" } };
      return await new Promise<{ turn: { id: string } }>((resolve) => {
        admitSecond = resolve;
      });
    };
    fake.client.turnInterrupt = async (input) => {
      interruptedTurns.push(input);
    };
    const host = createCodexAppServerHost(fake.dependencies);
    const lease = await host.acquireAttempt(ATTEMPT_A);

    const first = lease.runTurn({ text: "plan", outputSchema: {} });
    await flushMicrotasks();
    fake.emit({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { type: "agentMessage", text: "planned" },
      },
    });
    fake.emit({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "completed" },
      },
    });
    await expect(first).resolves.toMatchObject({ turnId: "turn-1" });

    const second = lease.runTurn({ text: "finalize", outputSchema: {} });
    await flushMicrotasks();
    const cancellation = lease.interrupt();
    await flushMicrotasks();
    scheduler.advance(CODEX_DEADLINES.interruptGraceMs);
    await expect(cancellation).resolves.toEqual({
      terminal: "outcome-unknown",
      milestones: ["outcome-unknown"],
    });
    admitSecond({ turn: { id: "turn-2" } });
    await expect(second).rejects.toMatchObject({
      code: "CODEX_OUTCOME_UNKNOWN",
    });
    expect(interruptedTurns).toEqual([]);
    await lease.release();
    await host.close();
    fake.unsubscribe();
  });
});
