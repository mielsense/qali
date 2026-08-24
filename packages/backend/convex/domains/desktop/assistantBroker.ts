import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { eventCapabilities } from "@qali/domain/permissions";
import { calendarOperationIdForIntent } from "../../lib/assistantLogic";
import { deriveAssistantTitle, releaseAssistantTurn } from "../assistant/data";
import type { AssistantAttemptEvent } from "../assistant/validators";
import { requireDesktopBroker } from "./identity";

const MAX_REQUEST_BYTES = 4_000;
const MAX_TIME_ZONE_BYTES = 256;
const MAX_SELECTED_CALENDARS = 32;
const MAX_SUMMARY_MESSAGES = 12;
const MAX_SUMMARY_MESSAGE_BYTES = 4_000;
const MAX_SUMMARY_BYTES = 12_000;
const MAX_READS = 8;
const MAX_READ_RESULTS = 100;
const MAX_AGGREGATE_RESULTS = 250;
const MAX_READ_CONTEXT_BYTES = 64 * 1_024;
const MAX_RANGE_MS = 366 * 24 * 60 * 60 * 1_000;
const MAX_MARKDOWN_BYTES = 8_000;
const MAX_PROPOSALS = 8;
const MAX_TITLE_BYTES = 500;
const MAX_DESCRIPTION_BYTES = 4_000;
const MAX_LOCATION_BYTES = 1_000;
const MAX_ATTENDEES = 100;
const MAX_ATTENDEE_BYTES = 320;
const MAX_RECURRENCE_LINES = 10;
const MAX_RECURRENCE_LINE_BYTES = 500;
const ATTEMPT_LEASE_MS = 10 * 60_000;
const MAX_EVENT_ID_BYTES = 128;
const MAX_EVIDENCE_DIGEST_BYTES = 256;
const MAX_ATTEMPT_EVENT_PAGE = 100;
const INTERNAL_EVENT_PREFIX = "internal:";
const EXTERNAL_EVENT_PREFIX = "event:";
const REVISION_ACTIVE_STATES = [
  "pending",
  "syncing",
  "conflict",
  "ambiguous",
  "failed",
] as const;

type ProgressState = "planning" | "reading" | "finalizing";
type CancellationMilestone = Extract<
  AssistantAttemptEvent,
  { kind: "cancel" }
>["milestone"];
type RecurrenceScope = "thisEvent" | "thisAndFollowing" | "allEvents";
type EventRange =
  | { kind: "timed"; startMs: number; endMs: number }
  | { kind: "allDay"; startDate: string; endDate: string };
type Recurrence = {
  frequency: "daily" | "weekly" | "monthly" | "yearly";
  interval?: number;
  weekdays?: string[];
  end?:
    | { kind: "never" }
    | { kind: "onDate"; date: string }
    | { kind: "count"; count: number };
  sourceLines?: string[];
};
export type AssistantProposal =
  | {
      kind: "create";
      calendarId: string;
      summary: string;
      time: EventRange;
      description?: string;
      location?: string;
      attendees?: string[];
      recurrence?: Recurrence;
    }
  | {
      kind: "update";
      calendarId: string;
      eventId: string;
      expectedUpdatedAt: number;
      expectedRevision: string;
      expectedSeriesRevision?: string;
      changes: {
        summary?: string;
        time?: EventRange;
        description?: string;
        location?: string;
        attendees?: string[];
        recurrence?: Recurrence | null;
      };
      scope?: RecurrenceScope;
    }
  | {
      kind: "delete";
      calendarId: string;
      eventId: string;
      expectedUpdatedAt: number;
      expectedRevision: string;
      expectedSeriesRevision?: string;
      scope: RecurrenceScope;
    };

export type AssistantCalendarRead =
  | { kind: "listCalendars"; limit: number }
  | {
      kind: "searchEvents";
      calendarIds?: string[];
      startMs: number;
      endMs: number;
      query?: string;
      limit: number;
    }
  | { kind: "getEvent"; calendarId: string; eventId: string }
  | {
      kind: "getAvailability";
      calendarIds?: string[];
      startMs: number;
      endMs: number;
      durationMinutes: number;
      limit: number;
    };

function bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function assertString(
  value: string,
  maxBytes: number,
  code: string,
  allowEmpty = false,
): void {
  if (
    (!allowEmpty && value.trim().length === 0) ||
    bytes(value) > maxBytes ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  ) {
    throw new Error(code);
  }
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (bytes(value) <= maxBytes) return value;
  let end = Math.min(value.length, maxBytes);
  while (end > 0 && bytes(value.slice(0, end)) > maxBytes) end -= 1;
  return value.slice(0, end);
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

async function attemptById(
  ctx: QueryCtx,
  attemptId: string,
): Promise<Doc<"assistantAttempts"> | null> {
  return ctx.db
    .query("assistantAttempts")
    .withIndex("by_attemptId", (query) => query.eq("attemptId", attemptId))
    .unique();
}

function assertEventId(eventId: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(eventId)) {
    throw new Error("ASSISTANT_EVENT_ID_INVALID");
  }
  assertString(eventId, MAX_EVENT_ID_BYTES, "ASSISTANT_EVENT_ID_INVALID");
}

function assertExternalEventId(eventId: string): void {
  assertEventId(eventId);
  if (!eventId.startsWith(EXTERNAL_EVENT_PREFIX)) {
    throw new Error("ASSISTANT_EVENT_ID_RESERVED");
  }
}

function internalEventId(name: string): string {
  const eventId = `${INTERNAL_EVENT_PREFIX}${name}`;
  assertEventId(eventId);
  return eventId;
}

function assertEventSafe(event: AssistantAttemptEvent): void {
  if (
    "evidenceDigest" in event &&
    event.evidenceDigest !== undefined
  ) {
    assertString(
      event.evidenceDigest,
      MAX_EVIDENCE_DIGEST_BYTES,
      "ASSISTANT_EVENT_INVALID",
    );
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(event.evidenceDigest)) {
      throw new Error("ASSISTANT_EVENT_INVALID");
    }
  }
}

function eventMatches(
  existing: AssistantAttemptEvent,
  expected: AssistantAttemptEvent,
): boolean {
  return JSON.stringify(existing) === JSON.stringify(expected);
}

async function lastAttemptEvent(
  ctx: QueryCtx | MutationCtx,
  attemptId: string,
) {
  return await ctx.db
    .query("assistantAttemptEvents")
    .withIndex("by_attemptId_and_sequence", (query) =>
      query.eq("attemptId", attemptId),
    )
    .order("desc")
    .first();
}

async function attemptEventById(
  ctx: QueryCtx | MutationCtx,
  attemptId: string,
  eventId: string,
) {
  return await ctx.db
    .query("assistantAttemptEvents")
    .withIndex("by_attemptId_and_eventId", (query) =>
      query.eq("attemptId", attemptId).eq("eventId", eventId),
    )
    .unique();
}

