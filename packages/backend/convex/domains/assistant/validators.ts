import { v } from "convex/values";

/** One piece of an assistant turn, in the order it happened. A turn is a list of
 * these rather than a string because a single reply can interleave prose with
 * tool activity. `tool_call`/`tool_result` also rebuild the next request's
 * history, so they hold exactly what the model needs verbatim; `proposal`
 * carries only the id of the `assistantActions` row the panel confirms.
 *
 * Owned by the assistant domain (moved out of schema.ts) so the messages table
 * and the assistant data layer share one definition. */
export const assistantBlockValidator = v.union(
  v.object({ type: v.literal("text"), text: v.string() }),
  v.object({
    type: v.literal("tool_call"),
    toolCallId: v.string(),
    name: v.string(),
    // The model's own JSON string. Kept verbatim: re-encoding it would change
    // the bytes the model sees when this turn is replayed as history.
    arguments: v.string(),
  }),
  v.object({
    type: v.literal("tool_result"),
    toolCallId: v.string(),
    content: v.string(),
    isError: v.optional(v.boolean()),
  }),
  v.object({
    type: v.literal("proposal"),
    toolCallId: v.string(),
    actionId: v.id("assistantActions"),
  }),
);

export const assistantAttemptStateValidator = v.union(
  v.literal("persisted"),
  v.literal("planning"),
  v.literal("reading"),
  v.literal("finalizing"),
  v.literal("cancel-requested"),
  v.literal("clarification"),
  v.literal("completed"),
  v.literal("failed"),
  v.literal("cancelled"),
  v.literal("outcome-unknown"),
);

/**
 * The desktop host writes only this normalized, provider-neutral projection.
 * Native frames, stderr, native IDs, and arbitrary provider payloads never
 * cross the durable/application boundary.
 */
export type AssistantAttemptEvent =
  | { kind: "attempt_started" }
  | { kind: "provider_readiness"; readiness: "ready" | "ready_degraded" | "authentication_required" | "incompatible" | "unavailable"; evidenceDigest?: string }
  | { kind: "phase"; phase: "planning" | "reading" | "finalizing"; evidenceDigest?: string }
  | { kind: "planner_completed"; evidenceDigest?: string }
  | { kind: "calendar_read_started"; evidenceDigest?: string }
  | { kind: "calendar_read_completed"; evidenceDigest?: string }
  | { kind: "finalizer_completed"; evidenceDigest?: string }
  | { kind: "clarification"; evidenceDigest?: string }
  | { kind: "proposal"; evidenceDigest?: string }
  | { kind: "cancel"; milestone: "requested" | "native_cancel_sent" | "native_acknowledged" | "interrupt_sent" | "interrupt_acknowledged" | "semantically_interrupted" | "completed_before_interrupt" | "owned_process_terminated" | "outcome_unknown"; evidenceDigest?: string }
  | { kind: "terminal"; outcome: "completed" | "clarification" | "failed" | "cancelled" | "outcome_unknown"; failureCategory?: "authentication_required" | "incompatible" | "invalid_response" | "process_failure" | "timeout" | "unexpected_provider_action" | "outcome_unknown"; evidenceDigest?: string };

const evidenceDigestValidator = v.optional(v.string());

export const assistantAttemptEventValidator = v.union(
  v.object({ kind: v.literal("attempt_started") }),
  v.object({
    kind: v.literal("provider_readiness"),
    readiness: v.union(
      v.literal("ready"),
      v.literal("ready_degraded"),
      v.literal("authentication_required"),
      v.literal("incompatible"),
      v.literal("unavailable"),
    ),
    evidenceDigest: evidenceDigestValidator,
  }),
  v.object({
    kind: v.literal("phase"),
    phase: v.union(
      v.literal("planning"),
      v.literal("reading"),
      v.literal("finalizing"),
    ),
    evidenceDigest: evidenceDigestValidator,
  }),
  v.object({ kind: v.literal("planner_completed"), evidenceDigest: evidenceDigestValidator }),
  v.object({ kind: v.literal("calendar_read_started"), evidenceDigest: evidenceDigestValidator }),
  v.object({ kind: v.literal("calendar_read_completed"), evidenceDigest: evidenceDigestValidator }),
  v.object({ kind: v.literal("finalizer_completed"), evidenceDigest: evidenceDigestValidator }),
  v.object({ kind: v.literal("clarification"), evidenceDigest: evidenceDigestValidator }),
  v.object({ kind: v.literal("proposal"), evidenceDigest: evidenceDigestValidator }),
  v.object({
    kind: v.literal("cancel"),
    milestone: v.union(
      v.literal("requested"),
      v.literal("native_cancel_sent"),
      v.literal("native_acknowledged"),
      v.literal("interrupt_sent"),
      v.literal("interrupt_acknowledged"),
      v.literal("semantically_interrupted"),
      v.literal("completed_before_interrupt"),
      v.literal("owned_process_terminated"),
      v.literal("outcome_unknown"),
    ),
    evidenceDigest: evidenceDigestValidator,
  }),
  v.object({
    kind: v.literal("terminal"),
    outcome: v.union(
      v.literal("completed"),
      v.literal("clarification"),
      v.literal("failed"),
      v.literal("cancelled"),
      v.literal("outcome_unknown"),
    ),
    failureCategory: v.optional(
      v.union(
        v.literal("authentication_required"),
        v.literal("incompatible"),
        v.literal("invalid_response"),
        v.literal("process_failure"),
        v.literal("timeout"),
        v.literal("unexpected_provider_action"),
        v.literal("outcome_unknown"),
      ),
    ),
    evidenceDigest: evidenceDigestValidator,
  }),
);

