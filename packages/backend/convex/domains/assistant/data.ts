/** Provider-free reactive data facade for the supervised desktop assistant. */

import { v } from "convex/values";

import type { Doc, Id } from "../../_generated/dataModel";
import { query, type MutationCtx, type QueryCtx } from "../../_generated/server";
import { optionalLocalUser } from "../desktop/identity";

const TITLE_MAX = 60;
const MESSAGE_LIST_LIMIT = 100;
const ACTION_LIST_LIMIT = 100;
const ATTEMPT_EVENT_LIST_LIMIT = 100;
const MONTH_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_TURNS_PER_MONTH = 10;

export function deriveAssistantTitle(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= TITLE_MAX) return flat || "New conversation";
  return `${flat.slice(0, TITLE_MAX - 1).trimEnd()}…`;
}

async function ownedThread(
  ctx: QueryCtx,
  threadId: Id<"assistantThreads">,
  userId: string,
): Promise<Doc<"assistantThreads"> | null> {
  const thread = await ctx.db.get(threadId);
  return thread && thread.userId === userId ? thread : null;
}

export const monthlyQuota = query({
  args: {},
  handler: async (ctx): Promise<{ used: number; limit: number; remaining: number }> => {
    const user = await optionalLocalUser(ctx);
    if (!user) return { used: 0, limit: MAX_TURNS_PER_MONTH, remaining: MAX_TURNS_PER_MONTH };
    const state = await ctx.db
      .query("assistantUserState")
      .withIndex("by_user", (query) => query.eq("userId", user.id))
      .unique();
    const inWindow =
      state?.monthWindowStartMs !== undefined &&
      Date.now() - state.monthWindowStartMs < MONTH_WINDOW_MS;
    const used = inWindow ? (state?.monthCount ?? 0) : 0;
    return {
      used,
      limit: MAX_TURNS_PER_MONTH,
      remaining: Math.max(0, MAX_TURNS_PER_MONTH - used),
    };
  },
});

export const listThreads = query({
  args: {},
  handler: async (ctx) => {
    const user = await optionalLocalUser(ctx);
    if (!user) return [];
    return await ctx.db
      .query("assistantThreads")
      .withIndex("by_user_and_lastMessage", (query) => query.eq("userId", user.id))
      .order("desc")
      .take(30);
  },
});

export const listMessages = query({
  args: { threadId: v.id("assistantThreads") },
  handler: async (ctx, args) => {
    const user = await optionalLocalUser(ctx);
    if (!user || !(await ownedThread(ctx, args.threadId, user.id))) return [];
    const rows = await ctx.db
      .query("assistantMessages")
      .withIndex("by_thread", (query) => query.eq("threadId", args.threadId))
      .order("desc")
      .take(MESSAGE_LIST_LIMIT);
    return rows.reverse();
  },
});

export const listPendingActions = query({
  args: { threadId: v.id("assistantThreads") },
  handler: async (ctx, args) => {
    const user = await optionalLocalUser(ctx);
    if (!user || !(await ownedThread(ctx, args.threadId, user.id))) return [];
    const rows = await ctx.db
      .query("assistantActions")
      .withIndex("by_thread", (query) => query.eq("threadId", args.threadId))
      .order("desc")
      .take(ACTION_LIST_LIMIT);
    return rows.reverse();
  },
});

/** Safe normalized event replay for the renderer. Native provider payloads are
 * excluded by the event table's closed validator. */
export const listAttemptEvents = query({
  args: {
    attemptId: v.string(),
    afterSequence: v.number(),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    const user = await optionalLocalUser(ctx);
    if (
      !user ||
      !Number.isSafeInteger(args.afterSequence) ||
      args.afterSequence < 0 ||
      !Number.isSafeInteger(args.limit) ||
      args.limit < 1 ||
      args.limit > ATTEMPT_EVENT_LIST_LIMIT
    ) {
      return { events: [], nextAfterSequence: args.afterSequence, hasMore: false, gap: null };
    }
    const attempt = await ctx.db
      .query("assistantAttempts")
      .withIndex("by_attemptId", (query) => query.eq("attemptId", args.attemptId))
      .unique();
    if (!attempt || attempt.userId !== user.id) {
      return { events: [], nextAfterSequence: args.afterSequence, hasMore: false, gap: null };
    }
    const first = await ctx.db
      .query("assistantAttemptEvents")
      .withIndex("by_attemptId_and_sequence", (query) =>
        query.eq("attemptId", args.attemptId),
      )
      .first();
    const rows = await ctx.db
      .query("assistantAttemptEvents")
      .withIndex("by_attemptId_and_sequence", (query) =>
        query.eq("attemptId", args.attemptId).gt("sequence", args.afterSequence),
      )
      .take(args.limit + 1);
    const events = rows.slice(0, args.limit).map((row) => ({
      sequence: row.sequence,
      eventId: row.eventId,
      event: row.event,
      createdAt: row.createdAt,
    }));
    return {
      events,
      nextAfterSequence:
        events.length > 0
          ? events[events.length - 1]!.sequence
          : args.afterSequence,
      hasMore: rows.length > args.limit,
      gap:
        first && args.afterSequence < first.sequence - 1
          ? {
              requestedAfterSequence: args.afterSequence,
              earliestAvailableSequence: first.sequence,
              recovery: "reload_attempt" as const,
            }
          : null,
    };
  },
});

export async function releaseAssistantTurn(
  ctx: MutationCtx,
  messageId: Id<"assistantMessages">,
  threadId: Id<"assistantThreads">,
  now: number,
): Promise<void> {
  const thread = await ctx.db.get(threadId);
  const message = await ctx.db.get(messageId);
  if (thread?.activeMessageId === messageId) {
    await ctx.db.patch(threadId, { activeMessageId: undefined, lastMessageAt: now });
  }
  const state = await ctx.db
    .query("assistantUserState")
    .withIndex("by_user", (query) => query.eq("userId", message?.userId ?? ""))
    .unique();
  if (state?.activeMessageId === messageId) {
    await ctx.db.patch(state._id, {
      activeMessageId: undefined,
      activeThreadId: undefined,
      leaseExpiresAt: undefined,
    });
  }
}