function assertAttemptEventOrder(
  attempt: Doc<"assistantAttempts">,
  event: AssistantAttemptEvent,
  previous: { event: AssistantAttemptEvent } | null,
): void {
  if (event.kind === "attempt_started" || event.kind === "terminal") {
    throw new Error("ASSISTANT_EVENT_NOT_RECORDABLE");
  }
  if (event.kind === "phase") {
    const expected = {
      persisted: "planning",
      planning: "reading",
      reading: "finalizing",
    } as const;
    if (expected[attempt.state as keyof typeof expected] !== event.phase) {
      throw new Error("ASSISTANT_EVENT_ORDER_INVALID");
    }
    return;
  }
  if (event.kind === "planner_completed" && attempt.state !== "planning") {
    throw new Error("ASSISTANT_EVENT_ORDER_INVALID");
  }
  if (
    (event.kind === "calendar_read_started" ||
      event.kind === "calendar_read_completed") &&
    attempt.state !== "reading"
  ) {
    throw new Error("ASSISTANT_EVENT_ORDER_INVALID");
  }
  if (event.kind === "finalizer_completed" && attempt.state !== "finalizing") {
    throw new Error("ASSISTANT_EVENT_ORDER_INVALID");
  }
  if (event.kind === "cancel") {
    const prior = previous?.event;
    const expectedPrior: Record<
      Exclude<CancellationMilestone, "requested">,
      readonly CancellationMilestone[]
    > = {
      native_cancel_sent: ["requested"],
      native_acknowledged: ["native_cancel_sent"],
      interrupt_sent: ["requested"],
      interrupt_acknowledged: ["interrupt_sent"],
      // A semantic terminal may arrive before the app-server returns native
      // identifiers. Likewise a rejected/timed-out interrupt can still be
      // followed by observed owned-process cleanup without an RPC ack.
      semantically_interrupted: [
        "requested",
        "interrupt_sent",
        "interrupt_acknowledged",
      ],
      completed_before_interrupt: [
        "requested",
        "interrupt_sent",
        "interrupt_acknowledged",
      ],
      owned_process_terminated: ["interrupt_sent", "interrupt_acknowledged"],
      outcome_unknown: [
        "interrupt_sent",
        "interrupt_acknowledged",
        "owned_process_terminated",
      ],
    };
    const expected =
      event.milestone === "requested"
        ? []
        : expectedPrior[event.milestone];
    if (
      (event.milestone === "requested" && attempt.cancelRequested) ||
      (event.milestone !== "requested" &&
        (prior?.kind !== "cancel" ||
          !expected.includes(prior.milestone)))
    ) {
      throw new Error("ASSISTANT_EVENT_ORDER_INVALID");
    }
  }
}

async function appendAttemptEvent(
  ctx: MutationCtx,
  attempt: Doc<"assistantAttempts">,
  eventId: string,
  event: AssistantAttemptEvent,
  createdAt: number,
  options: { allowTerminal?: boolean; allowAttemptStarted?: boolean } = {},
) {
  assertEventId(eventId);
  assertEventSafe(event);
  const existing = await attemptEventById(ctx, attempt.attemptId, eventId);
  if (existing) {
    if (!eventMatches(existing.event, event)) {
      throw new Error("ASSISTANT_EVENT_ID_CONFLICT");
    }
    return { sequence: existing.sequence, event: existing.event };
  }
  if (event.kind === "attempt_started" && !options.allowAttemptStarted) {
    throw new Error("ASSISTANT_EVENT_NOT_RECORDABLE");
  }
  if (event.kind === "terminal" && !options.allowTerminal) {
    throw new Error("ASSISTANT_EVENT_NOT_RECORDABLE");
  }
  if (event.kind !== "attempt_started" && event.kind !== "terminal") {
    assertAttemptEventOrder(attempt, event, await lastAttemptEvent(ctx, attempt.attemptId));
  }
  const previous = await lastAttemptEvent(ctx, attempt.attemptId);
  const sequence = attempt.nextEventSequence ?? (previous?.sequence ?? 0) + 1;
  await ctx.db.insert("assistantAttemptEvents", {
    attemptId: attempt.attemptId,
    sequence,
    eventId,
    event,
    createdAt,
  });
  await ctx.db.patch(attempt._id, { nextEventSequence: sequence + 1 });
  return { sequence, event };
}

async function recoverExpiredAttempt(
  ctx: MutationCtx,
  userId: string,
  assistantMessageId: Id<"assistantMessages">,
  nowMs: number,
): Promise<boolean> {
  const attempt = await ctx.db
    .query("assistantAttempts")
    .withIndex("by_assistantMessageId", (query) =>
      query.eq("assistantMessageId", assistantMessageId),
    )
    .unique();
  if (
    !attempt ||
    attempt.userId !== userId ||
    attempt.terminal ||
    attempt.leaseExpiresAt > nowMs
  ) {
    return false;
  }
  const message = await ctx.db.get(assistantMessageId);
  if (message?.status === "streaming") {
    await ctx.db.patch(message._id, {
      status: "error",
      error: "The previous assistant attempt has an unknown outcome.",
    });
  }
  await appendAttemptEvent(
    ctx,
    attempt,
    internalEventId("terminal"),
    {
      kind: "terminal",
      outcome: "outcome_unknown",
      failureCategory: "outcome_unknown",
    },
    nowMs,
    { allowTerminal: true },
  );
  await ctx.db.patch(attempt._id, {
    state: "outcome-unknown",
    terminal: true,
    settlementFingerprint: fingerprint("failure", {
      code: "outcome-unknown",
      message: "The previous assistant attempt has an unknown outcome.",
    }),
    failureCode: "outcome-unknown",
    updatedAt: nowMs,
    settledAt: nowMs,
  });
  await releaseAssistantTurn(
    ctx,
    attempt.assistantMessageId,
    attempt.threadId,
    nowMs,
  );
  return true;
}

function messageText(message: Doc<"assistantMessages">): string {
  return message.blocks
    .filter((block) => block.type === "text")
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("\n");
}

async function boundedSummary(
  ctx: QueryCtx,
  threadId: Id<"assistantThreads">,
  excludedIds: ReadonlySet<string> = new Set(),
): Promise<Array<{ role: "user" | "assistant"; text: string }>> {
  const rows = await ctx.db
    .query("assistantMessages")
    .withIndex("by_thread", (query) => query.eq("threadId", threadId))
    .order("desc")
    .take(MAX_SUMMARY_MESSAGES + excludedIds.size + 4);
  const result: Array<{ role: "user" | "assistant"; text: string }> = [];
  let totalBytes = 0;
  for (const row of rows) {
    if (excludedIds.has(row._id) || row.status !== "complete") continue;
    const text = truncateUtf8(messageText(row), MAX_SUMMARY_MESSAGE_BYTES);
    if (text.length === 0) continue;
    const textBytes = bytes(text);
    if (totalBytes + textBytes > MAX_SUMMARY_BYTES) break;
    result.push({ role: row.role, text });
    totalBytes += textBytes;
    if (result.length >= MAX_SUMMARY_MESSAGES) break;
  }
  return result.reverse();
}