export const assistantEventRangeValidator = v.union(
  v.object({
    kind: v.literal("timed"),
    startMs: v.number(),
    endMs: v.number(),
  }),
  v.object({
    kind: v.literal("allDay"),
    startDate: v.string(),
    endDate: v.string(),
  }),
);

const recurrenceEndValidator = v.union(
  v.object({ kind: v.literal("never") }),
  v.object({ kind: v.literal("onDate"), date: v.string() }),
  v.object({ kind: v.literal("count"), count: v.number() }),
);

export const assistantRecurrenceValidator = v.object({
  frequency: v.union(
    v.literal("daily"),
    v.literal("weekly"),
    v.literal("monthly"),
    v.literal("yearly"),
  ),
  interval: v.optional(v.number()),
  weekdays: v.optional(
    v.array(
      v.union(
        v.literal("monday"),
        v.literal("tuesday"),
        v.literal("wednesday"),
        v.literal("thursday"),
        v.literal("friday"),
        v.literal("saturday"),
        v.literal("sunday"),
      ),
    ),
  ),
  end: v.optional(recurrenceEndValidator),
  sourceLines: v.optional(v.array(v.string())),
});

const recurrenceScopeValidator = v.union(
  v.literal("thisEvent"),
  v.literal("thisAndFollowing"),
  v.literal("allEvents"),
);

export const assistantProposalValidator = v.union(
  v.object({
    kind: v.literal("create"),
    calendarId: v.string(),
    summary: v.string(),
    time: assistantEventRangeValidator,
    description: v.optional(v.string()),
    location: v.optional(v.string()),
    attendees: v.optional(v.array(v.string())),
    recurrence: v.optional(assistantRecurrenceValidator),
  }),
  v.object({
    kind: v.literal("update"),
    calendarId: v.string(),
    eventId: v.string(),
    expectedUpdatedAt: v.number(),
    expectedRevision: v.string(),
    expectedSeriesRevision: v.optional(v.string()),
    changes: v.object({
      summary: v.optional(v.string()),
      time: v.optional(assistantEventRangeValidator),
      description: v.optional(v.string()),
      location: v.optional(v.string()),
      attendees: v.optional(v.array(v.string())),
      recurrence: v.optional(v.union(assistantRecurrenceValidator, v.null())),
    }),
    scope: v.optional(recurrenceScopeValidator),
  }),
  v.object({
    kind: v.literal("delete"),
    calendarId: v.string(),
    eventId: v.string(),
    expectedUpdatedAt: v.number(),
    expectedRevision: v.string(),
    expectedSeriesRevision: v.optional(v.string()),
    scope: recurrenceScopeValidator,
  }),
);

export const assistantCalendarReadValidator = v.union(
  v.object({
    kind: v.literal("listCalendars"),
    limit: v.number(),
  }),
  v.object({
    kind: v.literal("searchEvents"),
    calendarIds: v.optional(v.array(v.string())),
    startMs: v.number(),
    endMs: v.number(),
    query: v.optional(v.string()),
    limit: v.number(),
  }),
  v.object({
    kind: v.literal("getEvent"),
    calendarId: v.string(),
    eventId: v.string(),
  }),
  v.object({
    kind: v.literal("getAvailability"),
    calendarIds: v.optional(v.array(v.string())),
    startMs: v.number(),
    endMs: v.number(),
    durationMinutes: v.number(),
    limit: v.number(),
  }),
);
