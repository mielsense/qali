import { randomUUID } from "node:crypto";
import { assistantCoordinatorAttemptIdSchema } from "@qali/desktop-contracts";

import type { CodexRuntimeAuthority } from "./boundary";
import {
  cancelCodexAttempt,
  runCodexPhase,
  type CodexPhaseResult,
} from "./process-driver";
import { buildFinalizerPrompt, buildPlannerPrompt } from "./prompts";
import {
  parseFinalizerJson,
  parsePlannerJson,
  AssistantCoordinatorRequest,
  type AssistantAttemptContext,
  type FinalizerOutputValue,
} from "./schemas";
import type { CalendarReader } from "./calendar-reader";
import type {
  CancellationMilestone,
  CancellationMilestoneReporter,
  InterruptOutcome,
} from "./app-server-provider";

export type { AssistantAttemptContext } from "./schemas";

export type AssistantFailure = Readonly<{
  code:
    | "schema-failure"
    | "cancelled"
    | "unavailable"
    | "process-failure"
    | "outcome-unknown";
  message?: string;
}>;

export interface AssistantBroker {
  beginAttempt(
    input: Readonly<{
      attemptId: string;
      text: string;
      timeZone: string;
      nowMs: number;
    }>,
  ): Promise<AssistantAttemptContext>;
  recordProgress(
    attemptId: string,
    state: "planning" | "reading" | "finalizing",
  ): Promise<void>;
  settleClarification(attemptId: string, question: string): Promise<void>;
  settleSuccess(attemptId: string, value: FinalizerOutputValue): Promise<void>;
  settleFailure(attemptId: string, failure: AssistantFailure): Promise<void>;
  requestCancellation(attemptId: string): Promise<void>;
  recordEvent?(input: Readonly<{
    attemptId: string;
    eventId: string;
    event: Readonly<{
      kind: "cancel";
      milestone:
        | "interrupt_sent"
        | "interrupt_acknowledged"
        | "semantically_interrupted"
        | "completed_before_interrupt"
        | "owned_process_terminated"
        | "outcome_unknown";
    }>;
  }>): Promise<unknown>;
}

export type CodexCoordinatorPhase = "planner" | "finalizer";

export interface CodexPhaseRunner {
  run(
    request: Readonly<{
      phase: CodexCoordinatorPhase;
      attemptId: string;
      prompt: string;
    }>,
  ): Promise<Readonly<{ finalText: string }>>;
  cancel(
    attemptId: string,
    report?: CancellationMilestoneReporter,
  ): Promise<InterruptOutcome | void>;
  releaseAttempt?(attemptId: string): Promise<void>;
}

type ActiveAttempt = {
  currentPhaseAttemptId?: string;
  cancelRequested: boolean;
  cancellation?: Promise<void>;
  cancellationNative?: Promise<InterruptOutcome | void>;
  cancellationTerminal?: InterruptOutcome["terminal"];
  completion: Promise<void>;
};

export type AssistantCoordinatorDependencies = Readonly<{
  broker: AssistantBroker;
  calendarReader: CalendarReader;
  phaseRunner: CodexPhaseRunner;
  now?: () => number;
  createAttemptId?: () => string;
}>;

function safeFailure(
  error: unknown,
  cancelRequested: boolean,
): AssistantFailure {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : undefined;
  if (code === "CODEX_OUTCOME_UNKNOWN") {
    return {
      code: "outcome-unknown",
      message: "The assistant outcome is unknown and was not replayed.",
    };
  }
  if (cancelRequested || code === "CODEX_CANCELLED") {
    return {
      code: "cancelled",
      message: "The assistant attempt was cancelled.",
    };
  }
  if (error instanceof Error && error.message === "ASSISTANT_CANCEL_REQUESTED") {
    return {
      code: "cancelled",
      message: "The assistant attempt was cancelled.",
    };
  }
  if (
    code === "CODEX_CAPABILITY_BLOCKED" ||
    code === "CODEX_BOUNDARY_AUTHORITY_REQUIRED"
  ) {
    return {
      code: "unavailable",
      message: "The assistant provider is unavailable.",
    };
  }
  if (
    code === "CODEX_SERVER_REQUEST_UNSUPPORTED" ||
    code === "CODEX_UNEXPECTED_PROVIDER_ACTION"
  ) {
    return {
      code: "process-failure",
      message: "The assistant requested an unsupported provider action.",
    };
  }
  if (
    error instanceof SyntaxError ||
    (error instanceof Error &&
      /^ASSISTANT_(?:PROVIDER_JSON|FORBIDDEN|READ_|SUMMARY|CALENDAR)/.test(
        error.message,
      )) ||
    (typeof error === "object" &&
      error !== null &&
      "name" in error &&
      error.name === "ZodError")
  ) {
    return {
      code: "schema-failure",
      message: "The assistant returned invalid calendar data.",
    };
  }
  return {
    code: "process-failure",
    message: "The assistant attempt did not complete.",
  };
}