async function selectedCalendars(ctx: QueryCtx, userId: string) {
  const rows = await ctx.db
    .query("calendars")
    .withIndex("by_user", (query) => query.eq("userId", userId))
    .filter((query) => query.eq(query.field("selected"), true))
    .take(MAX_SELECTED_CALENDARS + 1);
  if (rows.length > MAX_SELECTED_CALENDARS) {
    throw new Error("ASSISTANT_CALENDAR_SELECTION_TOO_LARGE");
  }
  for (const row of rows) {
    assertString(row.googleCalendarId, 256, "ASSISTANT_CALENDAR_ID_INVALID");
  }
  return rows.sort((left, right) =>
    left.googleCalendarId.localeCompare(right.googleCalendarId),
  );
}

export async function beginAttempt(
  ctx: MutationCtx,
  args: { attemptId: string; text: string; timeZone: string; nowMs: number },
) {
  const user = await requireDesktopBroker(ctx);
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(args.attemptId)) {
    throw new Error("ASSISTANT_ATTEMPT_ID_INVALID");
  }
  assertString(args.text, MAX_REQUEST_BYTES, "ASSISTANT_REQUEST_INVALID");
  assertString(
    args.timeZone,
    MAX_TIME_ZONE_BYTES,
    "ASSISTANT_TIME_ZONE_INVALID",
  );
  if (!Number.isFinite(args.nowMs)) throw new Error("ASSISTANT_NOW_INVALID");

  const existing = await attemptById(ctx, args.attemptId);
  if (existing) {
    if (existing.userId !== user.id)
      throw new Error("ASSISTANT_ATTEMPT_NOT_FOUND");
    const originalMessage = await ctx.db.get(existing.userMessageId);
    if (
      !originalMessage ||
      messageText(originalMessage) !== args.text ||
      existing.timeZone !== args.timeZone
    ) {
      throw new Error("ASSISTANT_ATTEMPT_ID_CONFLICT");
    }
    return {
      conversationId: existing.threadId,
      userMessageId: existing.userMessageId,
      assistantMessageId: existing.assistantMessageId,
      selectedCalendarIds: existing.selectedCalendarIds,
      summary: await boundedSummary(
        ctx,
        existing.threadId,
        new Set([existing.userMessageId, existing.assistantMessageId]),
      ),
    };
  }

  const calendars = await selectedCalendars(ctx, user.id);
  const selectedCalendarIds = calendars.map(
    (calendar) => calendar.googleCalendarId,
  );
  const activeState = await ctx.db
    .query("assistantUserState")
    .withIndex("by_user", (query) => query.eq("userId", user.id))
    .unique();
  if (activeState?.activeMessageId) {
    const activeMessage = await ctx.db.get(activeState.activeMessageId);
    if (
      activeMessage?.status === "streaming" &&
      !(await recoverExpiredAttempt(
        ctx,
        user.id,
        activeState.activeMessageId,
        args.nowMs,
      ))
    ) {
      throw new Error("ASSISTANT_BUSY");
    }
  }

  let thread = await ctx.db
    .query("assistantThreads")
    .withIndex("by_user_and_lastMessage", (query) =>
      query.eq("userId", user.id),
    )
    .order("desc")
    .first();
  if (thread?.activeMessageId) {
    const active = await ctx.db.get(thread.activeMessageId);
    if (
      active?.status === "streaming" &&
      !(await recoverExpiredAttempt(
        ctx,
        user.id,
        thread.activeMessageId,
        args.nowMs,
      ))
    ) {
      throw new Error("ASSISTANT_BUSY");
    }
    thread = await ctx.db.get(thread._id);
  }
  const threadId =
    thread?._id ??
    (await ctx.db.insert("assistantThreads", {
      userId: user.id,
      title: deriveAssistantTitle(args.text),
      createdAt: args.nowMs,
      lastMessageAt: args.nowMs,
    }));
  const summary = await boundedSummary(ctx, threadId);
  const userMessageId = await ctx.db.insert("assistantMessages", {
    threadId,
    userId: user.id,
    role: "user",
    blocks: [{ type: "text", text: args.text }],
    status: "complete",
    createdAt: args.nowMs,
  });
  const assistantMessageId = await ctx.db.insert("assistantMessages", {
    threadId,
    userId: user.id,
    role: "assistant",
    blocks: [],
    status: "streaming",
    createdAt: args.nowMs,
  });
  await ctx.db.patch(threadId, {
    activeMessageId: assistantMessageId,
    lastMessageAt: args.nowMs,
  });
  if (activeState) {
    await ctx.db.patch(activeState._id, {
      activeMessageId: assistantMessageId,
      activeThreadId: threadId,
      leaseExpiresAt: args.nowMs + ATTEMPT_LEASE_MS,
    });
  } else {
    await ctx.db.insert("assistantUserState", {
      userId: user.id,
      windowStartMs: args.nowMs,
      requestCount: 1,
      monthWindowStartMs: args.nowMs,
      monthCount: 1,
      activeMessageId: assistantMessageId,
      activeThreadId: threadId,
      leaseExpiresAt: args.nowMs + ATTEMPT_LEASE_MS,
    });
  }
  const attemptDocumentId = await ctx.db.insert("assistantAttempts", {
    attemptId: args.attemptId,
    userId: user.id,
    threadId,
    userMessageId,
    assistantMessageId,
    timeZone: args.timeZone,
    selectedCalendarIds,
    state: "persisted",
    terminal: false,
    nextEventSequence: 1,
    leaseExpiresAt: args.nowMs + ATTEMPT_LEASE_MS,
    createdAt: args.nowMs,
    updatedAt: args.nowMs,
  });
  const attempt = await ctx.db.get(attemptDocumentId);
  if (!attempt) throw new Error("ASSISTANT_ATTEMPT_NOT_FOUND");
  await appendAttemptEvent(
    ctx,
    attempt,
    internalEventId("attempt-started"),
    { kind: "attempt_started" },
    args.nowMs,
    { allowAttemptStarted: true },
  );
  return {
    conversationId: threadId,
    userMessageId,
    assistantMessageId,
    selectedCalendarIds,
    summary,
  };
}

function assertRead(read: AssistantCalendarRead): void {
  if (read.kind === "getEvent") return;
  if (
    !Number.isInteger(read.limit) ||
    read.limit < 1 ||
    read.limit > MAX_READ_RESULTS
  ) {
    throw new Error("ASSISTANT_READ_INVALID");
  }
  if (read.kind === "listCalendars") return;
  if (
    read.calendarIds !== undefined &&
    (read.calendarIds.length === 0 ||
      read.calendarIds.length > MAX_SELECTED_CALENDARS ||
      new Set(read.calendarIds).size !== read.calendarIds.length)
  ) {
    throw new Error("ASSISTANT_CALENDAR_NOT_AUTHORIZED");
  }
  if (read.kind === "searchEvents" && read.query !== undefined) {
    assertString(read.query, 500, "ASSISTANT_READ_INVALID");
  }
  if (
    !Number.isSafeInteger(read.startMs) ||
    !Number.isSafeInteger(read.endMs) ||
    read.endMs <= read.startMs ||
    read.endMs - read.startMs > MAX_RANGE_MS
  ) {
    throw new Error("ASSISTANT_READ_RANGE_INVALID");
  }
  if (read.kind === "getAvailability") {
    if (
      !Number.isInteger(read.durationMinutes) ||
      read.durationMinutes < 5 ||
      read.durationMinutes > 1_440
    ) {
      throw new Error("ASSISTANT_READ_INVALID");
    }
  }
}

