import { describe, expect, test } from "bun:test";

import { createCodexCalendarAssistantAdapter } from "../src/main/codex/calendar-assistant-adapter";

const ATTEMPT = `assistant_${"a".repeat(32)}`;

describe("Codex calendar assistant adapter", () => {
  test("acquires one ephemeral lease and keeps planner and finalizer on its native thread", async () => {
    const acquired: string[] = [];
    const turns: Array<{ text: string; outputSchema: unknown }> = [];
    let nativeThreadStarts = 0;
    let releases = 0;
    const plannerSchema = { title: "planner" };
    const finalizerSchema = { title: "finalizer" };
    const adapter = createCodexCalendarAssistantAdapter(
      {
        async acquireAttempt(attemptId) {
          acquired.push(attemptId);
          return {
            async startThread() {
              nativeThreadStarts += 1;
              return "native-thread-1";
            },
            async runTurn(input) {
              turns.push(input);
              return {
                finalText:
                  turns.length === 1
                    ? JSON.stringify({ kind: "reads", reads: [] })
                    : JSON.stringify({ markdown: "Nothing scheduled.", proposals: [] }),
                threadId: "native-thread-1",
                turnId: `turn-${turns.length}`,
              };
            },
            async interrupt() {
              return {
                terminal: "completed-before-interrupt" as const,
                milestones: ["completed-before-interrupt"] as const,
              };
            },
            async release() {
              releases += 1;
            },
          };
        },
      },
      { planner: plannerSchema, finalizer: finalizerSchema },
    );

    await adapter.run({
      phase: "planner",
      attemptId: `${ATTEMPT}_planner`,
      prompt: "plan this calendar request",
    });
    await adapter.run({
      phase: "finalizer",
      attemptId: `${ATTEMPT}_finalizer`,
      prompt: "finalize this calendar request",
    });
    await adapter.releaseAttempt?.(ATTEMPT);

    expect(acquired).toEqual([ATTEMPT]);
    expect(nativeThreadStarts).toBe(1);
    expect(turns).toEqual([
      { text: "plan this calendar request", outputSchema: plannerSchema },
      {
        text: "finalize this calendar request",
        outputSchema: finalizerSchema,
      },
    ]);
    expect(releases).toBe(1);
  });

  test("returns the lease's semantic cancellation classification without targeting another attempt", async () => {
    const interrupts: string[] = [];
    const adapter = createCodexCalendarAssistantAdapter(
      {
        async acquireAttempt() {
          return {
            async startThread() {
              return "native-thread-1";
            },
            async runTurn() {
              return {
                finalText: JSON.stringify({ kind: "reads", reads: [] }),
                threadId: "native-thread-1",
                turnId: "turn-1",
              };
            },
            async interrupt() {
              interrupts.push(ATTEMPT);
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
            async release() {},
          };
        },
      },
      { planner: {}, finalizer: {} },
    );

    await adapter.run({
      phase: "planner",
      attemptId: `${ATTEMPT}_planner`,
      prompt: "plan",
    });

    await expect(adapter.cancel(`${ATTEMPT}_planner`)).resolves.toEqual({
      terminal: "outcome-unknown",
      milestones: [
        "interrupt-sent",
        "interrupt-acknowledged",
        "owned-process-terminated",
        "outcome-unknown",
      ],
    });
    expect(interrupts).toEqual([ATTEMPT]);
  });
});
