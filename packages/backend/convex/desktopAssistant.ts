import { v } from "convex/values";

import { mutation, query } from "./_generated/server";
import {
  beginAttempt as beginAttemptHandler,
  listAttemptEvents as listAttemptEventsHandler,
  readCalendar as readCalendarHandler,
  recordEvent as recordEventHandler,
  recordProgress as recordProgressHandler,
  requestCancellation as requestCancellationHandler,
  settleClarification as settleClarificationHandler,
  settleFailure as settleFailureHandler,
  settleSuccess as settleSuccessHandler,
} from "./domains/desktop/assistantBroker";
import {
  assistantCalendarReadValidator,
  assistantAttemptEventValidator,
  assistantProposalValidator,
} from "./domains/assistant/validators";

export const beginAttempt = mutation({
  args: {
    attemptId: v.string(),
    text: v.string(),
    timeZone: v.string(),
    nowMs: v.number(),
  },
  handler: (ctx, args) => beginAttemptHandler(ctx, args),
});

export const readCalendar = query({
  args: {
    attemptId: v.string(),
    selectedCalendarIds: v.array(v.string()),
    reads: v.array(assistantCalendarReadValidator),
  },
  handler: (ctx, args) => readCalendarHandler(ctx, args),
});

export const listAttemptEvents = query({
  args: {
    attemptId: v.string(),
    afterSequence: v.number(),
    limit: v.number(),
  },
  handler: (ctx, args) => listAttemptEventsHandler(ctx, args),
});

export const recordEvent = mutation({
  args: {
    attemptId: v.string(),
    eventId: v.string(),
    event: assistantAttemptEventValidator,
  },
  handler: (ctx, args) => recordEventHandler(ctx, args),
});

export const recordProgress = mutation({
  args: {
    attemptId: v.string(),
    state: v.union(
      v.literal("planning"),
      v.literal("reading"),
      v.literal("finalizing"),
    ),
  },
  handler: (ctx, args) => recordProgressHandler(ctx, args),
});

export const requestCancellation = mutation({
  args: { attemptId: v.string() },
  handler: (ctx, args) => requestCancellationHandler(ctx, args),
});

export const settleClarification = mutation({
  args: { attemptId: v.string(), question: v.string() },
  handler: (ctx, args) => settleClarificationHandler(ctx, args),
});

export const settleSuccess = mutation({
  args: {
    attemptId: v.string(),
    markdown: v.string(),
    proposals: v.array(assistantProposalValidator),
  },
  handler: (ctx, args) => settleSuccessHandler(ctx, args),
});

export const settleFailure = mutation({
  args: {
    attemptId: v.string(),
    code: v.string(),
    message: v.optional(v.string()),
  },
  handler: (ctx, args) => settleFailureHandler(ctx, args),
});