function writableCalendar(calendar: Doc<"calendars">): boolean {
  return ["owner", "writer"].includes(calendar.accessRole ?? "");
}

async function authorizedCalendar(
  ctx: QueryCtx,
  userId: string,
  selectedCalendarIds: readonly string[],
  calendarId: string,
): Promise<Doc<"calendars">> {
  if (!selectedCalendarIds.includes(calendarId)) {
    throw new Error("ASSISTANT_CALENDAR_NOT_AUTHORIZED");
  }
  const calendar = await ctx.db
    .query("calendars")
    .withIndex("by_user_and_googleCalendarId", (query) =>
      query.eq("userId", userId).eq("googleCalendarId", calendarId),
    )
    .unique();
  if (!calendar?.selected) throw new Error("ASSISTANT_CALENDAR_NOT_AUTHORIZED");
  return calendar;
}

async function eventByOpaqueId(
  ctx: QueryCtx,
  userId: string,
  eventId: string,
): Promise<Doc<"events"> | null> {
  const byLocalId = await ctx.db
    .query("events")
    .withIndex("by_user_and_localEventId", (query) =>
      query.eq("userId", userId).eq("localEventId", eventId),
    )
    .unique();
  if (byLocalId) return byLocalId;
  const normalized = ctx.db.normalizeId("events", eventId);
  if (!normalized) return null;
  const byDocumentId = await ctx.db.get(normalized);
  return byDocumentId?.userId === userId ? byDocumentId : null;
}

function minimalEvent(
  event: Doc<"events">,
  writable: boolean,
  detailed = false,
) {
  const summary = event.summary?.trim();
  const attendees = event.attendees
    ?.map((attendee) => attendee.email.trim().toLowerCase())
    .filter(
      (email) =>
        bytes(email) <= MAX_ATTENDEE_BYTES &&
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email),
    )
    .slice(0, MAX_ATTENDEES)
    .sort();
  return {
    eventId: event.localEventId ?? event._id,
    calendarId: event.calendarId,
    ...(summary ? { summary: truncateUtf8(summary, MAX_TITLE_BYTES) } : {}),
    ...(!detailed || event.description === undefined
      ? {}
      : {
          description: truncateUtf8(event.description, MAX_DESCRIPTION_BYTES),
        }),
    ...(!detailed || event.location === undefined
      ? {}
      : { location: truncateUtf8(event.location, MAX_LOCATION_BYTES) }),
    startMs: event.startMs,
    endMs: event.endMs,
    allDay: event.allDay,
    ...(!detailed || attendees === undefined ? {} : { attendees }),
    updatedAt: event.googleUpdatedMs,
    writable,
  };
}

async function activeRevisionRows(
  ctx: QueryCtx,
  userId: string,
): Promise<Doc<"calendarOperations">[]> {
  const rows: Doc<"calendarOperations">[] = [];
  for (const state of REVISION_ACTIVE_STATES) {
    const stateRows = await ctx.db
      .query("calendarOperations")
      .withIndex("by_user_and_state_and_createdAt", (query) =>
        query.eq("userId", userId).eq("state", state),
      )
      .take(MAX_AGGREGATE_RESULTS + 1);
    rows.push(...stateRows);
    if (
      stateRows.length > MAX_AGGREGATE_RESULTS ||
      rows.length > MAX_AGGREGATE_RESULTS
    ) {
      throw new Error("ASSISTANT_REVISION_CONTEXT_TOO_LARGE");
    }
  }
  return rows.sort(
    (left, right) =>
      left.createdAt - right.createdAt ||
      (left.operationId ?? left.idempotencyKey).localeCompare(
        right.operationId ?? right.idempotencyKey,
      ),
  );
}

function revisionToken(prefix: "revision" | "series", value: unknown): string {
  return calendarOperationIdForIntent(`assistant-${prefix}`, value).replace(
    /^intent_/,
    `${prefix}_`,
  );
}

async function eventRevisionEvidence(
  ctx: QueryCtx,
  event: Doc<"events">,
  operationRows: readonly Doc<"calendarOperations">[],
  includeRecurrence: boolean,
) {
  const localEventId = event.localEventId ?? String(event._id);
  const operationChain = operationRows
    .filter((row) => row.localEventId === localEventId)
    .map((row) =>
      calendarOperationIdForIntent("assistant-operation-revision", {
        operationId: row.operationId,
        idempotencyKey: row.idempotencyKey,
        kind: row.kind,
        payload: row.payload,
        state: row.state,
        predecessorOperationId: row.predecessorOperationId,
        baseRemoteEtag: row.baseRemoteEtag,
        updatedAt: row.updatedAt,
      }),
    );
  const revision = revisionToken("revision", { event, operationChain });
  if (!event.recurringEventId) return { revision };
  const series = await ctx.db
    .query("recurringSeries")
    .withIndex("by_user_and_calendar_and_googleEventId", (query) =>
      query
        .eq("userId", event.userId)
        .eq("calendarId", event.calendarId)
        .eq("googleEventId", event.recurringEventId!),
    )
    .unique();
  if (!series) return { revision };
  return {
    revision,
    seriesRevision: revisionToken("series", series),
    ...(includeRecurrence
      ? {
          recurrence: series.recurrence
            .slice(0, MAX_RECURRENCE_LINES)
            .map((line) => truncateUtf8(line, MAX_RECURRENCE_LINE_BYTES)),
        }
      : {}),
  };
}

