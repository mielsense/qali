import { defineTable } from "convex/server";
import { v } from "convex/values";

import {
  assistantAttemptEventValidator,
  assistantAttemptStateValidator,
  assistantBlockValidator,
} from "./validators";

/** Table definitions owned by the assistant domain, composed into schema.ts. */
export const assistantTables = {
  // One conversation. `lastMessageAt` rather than `_creationTime` orders the
  // list, so a revived old thread sorts to the top where the user left it.
  assistantThreads: defineTable({
    userId: v.string(),
    title: v.string(),
    createdAt: v.number(),
    lastMessageAt: v.number(),
    // Transactional per-thread turn claim. Cleared by finish/fail; stale claims
    // are recovered against the server timestamp when the next turn starts.
    activeMessageId: v.optional(v.id("assistantMessages")),
  }).index("by_user_and_lastMessage", ["userId", "lastMessageAt"]),

  // One bounded operational row per assistant user: fixed-window request quota
  // and a global one-turn lease. Keeping this separate avoids churning threads.
  assistantUserState: defineTable({
    userId: v.string(),
    windowStartMs: v.number(),
    requestCount: v.number(),
    // Rolling monthly quota, independent of the 5-minute burst window above.
    monthWindowStartMs: v.optional(v.number()),
    monthCount: v.optional(v.number()),
    activeMessageId: v.optional(v.id("assistantMessages")),
    activeThreadId: v.optional(v.id("assistantThreads")),
    leaseExpiresAt: v.optional(v.number()),
  }).index("by_user", ["userId"]),

  // One row per turn. `blocks` is appended to in place while the model streams,
  // so the client's reactive subscription renders the reply as it arrives.
  assistantMessages: defineTable({
    threadId: v.id("assistantThreads"),
    // Denormalized from the thread so every read can be scoped without a join.
    userId: v.string(),
    role: v.union(v.literal("user"), v.literal("assistant")),
    blocks: v.array(assistantBlockValidator),
    // A turn that is still streaming is renderable but not yet replayable as
    // history; `error` holds why a turn stopped, for the panel to show.
    status: v.union(
      v.literal("streaming"),
      v.literal("complete"),
      v.literal("error"),
    ),
    error: v.optional(v.string()),
    // Suggested next prompts, generated best-effort once a turn settles and only
    // when they'd genuinely help — usually absent.
    suggestions: v.optional(v.array(v.string())),
    createdAt: v.number(),
  })
    .index("by_thread", ["threadId", "createdAt"])
    // userId is denormalized here for user-scoped reads; the index also lets
    // account-deletion cleanup remove a user's messages without a thread join.
    .index("by_user", ["userId"]),

  // A write the assistant wants to make, held until the user confirms it. The
  // assistant's tools never reach Google — they record one of these instead, and
  // only `assistant.confirmAction` (a click) applies it. Both the confirmation
  // queue and the permanent audit trail of everything ever proposed.
  assistantActions: defineTable({
    threadId: v.id("assistantThreads"),
    userId: v.string(),
    // Ties the proposal back to the tool call that produced it.
    toolCallId: v.string(),
    tool: v.string(),
    // The model's argument JSON. Re-validated against the tool's own schema at
    // apply time — never trusted just because it was stored.
    input: v.string(),
    // A one-line description of the change, written when the proposal is made.
    preview: v.string(),
    // Stable across retries and used as Google's client-selected event ID.
    operationId: v.optional(v.string()),
    attemptCount: v.optional(v.number()),
    applyLeaseExpiresAt: v.optional(v.number()),
    // `applying` is the claim a confirm click takes before it calls Google, so
    // a double-click can't send the same invitation twice.
    status: v.union(
      v.literal("pending"),
      v.literal("applying"),
      v.literal("applied"),
      v.literal("rejected"),
      v.literal("failed"),
    ),
    // What happened on apply: a human-readable confirmation, or the error.
    resultSummary: v.optional(v.string()),
    createdAt: v.number(),
    decidedAt: v.optional(v.number()),
  })
    .index("by_thread", ["threadId", "createdAt"])
    .index("by_user_and_status", ["userId", "status"]),

  // One durable application attempt per renderer send. The provider process is
  // deliberately not represented here; this is application truth for
  // persistence, progress, cancellation intent, and exactly-once settlement.
  assistantAttempts: defineTable({
    attemptId: v.string(),
    userId: v.string(),
    threadId: v.id("assistantThreads"),
    userMessageId: v.id("assistantMessages"),
    assistantMessageId: v.id("assistantMessages"),
    timeZone: v.string(),
    selectedCalendarIds: v.array(v.string()),
    state: assistantAttemptStateValidator,
    terminal: v.boolean(),
    cancelRequested: v.optional(v.boolean()),
    settlementFingerprint: v.optional(v.string()),
    actionIds: v.optional(v.array(v.id("assistantActions"))),
    failureCode: v.optional(v.string()),
    // Allocated transactionally with each immutable normalized event.
    // Optional for pre-event-stream attempts created before this field shipped.
    // The trusted broker initializes it transactionally on their next append.
    nextEventSequence: v.optional(v.number()),
    leaseExpiresAt: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
    settledAt: v.optional(v.number()),
  })
    .index("by_attemptId", ["attemptId"])
    .index("by_user", ["userId"])
    .index("by_user_and_createdAt", ["userId", "createdAt"])
    .index("by_assistantMessageId", ["assistantMessageId"])
    .index("by_thread", ["threadId", "createdAt"]),

  // The bounded, safe, replayable application event log for one provider
  // attempt. Native protocol diagnostics deliberately have no place here.
  assistantAttemptEvents: defineTable({
    attemptId: v.string(),
    sequence: v.number(),
    eventId: v.string(),
    event: assistantAttemptEventValidator,
    createdAt: v.number(),
  })
    .index("by_attemptId_and_sequence", ["attemptId", "sequence"])
    .index("by_attemptId_and_eventId", ["attemptId", "eventId"]),
};