function cancellationEvent(
  milestone: CancellationMilestone,
): Readonly<{
  eventId: string;
    event: Readonly<{
      kind: "cancel";
      milestone:
        | "interrupt_sent"
        | "interrupt_acknowledged"
        | "semantically_interrupted"
        | "completed_before_interrupt"
        | "owned_process_terminated"
        | "outcome_unknown";
  }>;
}> | null {
  switch (milestone) {
    case "interrupt-sent":
      return {
        eventId: "event:cancel-interrupt-sent",
        event: { kind: "cancel", milestone: "interrupt_sent" },
      };
    case "interrupt-acknowledged":
      return {
        eventId: "event:cancel-interrupt-acknowledged",
        event: { kind: "cancel", milestone: "interrupt_acknowledged" },
      };
    case "semantically-interrupted":
      return {
        eventId: "event:cancel-semantically-interrupted",
        event: { kind: "cancel", milestone: "semantically_interrupted" },
      };
    case "completed-before-interrupt":
      return {
        eventId: "event:cancel-completed-before-interrupt",
        event: { kind: "cancel", milestone: "completed_before_interrupt" },
      };
    case "owned-process-terminated":
      return {
        eventId: "event:cancel-owned-process-terminated",
        event: { kind: "cancel", milestone: "owned_process_terminated" },
      };
    case "outcome-unknown":
      return {
        eventId: "event:cancel-outcome-unknown",
        event: { kind: "cancel", milestone: "outcome_unknown" },
      };
    default:
      return null;
  }
}

async function throwIfCancellationWins(
  active: ActiveAttempt,
  completedTurnCanSettle: boolean,
): Promise<void> {
  if (!active.cancelRequested) return;
  const outcome = await active.cancellationNative;
  if (
    completedTurnCanSettle &&
    (outcome?.terminal === "completed-before-interrupt" ||
      active.cancellationTerminal === "completed-before-interrupt")
  ) {
    return;
  }
  throw Object.assign(new Error("cancelled"), {
    code: "CODEX_CANCELLED",
  });
}

export class AssistantCoordinator {
  private readonly broker: AssistantBroker;
  private readonly calendarReader: CalendarReader;
  private readonly phaseRunner: CodexPhaseRunner;
  private readonly now: () => number;
  private readonly createAttemptId: () => string;
  private readonly active = new Map<string, ActiveAttempt>();

  constructor(dependencies: AssistantCoordinatorDependencies) {
    this.broker = dependencies.broker;
    this.calendarReader = dependencies.calendarReader;
    this.phaseRunner = dependencies.phaseRunner;
    this.now = dependencies.now ?? Date.now;
    this.createAttemptId = dependencies.createAttemptId ?? (() =>
      `assistant_${randomUUID().replaceAll("-", "")}`);
  }

  async send(
    request: unknown,
  ): Promise<
    | Readonly<{ kind: "accepted"; attemptId: string }>
    | Readonly<{ kind: "rejected"; reason: "schema-failure" | "unavailable" }>
  > {
    let parsed: ReturnType<typeof AssistantCoordinatorRequest.parse>;
    try {
      parsed = AssistantCoordinatorRequest.parse(request);
    } catch {
      return { kind: "rejected", reason: "schema-failure" };
    }
    const parsedAttemptId = assistantCoordinatorAttemptIdSchema.safeParse(
      this.createAttemptId(),
    );
    if (!parsedAttemptId.success) {
      return { kind: "rejected", reason: "unavailable" };
    }
    const attemptId = parsedAttemptId.data;
    let context: AssistantAttemptContext;
    try {
      context = await this.broker.beginAttempt({
        attemptId,
        text: parsed.text,
        timeZone: parsed.timeZone,
        nowMs: this.now(),
      });
    } catch {
      return { kind: "rejected", reason: "unavailable" };
    }

    const active: ActiveAttempt = {
      cancelRequested: false,
      completion: Promise.resolve(),
    };
    active.completion = this.execute(
      attemptId,
      parsed,
      context,
      active,
    ).finally(() => {
      if (this.active.get(attemptId) === active) this.active.delete(attemptId);
    });
    this.active.set(attemptId, active);
    return { kind: "accepted", attemptId };
  }

  async cancel(attemptId: string): Promise<void> {
    assistantCoordinatorAttemptIdSchema.parse(attemptId);
    const active = this.active.get(attemptId);
    if (!active) {
      await this.broker.requestCancellation(attemptId);
      return;
    }
    if (active.cancellation) return active.cancellation;
    active.cancelRequested = true;
    active.cancellation = (async () => {
      // This is the durable request milestone. It must commit before any
      // provider-native interrupt is admitted for this attempt.
      await this.broker.requestCancellation(attemptId);
      if (active.currentPhaseAttemptId) {
        const recorded = new Set<CancellationMilestone>();
        const report: CancellationMilestoneReporter = async (milestone) => {
          if (recorded.has(milestone)) return;
          const event = cancellationEvent(milestone);
          try {
            if (event) {
              await this.broker.recordEvent?.({ attemptId, ...event });
            }
            recorded.add(milestone);
          } catch {
            // The durable cancellation request has already committed. A
            // best-effort milestone fan-out failure must never prevent the
            // native interruption or leave this application attempt active.
          }
        };
        const cancellationNative = this.phaseRunner.cancel(
          active.currentPhaseAttemptId,
          report,
        );
        active.cancellationNative = cancellationNative;
        const outcome = await cancellationNative;
        if (outcome) {
          active.cancellationTerminal = outcome.terminal;
          for (const milestone of outcome.milestones) {
            if (recorded.has(milestone)) continue;
            await report(milestone);
          }
        }
      }
      await active.completion;
    })();
    return active.cancellation;
  }