export async function readCalendar(
  ctx: QueryCtx,
  args: {
    attemptId: string;
    selectedCalendarIds: string[];
    reads: AssistantCalendarRead[];
  },
) {
  const user = await requireDesktopBroker(ctx);
  const attempt = await attemptById(ctx, args.attemptId);
  if (!attempt || attempt.userId !== user.id || attempt.terminal) {
    throw new Error("ASSISTANT_ATTEMPT_NOT_FOUND");
  }
  if (!sameStrings(args.selectedCalendarIds, attempt.selectedCalendarIds)) {
    throw new Error("ASSISTANT_CALENDAR_NOT_AUTHORIZED");
  }
  if (args.reads.length > MAX_READS)
    throw new Error("ASSISTANT_TOO_MANY_READS");
  const revisionRows = args.reads.some(
    (read) => read.kind === "searchEvents" || read.kind === "getEvent",
  )
    ? await activeRevisionRows(ctx, user.id)
    : [];
  const rows: Array<{ readIndex: number; kind: string; items: unknown[] }> = [];
  let aggregate = 0;
  for (let readIndex = 0; readIndex < args.reads.length; readIndex += 1) {
    const read = args.reads[readIndex]!;
    assertRead(read);
    let items: unknown[];
    if (read.kind === "listCalendars") {
      const calendars = await Promise.all(
        attempt.selectedCalendarIds
          .slice(0, read.limit)
          .map((calendarId) =>
            authorizedCalendar(
              ctx,
              user.id,
              attempt.selectedCalendarIds,
              calendarId,
            ),
          ),
      );
      items = calendars.map((calendar) => ({
        calendarId: calendar.googleCalendarId,
        ...(calendar.summary?.trim()
          ? { summary: truncateUtf8(calendar.summary.trim(), MAX_TITLE_BYTES) }
          : {}),
        selected: true,
        writable: writableCalendar(calendar),
        ...(calendar.timeZone === undefined || bytes(calendar.timeZone) > 256
          ? {}
          : { timeZone: calendar.timeZone }),
      }));
    } else if (read.kind === "getEvent") {
      const calendar = await authorizedCalendar(
        ctx,
        user.id,
        attempt.selectedCalendarIds,
        read.calendarId,
      );
      const event = await eventByOpaqueId(ctx, user.id, read.eventId);
      if (!event || event.calendarId !== read.calendarId) {
        throw new Error("ASSISTANT_EVENT_NOT_AUTHORIZED");
      }
      items = [
        {
          ...minimalEvent(event, writableCalendar(calendar), true),
          ...(await eventRevisionEvidence(ctx, event, revisionRows, true)),
        },
      ];
    } else {
      const ids = read.calendarIds ?? attempt.selectedCalendarIds;
      if (ids.length === 0 || ids.length > MAX_SELECTED_CALENDARS) {
        throw new Error("ASSISTANT_CALENDAR_NOT_AUTHORIZED");
      }
      const calendars = await Promise.all(
        ids.map((calendarId) =>
          authorizedCalendar(
            ctx,
            user.id,
            attempt.selectedCalendarIds,
            calendarId,
          ),
        ),
      );
      const eventItems: Array<
        ReturnType<typeof minimalEvent> & {
          revision?: string;
          seriesRevision?: string;
        }
      > = [];
      let scannedEvents = 0;
      for (const calendar of calendars) {
        const eventRows = await ctx.db
          .query("events")
          .withIndex("by_user_and_calendar_and_end", (query) =>
            query
              .eq("userId", user.id)
              .eq("calendarId", calendar.googleCalendarId)
              .gt("endMs", read.startMs),
          )
          .filter((query) =>
            query.and(
              query.lt(query.field("startMs"), read.endMs),
              query.neq(query.field("status"), "cancelled"),
            ),
          )
          .take(MAX_READ_RESULTS + 1);
        scannedEvents += eventRows.length;
        if (scannedEvents > MAX_READ_RESULTS) {
          throw new Error("ASSISTANT_READ_RESULT_TOO_LARGE");
        }
        for (const event of eventRows) {
          if (
            read.kind === "searchEvents" &&
            read.query !== undefined &&
            ![event.summary, event.description, event.location]
              .filter((value): value is string => typeof value === "string")
              .some((value) =>
                value.toLowerCase().includes(read.query!.toLowerCase()),
              )
          ) {
            continue;
          }
          eventItems.push({
            ...minimalEvent(event, writableCalendar(calendar)),
            ...(read.kind === "searchEvents"
              ? await eventRevisionEvidence(ctx, event, revisionRows, false)
              : {}),
          });
        }
      }
      eventItems.sort(
        (left, right) =>
          left.startMs - right.startMs ||
          left.eventId.localeCompare(right.eventId),
      );
      if (read.kind === "searchEvents") {
        items = eventItems.slice(0, read.limit);
      } else {
        const durationMs = read.durationMinutes * 60_000;
        const openings: Array<{ startMs: number; endMs: number }> = [];
        let cursor = read.startMs;
        for (const event of eventItems) {
          if (event.startMs - cursor >= durationMs) {
            openings.push({ startMs: cursor, endMs: event.startMs });
          }
          cursor = Math.max(cursor, event.endMs);
        }
        if (read.endMs - cursor >= durationMs) {
          openings.push({ startMs: cursor, endMs: read.endMs });
        }
        items = openings.slice(0, read.limit);
      }
    }
    aggregate += items.length;
    if (items.length > MAX_READ_RESULTS || aggregate > MAX_AGGREGATE_RESULTS) {
      throw new Error("ASSISTANT_READ_RESULT_TOO_LARGE");
    }
    rows.push({ readIndex, kind: read.kind, items });
  }
  const result = { rows };
  if (bytes(JSON.stringify(result)) > MAX_READ_CONTEXT_BYTES) {
    throw new Error("ASSISTANT_READ_CONTEXT_TOO_LARGE");
  }
  return result;
}

export async function listAttemptEvents(
  ctx: QueryCtx,
  args: { attemptId: string; afterSequence: number; limit: number },
) {
  const user = await requireDesktopBroker(ctx);
  if (!Number.isSafeInteger(args.afterSequence) || args.afterSequence < 0) {
    throw new Error("ASSISTANT_EVENT_CURSOR_INVALID");
  }
  if (
    !Number.isSafeInteger(args.limit) ||
    args.limit < 1 ||
    args.limit > MAX_ATTEMPT_EVENT_PAGE
  ) {
    throw new Error("ASSISTANT_EVENT_PAGE_INVALID");
  }
  const attempt = await attemptById(ctx, args.attemptId);
  if (!attempt || attempt.userId !== user.id)
    throw new Error("ASSISTANT_ATTEMPT_NOT_FOUND");
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
}

export async function recordProgress(
  ctx: MutationCtx,
  args: { attemptId: string; state: ProgressState },
) {
  const user = await requireDesktopBroker(ctx);
  const attempt = await attemptById(ctx, args.attemptId);
  if (!attempt || attempt.userId !== user.id)
    throw new Error("ASSISTANT_ATTEMPT_NOT_FOUND");
  if (attempt.terminal || attempt.cancelRequested)
    return { state: attempt.state };
  if (attempt.state === args.state) return { state: attempt.state };
  await appendAttemptEvent(
    ctx,
    attempt,
    internalEventId(`phase-${args.state}`),
    { kind: "phase", phase: args.state },
    Date.now(),
  );
  await ctx.db.patch(attempt._id, { state: args.state, updatedAt: Date.now() });
  return { state: args.state };
}

export async function recordEvent(
  ctx: MutationCtx,
  args: {
    attemptId: string;
    eventId: string;
    event: AssistantAttemptEvent;
  },
) {
  const user = await requireDesktopBroker(ctx);
  const attempt = await attemptById(ctx, args.attemptId);
  if (!attempt || attempt.userId !== user.id)
    throw new Error("ASSISTANT_ATTEMPT_NOT_FOUND");
  assertExternalEventId(args.eventId);
  const existing = await attemptEventById(ctx, attempt.attemptId, args.eventId);
  if (existing) {
    if (!eventMatches(existing.event, args.event)) {
      throw new Error("ASSISTANT_EVENT_ID_CONFLICT");
    }
    return { sequence: existing.sequence, event: existing.event };
  }
  if (attempt.terminal) throw new Error("ASSISTANT_ATTEMPT_ALREADY_SETTLED");
  const appended = await appendAttemptEvent(
    ctx,
    attempt,
    args.eventId,
    args.event,
    Date.now(),
  );
  if (appended.sequence !== attempt.nextEventSequence) return appended;
  if (args.event.kind === "phase") {
    await ctx.db.patch(attempt._id, {
      state: args.event.phase,
      updatedAt: Date.now(),
    });
  } else if (args.event.kind === "cancel" && args.event.milestone === "requested") {
    await ctx.db.patch(attempt._id, {
      state: "cancel-requested",
      cancelRequested: true,
      updatedAt: Date.now(),
    });
  }
  return appended;
}

