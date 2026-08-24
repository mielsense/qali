import { describe, expect, test } from "bun:test";

import {
  AssistantCoordinator,
  createProductionCodexPhaseRunner,
  type AssistantAttemptContext,
  type AssistantBroker,
  type CodexPhaseRunner,
} from "../src/main/codex/coordinator";
import { createCodexCalendarAssistantAdapter } from "../src/main/codex/calendar-assistant-adapter";
import type {
  CalendarRead,
  CalendarReadBatch,
  CalendarReader,
  FinalizerOutputValue,
} from "../src/main/codex/schemas";

const ASSISTANT_1 = `assistant_${"1".repeat(32)}`;
const ASSISTANT_2 = `assistant_${"2".repeat(32)}`;
const ASSISTANT_3 = `assistant_${"3".repeat(32)}`;
const ASSISTANT_4 = `assistant_${"4".repeat(32)}`;
const ASSISTANT_5 = `assistant_${"5".repeat(32)}`;
const ASSISTANT_6 = `assistant_${"6".repeat(32)}`;
const ASSISTANT_7 = `assistant_${"7".repeat(32)}`;
const ASSISTANT_8 = `assistant_${"8".repeat(32)}`;
const ASSISTANT_9 = `assistant_${"9".repeat(32)}`;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class MemoryBroker implements AssistantBroker {
  readonly trace: string[] = [];
  readonly progress: string[] = [];
  readonly settlements: Array<{ kind: string; value?: unknown }> = [];
  readonly settled = deferred<void>();
  readonly context: AssistantAttemptContext = {
    conversationId: "conversation-1",
    userMessageId: "user-message-1",
    assistantMessageId: "assistant-message-1",
    selectedCalendarIds: ["primary"],
    summary: [{ role: "assistant", text: "Earlier answer" }],
  };

  async beginAttempt(): Promise<AssistantAttemptContext> {
    this.trace.push("persisted");
    return this.context;
  }

  async recordProgress(_attemptId: string, state: string): Promise<void> {
    this.progress.push(state);
  }

  async settleClarification(
    _attemptId: string,
    question: string,
  ): Promise<void> {
    this.settlements.push({ kind: "clarification", value: question });
    this.settled.resolve();
  }

  async settleSuccess(
    _attemptId: string,
    value: FinalizerOutputValue,
  ): Promise<void> {
    this.settlements.push({ kind: "success", value });
    this.settled.resolve();
  }

  async settleFailure(
    _attemptId: string,
    failure: { code: string },
  ): Promise<void> {
    this.settlements.push({ kind: "failure", value: failure });
    this.settled.resolve();
  }

  async requestCancellation(): Promise<void> {
    this.trace.push("cancel-requested");
  }

  async recordEvent(input: {
    eventId: string;
    event: { kind: "cancel"; milestone: string };
  }): Promise<void> {
    this.trace.push(`${input.eventId}:${input.event.milestone}`);
  }
}

class MemoryReader implements CalendarReader {
  readonly reads: CalendarRead[] = [];

  async execute(reads: readonly CalendarRead[]): Promise<CalendarReadBatch> {
    this.reads.push(...reads);
    return {
      rows: [
        {
          readIndex: 0,
          kind: "searchEvents",
          items: [
            {
              eventId: "event-1",
              calendarId: "primary",
              summary: "Lunch",
              startMs: 100,
              endMs: 200,
              allDay: false,
              updatedAt: 7,
            },
          ],
        },
      ],
    };
  }
}

class ScriptedRunner implements CodexPhaseRunner {
  readonly trace: string[];
  readonly prompts: Array<{ phase: string; prompt: string }> = [];
  readonly cancelled: string[] = [];
  private readonly outputs: string[];

  constructor(outputs: unknown[], trace: string[] = []) {
    this.outputs = outputs.map((value) =>
      typeof value === "string" ? value : JSON.stringify(value),
    );
    this.trace = trace;
  }