  async drain(): Promise<void> {
    await Promise.all(
      [...this.active.keys()].map((attemptId) => this.cancel(attemptId)),
    );
  }

  private async execute(
    attemptId: string,
    request: Readonly<{ text: string; timeZone: string }>,
    context: AssistantAttemptContext,
    active: ActiveAttempt,
  ): Promise<void> {
    try {
      const nowMs = this.now();
      await this.broker.recordProgress(attemptId, "planning");
      active.currentPhaseAttemptId = `${attemptId}_planner`;
      const planner = await this.phaseRunner.run({
        phase: "planner",
        attemptId: active.currentPhaseAttemptId,
        prompt: buildPlannerPrompt({
          request: request.text,
          nowMs,
          timeZone: request.timeZone,
          selectedCalendarIds: context.selectedCalendarIds,
          summary: context.summary,
        }),
      });
      await throwIfCancellationWins(active, false);
      active.currentPhaseAttemptId = undefined;
      const plan = parsePlannerJson(planner.finalText);
      if (plan.kind === "clarification") {
        await this.broker.settleClarification(attemptId, plan.question.trim());
        return;
      }

      await this.broker.recordProgress(attemptId, "reading");
      const readResults = await this.calendarReader.execute(plan.reads, {
        attemptId,
        selectedCalendarIds: context.selectedCalendarIds,
      });
      await throwIfCancellationWins(active, false);

      await this.broker.recordProgress(attemptId, "finalizing");
      active.currentPhaseAttemptId = `${attemptId}_finalizer`;
      const finalizer = await this.phaseRunner.run({
        phase: "finalizer",
        attemptId: active.currentPhaseAttemptId,
        prompt: buildFinalizerPrompt({
          request: request.text,
          nowMs,
          timeZone: request.timeZone,
          selectedCalendarIds: context.selectedCalendarIds,
          summary: context.summary,
          readResults,
        }),
      });
      await throwIfCancellationWins(active, true);
      active.currentPhaseAttemptId = undefined;
      await this.broker.settleSuccess(
        attemptId,
        parseFinalizerJson(finalizer.finalText),
      );
    } catch (error) {
      await this.broker.settleFailure(
        attemptId,
        safeFailure(
          error,
          active.cancelRequested &&
            active.cancellationTerminal !== "completed-before-interrupt",
        ),
      );
    } finally {
      active.currentPhaseAttemptId = undefined;
      await this.phaseRunner.releaseAttempt?.(attemptId).catch(() => {});
    }
  }
}

type ProductionRunnerDependencies = Readonly<{
  runCodexPhase?: typeof runCodexPhase;
  cancelCodexAttempt?: typeof cancelCodexAttempt;
}>;

function assertCoordinatorPhaseAttemptId(attemptId: string): void {
  const match = /^(assistant_[0-9a-f]{32})_(?:planner|finalizer)$/.exec(
    attemptId,
  );
  if (!match) {
    throw new Error("Assistant phase attempt identity is invalid");
  }
  assistantCoordinatorAttemptIdSchema.parse(match[1]);
}

export function createProductionCodexPhaseRunner(
  authority: CodexRuntimeAuthority | undefined,
  dependencies: ProductionRunnerDependencies = {},
): CodexPhaseRunner {
  const runPhase = dependencies.runCodexPhase ?? runCodexPhase;
  const cancelPhase = dependencies.cancelCodexAttempt ?? cancelCodexAttempt;
  return {
    async run(request) {
      assertCoordinatorPhaseAttemptId(request.attemptId);
      if (!authority) {
        throw Object.assign(
          new Error("Codex capability evidence is not ready"),
          {
            code: "CODEX_CAPABILITY_BLOCKED",
          },
        );
      }
      const validateFinalOutput =
        request.phase === "planner"
          ? (text: string) => void parsePlannerJson(text)
          : (text: string) => void parseFinalizerJson(text);
      const result: CodexPhaseResult = await runPhase({
        authority,
        phase: request.phase,
        attemptId: request.attemptId,
        prompt: request.prompt,
        timeoutMs: 60_000,
        validateFinalOutput,
      });
      return { finalText: result.finalText };
    },
    async cancel(attemptId) {
      assertCoordinatorPhaseAttemptId(attemptId);
      cancelPhase(attemptId);
    },
  };
}