export async function requestCancellation(
  ctx: MutationCtx,
  args: { attemptId: string },
) {
  const user = await requireDesktopBroker(ctx);
  const attempt = await attemptById(ctx, args.attemptId);
  if (!attempt || attempt.userId !== user.id)
    throw new Error("ASSISTANT_ATTEMPT_NOT_FOUND");
  if (attempt.terminal || attempt.cancelRequested) {
    return { state: attempt.state, terminal: attempt.terminal };
  }
  await appendAttemptEvent(
    ctx,
    attempt,
    internalEventId("cancel-requested"),
    { kind: "cancel", milestone: "requested" },
    Date.now(),
  );
  await ctx.db.patch(attempt._id, {
    state: "cancel-requested",
    cancelRequested: true,
    updatedAt: Date.now(),
  });
  return { state: "cancel-requested", terminal: false };
}

function fingerprint(kind: string, value: unknown): string {
  const serialized = JSON.stringify({ kind, value });
  if (bytes(serialized) > 64 * 1_024)
    throw new Error("ASSISTANT_SETTLEMENT_TOO_LARGE");
  return serialized;
}

async function terminalReceipt(
  attempt: Doc<"assistantAttempts">,
  expectedFingerprint: string,
) {
  if (!attempt.terminal) return null;
  if (attempt.settlementFingerprint !== expectedFingerprint) {
    throw new Error("ASSISTANT_ATTEMPT_ALREADY_SETTLED");
  }
  return {
    attemptId: attempt.attemptId,
    state: attempt.state,
    actionIds: attempt.actionIds ?? [],
  };
}

async function completedFinalizerMaySettleAfterCancellation(
  ctx: MutationCtx,
  attemptId: string,
): Promise<boolean> {
  const events = await ctx.db
    .query("assistantAttemptEvents")
    .withIndex("by_attemptId_and_sequence", (query) =>
      query.eq("attemptId", attemptId),
    )
    .collect();
  let finalizing = false;
  let completedBeforeInterrupt = false;
  for (const row of events) {
    if (row.event.kind === "phase" && row.event.phase === "finalizing") {
      finalizing = true;
    }
    if (
      row.event.kind === "cancel" &&
      row.event.milestone === "completed_before_interrupt"
    ) {
      completedBeforeInterrupt = true;
    }
  }
  return finalizing && completedBeforeInterrupt;
}

async function calendarAndEventForProposal(
  ctx: MutationCtx,
  attempt: Pick<Doc<"assistantAttempts">, "userId" | "selectedCalendarIds">,
  proposal: Exclude<AssistantProposal, { kind: "create" }>,
  revisionRows: readonly Doc<"calendarOperations">[],
) {
  const calendar = await authorizedCalendar(
    ctx,
    attempt.userId,
    attempt.selectedCalendarIds,
    proposal.calendarId,
  );
  if (!writableCalendar(calendar))
    throw new Error("ASSISTANT_PROPOSAL_NOT_AUTHORIZED");
  const event = await eventByOpaqueId(ctx, attempt.userId, proposal.eventId);
  if (!event || event.calendarId !== proposal.calendarId) {
    throw new Error("ASSISTANT_PROPOSAL_NOT_AUTHORIZED");
  }
  if (event.googleUpdatedMs !== proposal.expectedUpdatedAt) {
    throw new Error("ASSISTANT_PROPOSAL_STALE");
  }
  const evidence = await eventRevisionEvidence(
    ctx,
    event,
    revisionRows,
    false,
  );
  if (evidence.revision !== proposal.expectedRevision) {
    throw new Error("ASSISTANT_PROPOSAL_STALE");
  }
  if (
    event.recurringEventId !== undefined &&
    (!("seriesRevision" in evidence) ||
      evidence.seriesRevision !== proposal.expectedSeriesRevision)
  ) {
    throw new Error("ASSISTANT_PROPOSAL_STALE");
  }
  const capabilities = eventCapabilities(event, calendar);
  if (
    (proposal.kind === "update" && !capabilities.canEdit) ||
    (proposal.kind === "delete" &&
      !capabilities.canDelete &&
      !capabilities.canRemoveSelf) ||
    (proposal.kind === "update" &&
      proposal.changes.attendees !== undefined &&
      !capabilities.canInviteOthers) ||
    (proposal.kind === "update" &&
      proposal.changes.recurrence !== undefined &&
      !capabilities.canChangeRecurrence)
  ) {
    throw new Error("ASSISTANT_PROPOSAL_CAPABILITY_DENIED");
  }
  const recurring = event.recurringEventId !== undefined;
  if (!recurring && proposal.scope && proposal.scope !== "thisEvent") {
    throw new Error("ASSISTANT_PROPOSAL_SCOPE_INVALID");
  }
  if (recurring && proposal.kind === "update" && proposal.scope === undefined) {
    throw new Error("ASSISTANT_PROPOSAL_SCOPE_REQUIRED");
  }
  const organizer = capabilities.isOrganizer;
  if (
    !organizer &&
    ((proposal.scope !== undefined && proposal.scope !== "thisEvent") ||
      (proposal.kind === "update" &&
        (proposal.changes.attendees !== undefined ||
          proposal.changes.recurrence !== undefined)))
  ) {
    throw new Error("ASSISTANT_PROPOSAL_CAPABILITY_DENIED");
  }
  return { calendar, event };
}