  async run(request: { phase: string; attemptId: string; prompt: string }) {
    this.trace.push(`run:${request.phase}`);
    this.prompts.push({ phase: request.phase, prompt: request.prompt });
    const finalText = this.outputs.shift();
    if (finalText === undefined) throw new Error("script exhausted");
    return { finalText };
  }

  async cancel(attemptId: string): Promise<void> {
    this.cancelled.push(attemptId);
  }
}

describe("two-phase assistant coordinator", () => {
  test("drain cancels and awaits every active assistant attempt", async () => {
    const broker = new MemoryBroker();
    const running = deferred<{ finalText: string }>();
    const cancelled: string[] = [];
    const coordinator = new AssistantCoordinator({
      broker,
      calendarReader: new MemoryReader(),
      createAttemptId: () => ASSISTANT_9,
      phaseRunner: {
        run: () => running.promise,
        async cancel(attemptId) {
          cancelled.push(attemptId);
          running.reject(Object.assign(new Error("cancelled"), { code: "CODEX_CANCELLED" }));
        },
      },
    });
    await coordinator.send({ text: "What is next?", timeZone: "Europe/Paris" });
    await Promise.resolve();

    await coordinator.drain();

    expect(cancelled).toEqual([`${ASSISTANT_9}_planner`]);
    expect(broker.trace).toContain("cancel-requested");
    expect(broker.settlements).toEqual([
      { kind: "failure", value: expect.objectContaining({ code: "cancelled" }) },
    ]);
  });

  test("rejects a login-namespace attempt before the broker boundary", async () => {
    const broker = new MemoryBroker();
    const coordinator = new AssistantCoordinator({
      broker,
      calendarReader: new MemoryReader(),
      phaseRunner: new ScriptedRunner([]),
      createAttemptId: () => `login_${"a".repeat(32)}`,
    });

    await expect(coordinator.send({
      text: "What is next?",
      timeZone: "Europe/Paris",
    })).resolves.toEqual({ kind: "rejected", reason: "unavailable" });
    expect(broker.trace).toEqual([]);
  });

  test("persists the user message and attempt before planner launch", async () => {
    const broker = new MemoryBroker();
    const runner = new ScriptedRunner(
      [
        { kind: "reads", reads: [] },
        { markdown: "Nothing scheduled.", proposals: [] },
      ],
      broker.trace,
    );
    const coordinator = new AssistantCoordinator({
      broker,
      calendarReader: new MemoryReader(),
      phaseRunner: runner,
      now: () => 1_700_000_000_000,
      createAttemptId: () => ASSISTANT_1,
    });

    expect(
      await coordinator.send({
        text: "What is next?",
        timeZone: "Europe/Paris",
      }),
    ).toEqual({ kind: "accepted", attemptId: ASSISTANT_1 });
    await broker.settled.promise;
    expect(broker.trace.slice(0, 2)).toEqual(["persisted", "run:planner"]);
  });

  test("releases one provider application lease after both phases settle", async () => {
    const broker = new MemoryBroker();
    const released: string[] = [];
    const scripted = new ScriptedRunner([
      { kind: "reads", reads: [] },
      { markdown: "Nothing scheduled.", proposals: [] },
    ]);
    const phaseRunner: CodexPhaseRunner = Object.assign(scripted, {
      async releaseAttempt(attemptId: string) {
        released.push(attemptId);
      },
    });
    const coordinator = new AssistantCoordinator({
      broker,
      calendarReader: new MemoryReader(),
      createAttemptId: () => ASSISTANT_1,
      phaseRunner,
    });

    await coordinator.send({ text: "What is next?", timeZone: "Europe/Paris" });
    await broker.settled.promise;
    await coordinator.drain();

    expect(released).toEqual([ASSISTANT_1]);
  });

  test("runs validated local reads between isolated planner and finalizer phases", async () => {
    const broker = new MemoryBroker();
    const reader = new MemoryReader();
    const runner = new ScriptedRunner([
      {
        kind: "reads",
        reads: [
          {
            kind: "searchEvents",
            calendarIds: ["primary"],
            startMs: 0,
            endMs: 1_000,
            limit: 10,
          },
        ],
      },
      { markdown: "Lunch is next.", proposals: [] },
    ]);
    const coordinator = new AssistantCoordinator({
      broker,
      calendarReader: reader,
      phaseRunner: runner,
      now: () => 500,
      createAttemptId: () => ASSISTANT_2,
    });

    await coordinator.send({ text: "What is next?", timeZone: "Europe/Paris" });
    await broker.settled.promise;

    expect(reader.reads).toHaveLength(1);
    expect(runner.prompts).toHaveLength(2);
    expect(runner.prompts[0]!.prompt).not.toContain("Lunch");
    expect(runner.prompts[0]!.prompt).toContain('"kind":"listCalendars"');
    expect(runner.prompts[0]!.prompt).toContain('"kind":"getAvailability"');
    expect(runner.prompts[1]!.prompt).toContain("Lunch");
    expect(runner.prompts[1]!.prompt).toContain('"kind":"create"');
    expect(runner.prompts[1]!.prompt).toContain('"expectedUpdatedAt"');
    expect(runner.prompts[1]!.prompt).not.toMatch(
      /refreshToken|adminKey|toolDefinitions/i,
    );
    expect(broker.settlements).toEqual([
      {
        kind: "success",
        value: { markdown: "Lunch is next.", proposals: [] },
      },
    ]);
  });

  test("settles one clarification without running reads or finalizer", async () => {
    const broker = new MemoryBroker();
    const reader = new MemoryReader();
    const runner = new ScriptedRunner([
      { kind: "clarification", question: "Which calendar should I use?" },
    ]);
    const coordinator = new AssistantCoordinator({
      broker,
      calendarReader: reader,
      phaseRunner: runner,
      now: () => 500,
      createAttemptId: () => ASSISTANT_3,
    });

    await coordinator.send({ text: "Move it", timeZone: "Europe/Paris" });
    await broker.settled.promise;
    expect(reader.reads).toEqual([]);
    expect(runner.prompts).toHaveLength(1);
    expect(broker.settlements[0]).toEqual({
      kind: "clarification",
      value: "Which calendar should I use?",
    });
  });

  test("malformed output settles a typed schema failure exactly once", async () => {
    const broker = new MemoryBroker();
    const runner = new ScriptedRunner(["not-json"]);
    const coordinator = new AssistantCoordinator({
      broker,
      calendarReader: new MemoryReader(),
      phaseRunner: runner,
      now: () => 500,
      createAttemptId: () => ASSISTANT_4,
    });

    await coordinator.send({ text: "What is next?", timeZone: "Europe/Paris" });
    await broker.settled.promise;
    expect(broker.settlements).toHaveLength(1);
    expect(broker.settlements[0]).toMatchObject({
      kind: "failure",
      value: { code: "schema-failure" },
    });
  });

  test("settles a denied native server request as a safe typed provider failure", async () => {
    const broker = new MemoryBroker();
    const coordinator = new AssistantCoordinator({
      broker,
      calendarReader: new MemoryReader(),
      phaseRunner: {
        async run() {
          throw Object.assign(new Error("native approval payload"), {
            code: "CODEX_SERVER_REQUEST_UNSUPPORTED",
          });
        },
        async cancel() {},
      },
      now: () => 500,
      createAttemptId: () => ASSISTANT_6,
    });

    await coordinator.send({ text: "What is next?", timeZone: "Europe/Paris" });
    await broker.settled.promise;

    expect(broker.settlements).toEqual([
      {
        kind: "failure",
        value: {
          code: "process-failure",
          message: "The assistant requested an unsupported provider action.",
        },
      },
    ]);
  });

  test("cancellation is persisted before stopping only the captured phase and drains it", async () => {
    const broker = new MemoryBroker();
    const planner = deferred<{ finalText: string }>();
    const runner: CodexPhaseRunner = {
      run: async () => planner.promise,
      cancel: async (attemptId) => {
        expect(broker.trace.at(-1)).toBe("cancel-requested");
        expect(attemptId).toBe(`${ASSISTANT_5}_planner`);
        planner.reject(
          Object.assign(new Error("cancelled"), { code: "CODEX_CANCELLED" }),
        );
      },
    };
    const coordinator = new AssistantCoordinator({
      broker,
      calendarReader: new MemoryReader(),
      phaseRunner: runner,
      now: () => 500,
      createAttemptId: () => ASSISTANT_5,
    });

    await coordinator.send({ text: "What is next?", timeZone: "Europe/Paris" });
    await coordinator.cancel(ASSISTANT_5);
    expect(broker.trace).toContain("cancel-requested");
    expect(broker.settlements).toEqual([
      {
        kind: "failure",
        value: expect.objectContaining({ code: "cancelled" }),
      },
    ]);
  });

  test("cancellation during an application-owned read does not target a completed phase", async () => {
    const broker = new MemoryBroker();
    const readStarted = deferred<void>();
    const readResult = deferred<CalendarReadBatch>();
    const cancelled: string[] = [];
    const coordinator = new AssistantCoordinator({
      broker,
      calendarReader: {
        execute: async () => {
          readStarted.resolve();
          return readResult.promise;
        },
      },
      phaseRunner: {
        run: async () => ({
          finalText: JSON.stringify({
            kind: "reads",
            reads: [
              {
                kind: "searchEvents",
                startMs: 0,
                endMs: 1_000,
                limit: 1,
              },
            ],
          }),
        }),
        cancel: async (attemptId) => {
          cancelled.push(attemptId);
        },
      },
      now: () => 500,
      createAttemptId: () => ASSISTANT_7,
    });

    await coordinator.send({ text: "What is next?", timeZone: "Europe/Paris" });
    await readStarted.promise;
    const cancellation = coordinator.cancel(ASSISTANT_7);
    await Promise.resolve();
    expect(cancelled).toEqual([]);
    readResult.resolve({ rows: [] });
    await cancellation;
    expect(broker.settlements).toEqual([
      {
        kind: "failure",
        value: expect.objectContaining({ code: "cancelled" }),
      },
    ]);
  });

  test("cancellation during native thread startup settles without starting either native turn", async () => {
    const broker = new MemoryBroker();
    const threadStartStarted = deferred<void>();
    const allowThreadStart = deferred<void>();
    let nativeTurnStarts = 0;
    let nativeReleases = 0;
    const adapter = createCodexCalendarAssistantAdapter(
      {
        async acquireAttempt() {
          return {
            async startThread() {
              threadStartStarted.resolve();
              await allowThreadStart.promise;
              return "native-thread-1";
            },
            async runTurn() {
              nativeTurnStarts += 1;
              return {
                finalText: JSON.stringify({ kind: "reads", reads: [] }),
                threadId: "native-thread-1",
                turnId: "native-turn-1",
              };
            },
            async interrupt() {
              return {
                terminal: "semantically-interrupted" as const,
                milestones: ["semantically-interrupted"] as const,
              };
            },
            async release() {
              nativeReleases += 1;
            },
          };
        },
      },
      { planner: {}, finalizer: {} },
    );
    const coordinator = new AssistantCoordinator({
      broker,
      calendarReader: new MemoryReader(),
      phaseRunner: adapter,
      now: () => 500,
      createAttemptId: () => ASSISTANT_1,
    });

    await coordinator.send({ text: "What is next?", timeZone: "Europe/Paris" });
    await threadStartStarted.promise;
    const cancellation = coordinator.cancel(ASSISTANT_1);
    allowThreadStart.resolve();
    await cancellation;

    expect(nativeTurnStarts).toBe(0);
    expect(nativeReleases).toBe(1);
    expect(broker.settlements).toEqual([
      {
        kind: "failure",
        value: expect.objectContaining({ code: "cancelled" }),
      },
    ]);
  });

  test("cancellation wins from request start while durable cancellation is pending", async () => {
    const broker = new MemoryBroker();
    const cancellationStarted = deferred<void>();
    const cancellationStored = deferred<void>();
    broker.requestCancellation = async () => {
      cancellationStarted.resolve();
      await cancellationStored.promise;
    };
    const planner = deferred<{ finalText: string }>();
    const runner: CodexPhaseRunner = {
      run: async () => planner.promise,
      cancel: async () => {},
    };
    const coordinator = new AssistantCoordinator({
      broker,
      calendarReader: new MemoryReader(),
      phaseRunner: runner,
      now: () => 500,
      createAttemptId: () => ASSISTANT_8,
    });

    await coordinator.send({ text: "Move it", timeZone: "Europe/Paris" });
    const cancellation = coordinator.cancel(ASSISTANT_8);
    await cancellationStarted.promise;
    planner.resolve({
      finalText: JSON.stringify({
        kind: "clarification",
        question: "Which event?",
      }),
    });
    await Promise.resolve();
    cancellationStored.resolve();
    await cancellation;

    expect(broker.settlements).toEqual([
      {
        kind: "failure",
        value: expect.objectContaining({ code: "cancelled" }),
      },
    ]);
  });

  test("persists the cancellation request before native interrupt and does not duplicate milestones", async () => {
    const broker = new MemoryBroker();
    const planner = deferred<{ finalText: string }>();
    let nativeCancels = 0;
    const coordinator = new AssistantCoordinator({
      broker,
      calendarReader: new MemoryReader(),
      createAttemptId: () => ASSISTANT_9,
      phaseRunner: {
        run: () => planner.promise,
        async cancel(_attemptId, report) {
          await report?.("interrupt-sent");
          expect(broker.trace.at(-1)).toBe(
            "event:cancel-interrupt-sent:interrupt_sent",
          );
          nativeCancels += 1;
          planner.reject(
            Object.assign(new Error("unknown"), {
              code: "CODEX_OUTCOME_UNKNOWN",
            }),
          );
          await report?.("interrupt-acknowledged");
          return {
            terminal: "outcome-unknown" as const,
            milestones: [
              "interrupt-sent",
              "interrupt-acknowledged",
              "owned-process-terminated",
              "outcome-unknown",
            ] as const,
          };
        },
      },
    });

    await coordinator.send({ text: "What is next?", timeZone: "Europe/Paris" });
    await Promise.resolve();
    await Promise.all([
      coordinator.cancel(ASSISTANT_9),
      coordinator.cancel(ASSISTANT_9),
    ]);

    expect(nativeCancels).toBe(1);
    expect(broker.trace).toEqual([
      "persisted",
      "cancel-requested",
      "event:cancel-interrupt-sent:interrupt_sent",
      "event:cancel-interrupt-acknowledged:interrupt_acknowledged",
      "event:cancel-owned-process-terminated:owned_process_terminated",
      "event:cancel-outcome-unknown:outcome_unknown",
    ]);
    expect(broker.settlements).toEqual([
      {
        kind: "failure",
        value: expect.objectContaining({ code: "outcome-unknown" }),
      },
    ]);
  });

  test("continues cancellation and settles even if a milestone fan-out fails", async () => {
    const broker = new MemoryBroker();
    broker.recordEvent = async () => {
      throw new Error("event store unavailable");
    };
    const planner = deferred<{ finalText: string }>();
    let nativeCancels = 0;
    const coordinator = new AssistantCoordinator({
      broker,
      calendarReader: new MemoryReader(),
      createAttemptId: () => ASSISTANT_7,
      phaseRunner: {
        run: () => planner.promise,
        async cancel(_attemptId, report) {
          await report?.("interrupt-sent");
          nativeCancels += 1;
          planner.reject(Object.assign(new Error("cancelled"), {
            code: "CODEX_CANCELLED",
          }));
          return {
            terminal: "semantically-interrupted" as const,
            milestones: ["interrupt-sent", "semantically-interrupted"] as const,
          };
        },
      },
    });

    await coordinator.send({ text: "Move it", timeZone: "Europe/Paris" });
    await expect(coordinator.cancel(ASSISTANT_7)).resolves.toBeUndefined();
    expect(nativeCancels).toBe(1);
    expect(broker.settlements).toEqual([
      { kind: "failure", value: expect.objectContaining({ code: "cancelled" }) },
    ]);
  });

  test("does not settle a planner completion that wins the interrupt race", async () => {
    const broker = new MemoryBroker();
    const planner = deferred<{ finalText: string }>();
    const coordinator = new AssistantCoordinator({
      broker,
      calendarReader: new MemoryReader(),
      createAttemptId: () => ASSISTANT_8,
      phaseRunner: {
        run: () => planner.promise,
        async cancel() {
          planner.resolve({
            finalText: JSON.stringify({
              kind: "clarification",
              question: "Which event?",
            }),
          });
          return {
            terminal: "completed-before-interrupt" as const,
            milestones: ["completed-before-interrupt"] as const,
          };
        },
      },
    });

    await coordinator.send({ text: "Move it", timeZone: "Europe/Paris" });
    await coordinator.cancel(ASSISTANT_8);

    expect(broker.settlements).toEqual([
      { kind: "failure", value: expect.objectContaining({ code: "cancelled" }) },
    ]);
  });

  test("does not run calendar reads after cancellation wins during planner completion", async () => {
    const broker = new MemoryBroker();
    const planner = deferred<{ finalText: string }>();
    const reader = new MemoryReader();
    const coordinator = new AssistantCoordinator({
      broker,
      calendarReader: reader,
      createAttemptId: () => ASSISTANT_7,
      phaseRunner: {
        run: () => planner.promise,
        async cancel() {
          planner.resolve({
            finalText: JSON.stringify({ kind: "reads", reads: [] }),
          });
          return {
            terminal: "completed-before-interrupt" as const,
            milestones: ["completed-before-interrupt"] as const,
          };
        },
      },
    });

    await coordinator.send({ text: "Move it", timeZone: "Europe/Paris" });
    await coordinator.cancel(ASSISTANT_7);

    expect(reader.reads).toEqual([]);
    expect(broker.settlements).toEqual([
      { kind: "failure", value: expect.objectContaining({ code: "cancelled" }) },
    ]);
  });

  test("settles a finalizer completion that won the interrupt race", async () => {
    const broker = new MemoryBroker();
    const finalizerStarted = deferred<void>();
    const finalizer = deferred<{ finalText: string }>();
    const coordinator = new AssistantCoordinator({
      broker,
      calendarReader: new MemoryReader(),
      createAttemptId: () => ASSISTANT_6,
      phaseRunner: {
        async run(request) {
          if (request.phase === "planner") {
            return { finalText: JSON.stringify({ kind: "reads", reads: [] }) };
          }
          finalizerStarted.resolve();
          return finalizer.promise;
        },
        async cancel(_attemptId, report) {
          await report?.("completed-before-interrupt");
          finalizer.resolve({
            finalText: JSON.stringify({
              markdown: "The finalizer was already done.",
              proposals: [],
            }),
          });
          return {
            terminal: "completed-before-interrupt" as const,
            milestones: ["completed-before-interrupt"] as const,
          };
        },
      },
    });

    await coordinator.send({ text: "Move it", timeZone: "Europe/Paris" });
    await finalizerStarted.promise;
    await coordinator.cancel(ASSISTANT_6);

    expect(broker.settlements).toEqual([
      {
        kind: "success",
        value: { markdown: "The finalizer was already done.", proposals: [] },
      },
    ]);
  });

  test("production phase adapter refuses without Task 12 opaque authority", async () => {
    let runCalled = false;
    const runner = createProductionCodexPhaseRunner(undefined, {
      runCodexPhase: async () => {
        runCalled = true;
        throw new Error("must not run");
      },
    });
    await expect(
      runner.run({
        phase: "planner",
        attemptId: `${ASSISTANT_6}_planner`,
        prompt: "calendar only",
      }),
    ).rejects.toMatchObject({ code: "CODEX_CAPABILITY_BLOCKED" });
    expect(runCalled).toBe(false);
  });
});
