import {
  assistantCoordinatorAttemptIdSchema,
  type AssistantCoordinatorAttemptId,
} from "@qali/desktop-contracts";

import type { CodexPhaseRunner } from "./coordinator";
import type {
  CancellationMilestoneReporter,
  InterruptOutcome,
} from "./app-server-provider";
import { parseFinalizerJson, parsePlannerJson } from "./schemas";

export type CodexCalendarAttemptLease = Readonly<{
  startThread(): Promise<string>;
  runTurn(input: Readonly<{
    text: string;
    outputSchema: unknown;
  }>): Promise<Readonly<{
    finalText: string;
    threadId: string;
    turnId: string;
  }>>;
  interrupt(report?: CancellationMilestoneReporter): Promise<InterruptOutcome>;
  release(): Promise<void>;
}>;

export type CodexCalendarAssistantHost = Readonly<{
  acquireAttempt(
    attemptId: AssistantCoordinatorAttemptId,
  ): Promise<CodexCalendarAttemptLease>;
}>;

type AttemptState = {
  lease: Promise<CodexCalendarAttemptLease>;
  plannerCompleted: boolean;
  cancelled: boolean;
};

function adapterError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function throwIfCancelled(state: AttemptState): void {
  if (state.cancelled) {
    throw adapterError("CODEX_CANCELLED", "Codex attempt was cancelled");
  }
}

function attemptIdFromPhase(
  phaseAttemptId: string,
): AssistantCoordinatorAttemptId {
  const match = /^(assistant_[0-9a-f]{32})_(?:planner|finalizer)$/.exec(
    phaseAttemptId,
  );
  if (!match) {
    throw adapterError(
      "CODEX_ATTEMPT_INVALID",
      "Codex phase attempt identity is invalid",
    );
  }
  return assistantCoordinatorAttemptIdSchema.parse(match[1]);
}

/**
 * The calendar assistant owns no native history. It binds Qali's planner and
 * finalizer to one host lease, which in turn owns one ephemeral native thread.
 */
export function createCodexCalendarAssistantAdapter(
  host: CodexCalendarAssistantHost,
  outputSchemas: Readonly<{ planner: unknown; finalizer: unknown }>,
): CodexPhaseRunner {
  const attempts = new Map<AssistantCoordinatorAttemptId, AttemptState>();

  const requireAttempt = (attemptId: AssistantCoordinatorAttemptId): AttemptState => {
    const state = attempts.get(attemptId);
    if (!state) {
      throw adapterError(
        "CODEX_PLANNER_REQUIRED",
        "Codex finalizer requires a completed planner turn",
      );
    }
    return state;
  };

  return {
    async run(request) {
      const attemptId = attemptIdFromPhase(request.attemptId);
      let state = attempts.get(attemptId);
      if (request.phase === "planner") {
        if (state) {
          throw adapterError(
            "CODEX_PLANNER_ALREADY_STARTED",
            "Codex planner turn is already started",
          );
        }
        const lease = host.acquireAttempt(attemptId);
        state = { lease, plannerCompleted: false, cancelled: false };
        attempts.set(attemptId, state);
        void lease.catch(() => {
          if (attempts.get(attemptId) === state) attempts.delete(attemptId);
        });
      } else if (!state || !state.plannerCompleted) {
        throw adapterError(
          "CODEX_PLANNER_REQUIRED",
          "Codex finalizer requires a completed planner turn",
        );
      }

      const lease = await state.lease;
      throwIfCancelled(state);
      if (request.phase === "planner") {
        await lease.startThread();
        throwIfCancelled(state);
      }
      throwIfCancelled(state);
      const result = await lease.runTurn({
        text: request.prompt,
        outputSchema: outputSchemas[request.phase],
      });
      if (request.phase === "planner") {
        parsePlannerJson(result.finalText);
        state.plannerCompleted = true;
      } else {
        parseFinalizerJson(result.finalText);
      }
      return { finalText: result.finalText };
    },
    async cancel(phaseAttemptId, report) {
      const attemptId = attemptIdFromPhase(phaseAttemptId);
      const state = requireAttempt(attemptId);
      state.cancelled = true;
      return await (await state.lease).interrupt(report);
    },
    async releaseAttempt(attemptId) {
      const parsedAttemptId = assistantCoordinatorAttemptIdSchema.parse(attemptId);
      const state = attempts.get(parsedAttemptId);
      if (!state) return;
      attempts.delete(parsedAttemptId);
      await (await state.lease).release();
    },
  };
}