function validateRange(range: EventRange): void {
  if (range.kind === "timed") {
    if (
      !Number.isSafeInteger(range.startMs) ||
      !Number.isSafeInteger(range.endMs) ||
      range.endMs <= range.startMs ||
      range.endMs - range.startMs > MAX_RANGE_MS
    ) {
      throw new Error("ASSISTANT_PROPOSAL_TIME_INVALID");
    }
    return;
  }
  const startMs = Date.parse(`${range.startDate}T00:00:00.000Z`);
  const endMs = Date.parse(`${range.endDate}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(range.startDate) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(range.endDate) ||
    !Number.isFinite(startMs) ||
    !Number.isFinite(endMs) ||
    new Date(startMs).toISOString().slice(0, 10) !== range.startDate ||
    new Date(endMs).toISOString().slice(0, 10) !== range.endDate ||
    endMs <= startMs ||
    endMs - startMs > MAX_RANGE_MS
  ) {
    throw new Error("ASSISTANT_PROPOSAL_TIME_INVALID");
  }
}

function validateRecurrence(recurrence: Recurrence): void {
  if (
    recurrence.frequency === "weekly" &&
    (!recurrence.weekdays || recurrence.weekdays.length === 0)
  ) {
    throw new Error("ASSISTANT_PROPOSAL_INVALID");
  }
  if (
    recurrence.interval !== undefined &&
    (!Number.isInteger(recurrence.interval) ||
      recurrence.interval < 1 ||
      recurrence.interval > 100)
  ) {
    throw new Error("ASSISTANT_PROPOSAL_INVALID");
  }
  if (
    recurrence.weekdays !== undefined &&
    (recurrence.frequency !== "weekly" ||
      recurrence.weekdays.length < 1 ||
      recurrence.weekdays.length > 7 ||
      new Set(recurrence.weekdays).size !== recurrence.weekdays.length ||
      recurrence.weekdays.some(
        (day) =>
          ![
            "monday",
            "tuesday",
            "wednesday",
            "thursday",
            "friday",
            "saturday",
            "sunday",
          ].includes(day),
      ))
  ) {
    throw new Error("ASSISTANT_PROPOSAL_INVALID");
  }
  if (recurrence.end?.kind === "count") {
    if (
      !Number.isInteger(recurrence.end.count) ||
      recurrence.end.count < 1 ||
      recurrence.end.count > 10_000
    ) {
      throw new Error("ASSISTANT_PROPOSAL_INVALID");
    }
  } else if (
    recurrence.end?.kind === "onDate" &&
    (!/^\d{4}-\d{2}-\d{2}$/.test(recurrence.end.date) ||
      !Number.isFinite(Date.parse(`${recurrence.end.date}T00:00:00.000Z`)) ||
      new Date(`${recurrence.end.date}T00:00:00.000Z`)
        .toISOString()
        .slice(0, 10) !== recurrence.end.date)
  ) {
    throw new Error("ASSISTANT_PROPOSAL_INVALID");
  }
  if (
    recurrence.sourceLines !== undefined &&
    recurrence.sourceLines.length > MAX_RECURRENCE_LINES
  ) {
    throw new Error("ASSISTANT_PROPOSAL_INVALID");
  }
  for (const line of recurrence.sourceLines ?? []) {
    assertString(line, MAX_RECURRENCE_LINE_BYTES, "ASSISTANT_PROPOSAL_INVALID");
  }
}

export function validateProposalShape(proposal: AssistantProposal): void {
  assertString(proposal.calendarId, 256, "ASSISTANT_PROPOSAL_INVALID");
  if (proposal.kind === "create") {
    assertString(
      proposal.summary,
      MAX_TITLE_BYTES,
      "ASSISTANT_PROPOSAL_INVALID",
    );
    validateRange(proposal.time);
    if (proposal.recurrence !== undefined)
      validateRecurrence(proposal.recurrence);
  } else {
    assertString(proposal.eventId, 256, "ASSISTANT_PROPOSAL_INVALID");
    if (!/^revision_[a-f0-9]{32}$/.test(proposal.expectedRevision)) {
      throw new Error("ASSISTANT_PROPOSAL_INVALID");
    }
    if (
      proposal.expectedSeriesRevision !== undefined &&
      !/^series_[a-f0-9]{32}$/.test(proposal.expectedSeriesRevision)
    ) {
      throw new Error("ASSISTANT_PROPOSAL_INVALID");
    }
    if (
      !Number.isFinite(proposal.expectedUpdatedAt) ||
      proposal.expectedUpdatedAt < 0
    ) {
      throw new Error("ASSISTANT_PROPOSAL_INVALID");
    }
    if (proposal.kind === "update") {
      if (
        Object.values(proposal.changes).every((value) => value === undefined)
      ) {
        throw new Error("ASSISTANT_PROPOSAL_INVALID");
      }
      if (proposal.changes.summary !== undefined)
        assertString(
          proposal.changes.summary,
          MAX_TITLE_BYTES,
          "ASSISTANT_PROPOSAL_INVALID",
        );
      if (proposal.changes.time !== undefined)
        validateRange(proposal.changes.time);
      if (proposal.changes.recurrence)
        validateRecurrence(proposal.changes.recurrence);
    }
  }
  const textValues =
    proposal.kind === "create"
      ? [proposal.description, proposal.location]
      : proposal.kind === "update"
        ? [proposal.changes.description, proposal.changes.location]
        : [];
  if (textValues[0] !== undefined)
    assertString(
      textValues[0],
      MAX_DESCRIPTION_BYTES,
      "ASSISTANT_PROPOSAL_INVALID",
      true,
    );
  if (textValues[1] !== undefined)
    assertString(
      textValues[1],
      MAX_LOCATION_BYTES,
      "ASSISTANT_PROPOSAL_INVALID",
      true,
    );
  const proposalAttendees =
    proposal.kind === "create"
      ? proposal.attendees
      : proposal.kind === "update"
        ? proposal.changes.attendees
        : undefined;
  if (proposalAttendees) {
    if (proposalAttendees.length > MAX_ATTENDEES)
      throw new Error("ASSISTANT_PROPOSAL_INVALID");
    for (const email of proposalAttendees) {
      assertString(email, MAX_ATTENDEE_BYTES, "ASSISTANT_PROPOSAL_INVALID");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
        throw new Error("ASSISTANT_PROPOSAL_INVALID");
      }
    }
  }
}

/** Revalidate a persisted proposal at the final local-write boundary. This is
 * intentionally in the same module as settlement validation so revision,
 * series, selection, and capability rules cannot drift. */
export async function revalidateAssistantProposal(
  ctx: MutationCtx,
  userId: string,
  proposal: AssistantProposal,
): Promise<{ event?: Doc<"events"> }> {
  validateProposalShape(proposal);
  const selected = await selectedCalendars(ctx, userId);
  const selectedCalendarIds = selected.map((row) => row.googleCalendarId);
  if (proposal.kind === "create") {
    const calendar = await authorizedCalendar(
      ctx,
      userId,
      selectedCalendarIds,
      proposal.calendarId,
    );
    if (!writableCalendar(calendar)) {
      throw new Error("ASSISTANT_PROPOSAL_NOT_AUTHORIZED");
    }
    return {};
  }
  const target = await calendarAndEventForProposal(
    ctx,
    { userId, selectedCalendarIds },
    proposal,
    await activeRevisionRows(ctx, userId),
  );
  return { event: target.event };
}

function proposalPreview(proposal: AssistantProposal): string {
  if (proposal.kind === "create") return `Create “${proposal.summary}”`;
  if (proposal.kind === "update")
    return `Update calendar event ${proposal.eventId}`;
  return `Delete calendar event ${proposal.eventId}`;
}

export async function settleSuccess(
  ctx: MutationCtx,
  args: { attemptId: string; markdown: string; proposals: AssistantProposal[] },
) {
  const user = await requireDesktopBroker(ctx);
  assertString(
    args.markdown,
    MAX_MARKDOWN_BYTES,
    "ASSISTANT_MARKDOWN_INVALID",
    true,
  );
  if (args.proposals.length > MAX_PROPOSALS)
    throw new Error("ASSISTANT_PROPOSALS_TOO_LARGE");
  const settlementFingerprint = fingerprint("success", {
    markdown: args.markdown,
    proposals: args.proposals,
  });
  const attempt = await attemptById(ctx, args.attemptId);
  if (!attempt || attempt.userId !== user.id)
    throw new Error("ASSISTANT_ATTEMPT_NOT_FOUND");
  const prior = await terminalReceipt(attempt, settlementFingerprint);
  if (prior) return prior;
  if (
    attempt.cancelRequested &&
    !(await completedFinalizerMaySettleAfterCancellation(ctx, attempt.attemptId))
  ) {
    throw new Error("ASSISTANT_CANCEL_REQUESTED");
  }

  const revisionRows = await activeRevisionRows(ctx, user.id);

  for (const proposal of args.proposals) {
    validateProposalShape(proposal);
    if (proposal.kind === "create") {
      const calendar = await authorizedCalendar(
        ctx,
        user.id,
        attempt.selectedCalendarIds,
        proposal.calendarId,
      );
      if (!writableCalendar(calendar))
        throw new Error("ASSISTANT_PROPOSAL_NOT_AUTHORIZED");
    } else {
      await calendarAndEventForProposal(ctx, attempt, proposal, revisionRows);
    }
  }

  const actionIds: Id<"assistantActions">[] = [];
  const blocks: Doc<"assistantMessages">["blocks"] = [
    { type: "text", text: args.markdown },
  ];
  for (let index = 0; index < args.proposals.length; index += 1) {
    const proposal = args.proposals[index]!;
    const toolCallId = `${args.attemptId}-${index}`;
    const actionId = await ctx.db.insert("assistantActions", {
      threadId: attempt.threadId,
      userId: user.id,
      toolCallId,
      tool: `${proposal.kind}_event`,
      input: JSON.stringify({ ...proposal, timeZone: attempt.timeZone }),
      preview: proposalPreview(proposal),
      operationId: crypto.randomUUID(),
      attemptCount: 0,
      status: "pending",
      createdAt: Date.now(),
    });
    actionIds.push(actionId);
    blocks.push({ type: "proposal", toolCallId, actionId });
  }
  const message = await ctx.db.get(attempt.assistantMessageId);
  if (message?.status !== "streaming")
    throw new Error("ASSISTANT_MESSAGE_NOT_ACTIVE");
  await appendAttemptEvent(
    ctx,
    attempt,
    internalEventId("terminal"),
    { kind: "terminal", outcome: "completed" },
    Date.now(),
    { allowTerminal: true },
  );
  await ctx.db.patch(message._id, { blocks, status: "complete" });
  await ctx.db.patch(attempt._id, {
    state: "completed",
    terminal: true,
    settlementFingerprint,
    actionIds,
    updatedAt: Date.now(),
    settledAt: Date.now(),
  });
  await releaseAssistantTurn(
    ctx,
    attempt.assistantMessageId,
    attempt.threadId,
    Date.now(),
  );
  return {
    attemptId: attempt.attemptId,
    state: "completed" as const,
    actionIds,
  };
}

export async function settleClarification(
  ctx: MutationCtx,
  args: { attemptId: string; question: string },
) {
  const user = await requireDesktopBroker(ctx);
  assertString(args.question, 1_000, "ASSISTANT_CLARIFICATION_INVALID");
  const settlementFingerprint = fingerprint("clarification", args.question);
  const attempt = await attemptById(ctx, args.attemptId);
  if (!attempt || attempt.userId !== user.id)
    throw new Error("ASSISTANT_ATTEMPT_NOT_FOUND");
  const prior = await terminalReceipt(attempt, settlementFingerprint);
  if (prior) return prior;
  if (attempt.cancelRequested) throw new Error("ASSISTANT_CANCEL_REQUESTED");
  const message = await ctx.db.get(attempt.assistantMessageId);
  if (message?.status !== "streaming")
    throw new Error("ASSISTANT_MESSAGE_NOT_ACTIVE");
  await appendAttemptEvent(
    ctx,
    attempt,
    internalEventId("clarification"),
    { kind: "clarification" },
    Date.now(),
  );
  await appendAttemptEvent(
    ctx,
    attempt,
    internalEventId("terminal"),
    { kind: "terminal", outcome: "clarification" },
    Date.now(),
    { allowTerminal: true },
  );
  await ctx.db.patch(message._id, {
    blocks: [{ type: "text", text: args.question }],
    status: "complete",
  });
  await ctx.db.patch(attempt._id, {
    state: "clarification",
    terminal: true,
    settlementFingerprint,
    updatedAt: Date.now(),
    settledAt: Date.now(),
  });
  await releaseAssistantTurn(
    ctx,
    attempt.assistantMessageId,
    attempt.threadId,
    Date.now(),
  );
  return {
    attemptId: attempt.attemptId,
    state: "clarification" as const,
    actionIds: [],
  };
}

export async function settleFailure(
  ctx: MutationCtx,
  args: { attemptId: string; code: string; message?: string },
) {
  const user = await requireDesktopBroker(ctx);
  assertString(args.code, 128, "ASSISTANT_FAILURE_INVALID");
  if (args.message !== undefined)
    assertString(args.message, 2_000, "ASSISTANT_FAILURE_INVALID", true);
  const attempt = await attemptById(ctx, args.attemptId);
  if (!attempt || attempt.userId !== user.id)
    throw new Error("ASSISTANT_ATTEMPT_NOT_FOUND");
  const effectiveFailure =
    args.code === "outcome-unknown"
      ? { code: "outcome-unknown", message: args.message }
      : attempt.cancelRequested
    ? {
        code: "cancelled",
        message: "The assistant attempt was cancelled.",
      }
    : { code: args.code, message: args.message };
  const settlementFingerprint = fingerprint("failure", effectiveFailure);
  const prior = await terminalReceipt(attempt, settlementFingerprint);
  if (prior) return prior;
  const state =
    effectiveFailure.code === "cancelled"
      ? "cancelled"
      : effectiveFailure.code === "outcome-unknown"
        ? "outcome-unknown"
        : "failed";
  const message = await ctx.db.get(attempt.assistantMessageId);
  if (message?.status !== "streaming")
    throw new Error("ASSISTANT_MESSAGE_NOT_ACTIVE");
  await appendAttemptEvent(
    ctx,
    attempt,
    internalEventId("terminal"),
    {
      kind: "terminal",
      outcome:
        state === "outcome-unknown"
          ? "outcome_unknown"
          : state === "cancelled"
            ? "cancelled"
            : "failed",
      ...(effectiveFailure.code === "outcome-unknown"
        ? { failureCategory: "outcome_unknown" as const }
        : {}),
    },
    Date.now(),
    { allowTerminal: true },
  );
  await ctx.db.patch(message._id, {
    status: "error",
    error: truncateUtf8(
      effectiveFailure.message ?? "The assistant attempt failed.",
      2_000,
    ),
  });
  await ctx.db.patch(attempt._id, {
    state,
    terminal: true,
    settlementFingerprint,
    failureCode: effectiveFailure.code,
    updatedAt: Date.now(),
    settledAt: Date.now(),
  });
  await releaseAssistantTurn(
    ctx,
    attempt.assistantMessageId,
    attempt.threadId,
    Date.now(),
  );
  return { attemptId: attempt.attemptId, state, actionIds: [] };
}
