/** Write handlers for the calendar domain that stay on our side (no Google):
 * the visibility toggle and the optimistic-mirror internal mutations. Plain
 * functions; the root `calendar.ts` wraps each in a Convex mutation. */

import type { Infer } from "convex/values";
import {
  eventCapabilities,
  type EventCapabilities,
} from "@qali/domain/permissions";

import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { optionalLocalUser } from "../desktop/identity";
import { ensureGoogleConnection } from "./connections";
import {
  completeOperationFromRow,
  localEventIdForRemote,
  remoteSnapshotFromEvent,
} from "./model";
import { reducePendingOperations } from "./projection";
import {
  activeOperationRowsForEvent,
  enqueueCalendarOperation,
  type CalendarEventPatch,
  type CalendarEventSnapshot,
  type CalendarOperationPayload,
} from "./operations";
import { googleEventValidator } from "./validators";
import {
  calendarOperationIdForIntent,
  googleConferenceRequestIdForOperation,
  googleEventIdForOperation,
  localEventIdForOperation,
} from "../../lib/assistantLogic";
import type {
  CreateEventArgs,
  DeleteEventArgs,
  RespondToEventArgs,
  UpdateEventArgs,
  UpdateEventTimeArgs,
} from "./service";
import type { CalendarColorKey } from "./preferences";

/** Toggle whether a calendar's events appear on the grid. */
export async function setCalendarSelectedHandler(
  ctx: MutationCtx,
  args: { calendarId: Id<"calendars">; selected: boolean },
): Promise<null> {
  const user = await optionalLocalUser(ctx);
  if (!user) {
    throw new Error("Not authenticated");
  }
  const cal = await ctx.db.get(args.calendarId);
  if (!cal || cal.userId !== user.id) {
    throw new Error("Calendar not found");
  }
  await ctx.db.patch(args.calendarId, { selected: args.selected });
  return null;
}

/** Set or clear Qali's local display color without mutating Google. */
export async function setCalendarColorHandler(
  ctx: MutationCtx,
  args: {
    calendarId: Id<"calendars">;
    color: CalendarColorKey | null;
  },
): Promise<null> {
  const user = await optionalLocalUser(ctx);
  if (!user) {
    throw new Error("Not authenticated");
  }
  const cal = await ctx.db.get(args.calendarId);
  if (!cal || cal.userId !== user.id) {
    throw new Error("Calendar not found");
  }
  await ctx.db.patch(args.calendarId, {
    colorOverride: args.color ?? undefined,
  });
  return null;
}

/** Drop the local row as soon as Google accepts the delete, so the card leaves
 * the grid now rather than whenever the next sync happens to run. */
export async function deleteEventRowHandler(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    userId: string;
    calendarId?: string;
    recurringEventId?: string;
  },
): Promise<null> {
  const row = await ctx.db.get(args.eventId);
  if (row && row.userId === args.userId) {
    await ctx.db.delete(args.eventId);
  }
  if (args.recurringEventId) {
    const series = await ctx.db
      .query("recurringSeries")
      .withIndex("by_user_and_calendar_and_googleEventId", (q) =>
        q
          .eq("userId", args.userId)
          .eq("calendarId", args.calendarId ?? row?.calendarId ?? "")
          .eq("googleEventId", args.recurringEventId!),
      )
      .unique();
    if (series) await ctx.db.delete(series._id);
  }
  return null;
}

/** Mirror a single event into the synced table (optimistic update after create). */
export async function upsertEventHandler(
  ctx: MutationCtx,
  args: { userId: string; event: Infer<typeof googleEventValidator> },
): Promise<null> {
  // Resolve the calendar first: with multiple grants, provider rows are never
  // selected by whichever connection happens to sort first.
  const calendar = await ctx.db
    .query("calendars")
    .withIndex("by_user_and_googleCalendarId", (q) =>
      q
        .eq("userId", args.userId)
        .eq("googleCalendarId", args.event.calendarId),
    )
    .unique();
  const connectionId =
    calendar?.connectionId ??
    (await ensureGoogleConnection(ctx, args.userId, calendar?.accountId));
  const googleIdentityRow = await ctx.db
    .query("events")
    .withIndex("by_user_and_calendar_and_googleEventId", (q) =>
      q
        .eq("userId", args.userId)
        .eq("calendarId", args.event.calendarId)
        .eq("googleEventId", args.event.googleEventId),
    )
    .unique();
  // A local create is projected before Google acknowledges it. During that
  // window `googleEventId` is an internal placeholder, while
  // `providerEventId` already contains the deterministic id sent to Google.
  // Reconcile the first provider snapshot through that neutral identity or the
  // same logical event is rendered once as local and once as remote.
  const providerIdentityRows = await ctx.db
    .query("events")
    .withIndex("by_connection_and_providerEventId", (q) =>
      q
        .eq("connectionId", connectionId)
        .eq("providerEventId", args.event.googleEventId),
    )
    .take(3);
  if (providerIdentityRows.length > 2) {
    throw new Error("CALENDAR_PROVIDER_IDENTITY_CONFLICT");
  }
  const localProjectionRows = providerIdentityRows.filter(
    (row) => row._id !== googleIdentityRow?._id,
  );
  if (localProjectionRows.length > 1) {
    throw new Error("CALENDAR_PROVIDER_IDENTITY_CONFLICT");
  }
  const providerIdentityRow =
    localProjectionRows[0] ?? providerIdentityRows[0] ?? null;
  const existing = providerIdentityRow ?? googleIdentityRow;
  const historicalDuplicate =
    providerIdentityRow &&
    googleIdentityRow &&
    providerIdentityRow._id !== googleIdentityRow._id
      ? googleIdentityRow
      : null;
  const localEventId =
    existing?.localEventId ??
    localEventIdForRemote(args.event.calendarId, args.event.googleEventId);
  const accountId = calendar?.accountId ?? existing?.accountId ?? String(connectionId);
  const remoteSnapshot = {
    ...remoteSnapshotFromEvent(args.event, accountId, localEventId),
    ...(calendar?.providerCalendarId === undefined
      ? {}
      : { providerCalendarId: calendar.providerCalendarId }),
  };
  const operationRows = await activeOperationRowsForEvent(
    ctx,
    args.userId,
    localEventId,
  );
  const operations = operationRows.flatMap((row) => {
    const operation = completeOperationFromRow(row);
    return operation ? [operation] : [];
  });
  const projection = reducePendingOperations(remoteSnapshot, operations);
  if (projection === null) {
    if (existing) await ctx.db.delete(existing._id);
    if (historicalDuplicate) await ctx.db.delete(historicalDuplicate._id);
    return null;
  }
  const doc = {
    userId: args.userId,
    ...args.event,
    localEventId,
    accountId,
    connectionId,
    providerEventId: args.event.googleEventId,
    providerUpdatedMs: args.event.googleUpdatedMs,
    remoteSnapshot,
    remoteUpdatedAt: args.event.googleUpdatedMs,
    syncState: projection.syncState,
    calendarId: projection.calendarId,
    googleEventId: projection.remoteEventId ?? args.event.googleEventId,
    summary:
      typeof projection.summary === "string" ? projection.summary : undefined,
    description:
      typeof projection.description === "string"
        ? projection.description
        : undefined,
    location:
      typeof projection.location === "string" ? projection.location : undefined,
    startMs: projection.startMs,
    endMs: projection.endMs,
    allDay: projection.allDay,
    status: projection.status,
    colorId:
      typeof projection.colorId === "string" ? projection.colorId : undefined,
    visibility:
      typeof projection.visibility === "string"
        ? projection.visibility
        : undefined,
    transparency:
      typeof projection.transparency === "string"
        ? projection.transparency
        : undefined,
    attendees: projection.attendees?.map((attendee) => ({ ...attendee })),
    hangoutLink:
      typeof projection.hangoutLink === "string"
        ? projection.hangoutLink
        : undefined,
    conferenceUrl:
      typeof projection.conferenceUrl === "string"
        ? projection.conferenceUrl
        : undefined,
    conferenceName:
      typeof projection.conferenceName === "string"
        ? projection.conferenceName
        : undefined,
    conferenceType:
      typeof projection.conferenceType === "string"
        ? projection.conferenceType
        : undefined,
  };
  if (existing) {
    await ctx.db.replace(existing._id, doc);
  } else {
    await ctx.db.insert("events", doc);
  }
  // Versions affected by the old identity lookup may already contain both
  // rows. A fresh provider snapshot is authoritative and lets this mutation
  // repair the duplicate transactionally without touching operation history.
  if (historicalDuplicate) {
    await ctx.db.delete(historicalDuplicate._id);
  }
  return null;
}

/** Cache one recurring master's rule for all of its expanded instances. */
export async function upsertRecurringSeriesHandler(
  ctx: MutationCtx,
  args: {
    userId: string;
    calendarId: string;
    googleEventId: string;
    recurrence: string[];
    sourceUpdatedMs: number;
    replacedEventId?: Id<"events">;
  },
): Promise<null> {
  const existing = await ctx.db
    .query("recurringSeries")
    .withIndex("by_user_and_calendar_and_googleEventId", (q) =>
      q
        .eq("userId", args.userId)
        .eq("calendarId", args.calendarId)
        .eq("googleEventId", args.googleEventId),
    )
    .unique();
  // Dual-write the neutral mirror (connectionId + providerEventId) on both the
  // patch and insert paths, so incremental cache refreshes keep it current too.
  const calendar = await ctx.db
    .query("calendars")
    .withIndex("by_user_and_googleCalendarId", (q) =>
      q.eq("userId", args.userId).eq("googleCalendarId", args.calendarId),
    )
    .unique();
  const connectionId =
    calendar?.connectionId ??
    (await ensureGoogleConnection(ctx, args.userId, calendar?.accountId));
  const value = {
    recurrence: args.recurrence,
    sourceUpdatedMs: args.sourceUpdatedMs,
    connectionId,
    providerCalendarId: calendar?.providerCalendarId ?? args.calendarId,
    providerEventId: args.googleEventId,
  };
  if (existing) {
    await ctx.db.patch(existing._id, value);
  } else {
    await ctx.db.insert("recurringSeries", {
      userId: args.userId,
      calendarId: args.calendarId,
      googleEventId: args.googleEventId,
      ...value,
    });
  }
  if (args.replacedEventId) {
    const replaced = await ctx.db.get(args.replacedEventId);
    if (
      replaced?.userId === args.userId &&
      replaced.calendarId === args.calendarId &&
      replaced.googleEventId === args.googleEventId
    ) {
      await ctx.db.delete(args.replacedEventId);
    }
  }
  return null;
}

const WRITABLE_ACCESS_ROLES = new Set(["owner", "writer"]);

export type LocalAcceptedEvent = Readonly<{
  operationId: string;
  localEventId: string;
  googleEventId: string;
  providerEventId?: string;
  calendarId: string;
  summary?: string;
  description?: string;
  location?: string;
  startMs: number;
  endMs: number;
  allDay: boolean;
  status: string;
  googleUpdatedMs: number;
  syncState: "pending" | "syncing" | "conflict" | "ambiguous" | "failed";
}>;

export type LocalDeleteReceipt = Readonly<{
  operationId: string;
  localEventId: string;
  syncState: "pending";
  deleted: true;
}>;

type CalendarWriteScope = Readonly<{
  accountId: string;
  calendarId: string;
  connectionId: Id<"calendarConnections">;
}>;

function assertTimePair(
  startMs: number | undefined,
  endMs: number | undefined,
  required: boolean,
): void {
  if ((startMs === undefined) !== (endMs === undefined)) {
    throw new Error("Start and end must be provided together");
  }
  if (startMs === undefined || endMs === undefined) {
    if (required) throw new Error("Start and end are required");
    return;
  }
  if (
    !Number.isFinite(startMs) ||
    !Number.isFinite(endMs) ||
    endMs <= startMs
  ) {
    throw new Error("The event must end after it starts");
  }
}

async function writableCalendarScope(
  ctx: MutationCtx,
  userId: string,
  requestedCalendarId?: string,
): Promise<CalendarWriteScope> {
  const calendars = requestedCalendarId
    ? await ctx.db
        .query("calendars")
        .withIndex("by_user_and_googleCalendarId", (query) =>
          query
            .eq("userId", userId)
            .eq("googleCalendarId", requestedCalendarId),
        )
        .collect()
    : await ctx.db
        .query("calendars")
        .withIndex("by_user", (query) => query.eq("userId", userId))
        .collect();
  const calendar = requestedCalendarId
    ? calendars[0]
    : calendars.find((candidate) => candidate.primary === true);
  if (!calendar || calendar.userId !== userId) {
    throw new Error("CALENDAR_NOT_FOUND");
  }
  if (!WRITABLE_ACCESS_ROLES.has(calendar.accessRole ?? "")) {
    throw new Error("CALENDAR_READ_ONLY");
  }
  const connectionId =
    calendar.connectionId ??
    (await ensureGoogleConnection(ctx, userId, calendar.accountId));
  const accountId = calendar.accountId ?? String(connectionId);
  if (!accountId || !calendar.googleCalendarId) {
    throw new Error("CALENDAR_IDENTITY_INVALID");
  }
  if (
    calendar.connectionId !== connectionId ||
    calendar.accountId !== accountId ||
    calendar.providerCalendarId === undefined
  ) {
    await ctx.db.patch(calendar._id, {
      connectionId,
      accountId,
      providerCalendarId: calendar.googleCalendarId,
    });
  }
  return {
    accountId,
    calendarId: calendar.googleCalendarId,
    connectionId,
  };
}

function eventCapabilityError(
  capabilities: EventCapabilities,
  allowed: Array<"canEdit" | "canRespond" | "canDelete" | "canRemoveSelf">,
): string | undefined {
  if (allowed.some((capability) => capabilities[capability])) return undefined;
  if (allowed[0] === "canEdit") {
    return capabilities.readOnlyReason ?? "You can't edit this event";
  }
  if (allowed[0] === "canRespond") return "You're not a guest on this event";
  if (allowed[0] === "canDelete") return "You can't delete this event";
  return "You can't remove this event";
}

type WritableEvent = Readonly<{
  row: Doc<"events">;
  scope: CalendarWriteScope;
  localEventId: string;
  remoteEventId?: string;
  baseline?: CalendarEventSnapshot;
  baseRemoteEtag?: string;
  capabilities: EventCapabilities;
}>;

async function writableEvent(
  ctx: MutationCtx,
  userId: string,
  eventId: Id<"events">,
  allowed: Array<"canEdit" | "canRespond" | "canDelete" | "canRemoveSelf">,
): Promise<WritableEvent> {
  const row = await ctx.db.get(eventId);
  if (!row || row.userId !== userId) throw new Error("Event not found");
  const scope = await writableCalendarScope(ctx, userId, row.calendarId);
  const calendar = await ctx.db
    .query("calendars")
    .withIndex("by_user_and_googleCalendarId", (query) =>
      query.eq("userId", userId).eq("googleCalendarId", row.calendarId),
    )
    .unique();
  const capabilities = eventCapabilities(row, calendar ?? undefined);
  const denial = eventCapabilityError(capabilities, allowed);
  if (denial) throw new Error(denial);

  const localEventId =
    row.localEventId ??
    localEventIdForRemote(row.calendarId, row.googleEventId);
  const accountId = row.accountId ?? scope.accountId;
  if (accountId !== scope.accountId)
    throw new Error("CALENDAR_ACCOUNT_MISMATCH");

  let baseline = row.remoteSnapshot as CalendarEventSnapshot | undefined;
  let baseRemoteEtag = row.remoteEtag;
  const isUnsynchronizedLocalCreate =
    baseline === undefined &&
    row.localEventId !== undefined &&
    row.accountId !== undefined &&
    row.syncState !== undefined &&
    row.syncState !== "synced";
  if (!baseline && !isUnsynchronizedLocalCreate) {
    if (!baseRemoteEtag) throw new Error("CALENDAR_BASELINE_REQUIRED");
    baseline = remoteSnapshotFromEvent(row, accountId, localEventId);
  }
  if (baseline && !baseRemoteEtag) {
    throw new Error("CALENDAR_BASELINE_REQUIRED");
  }
  const remoteEventId = baseline?.remoteEventId;
  if (baseline && (!remoteEventId || baseline.accountId !== accountId)) {
    throw new Error("CALENDAR_IDENTITY_INVALID");
  }
  if (
    row.localEventId !== localEventId ||
    row.accountId !== accountId ||
    row.connectionId !== scope.connectionId ||
    (baseline !== undefined && row.remoteSnapshot === undefined)
  ) {
    await ctx.db.patch(row._id, {
      localEventId,
      accountId,
      connectionId: scope.connectionId,
      ...(baseline !== undefined ? { remoteSnapshot: baseline } : {}),
    });
  }
  return {
    row,
    scope,
    localEventId,
    remoteEventId,
    baseline,
    baseRemoteEtag,
    capabilities,
  };
}

async function acceptedEvent(
  ctx: MutationCtx,
  userId: string,
  localEventId: string,
  operationId: string,
  providerEventId?: string,
  connectionId?: Id<"calendarConnections">,
): Promise<LocalAcceptedEvent> {
  const row = await ctx.db
    .query("events")
    .withIndex("by_user_and_localEventId", (query) =>
      query.eq("userId", userId).eq("localEventId", localEventId),
    )
    .unique();
  if (
    !row ||
    !row.syncState ||
    row.syncState === "synced" ||
    row.syncState === "succeeded" ||
    row.syncState === "cancelled"
  ) {
    throw new Error("CALENDAR_LOCAL_PROJECTION_MISSING");
  }
  if (
    (providerEventId !== undefined &&
      row.providerEventId !== providerEventId) ||
    (connectionId !== undefined && row.connectionId !== connectionId)
  ) {
    await ctx.db.patch(row._id, {
      ...(providerEventId !== undefined ? { providerEventId } : {}),
      ...(connectionId !== undefined ? { connectionId } : {}),
    });
  }
  return {
    operationId,
    localEventId,
    googleEventId: row.googleEventId,
    ...(providerEventId !== undefined ? { providerEventId } : {}),
    calendarId: row.calendarId,
    ...(row.summary !== undefined ? { summary: row.summary } : {}),
    ...(row.description !== undefined ? { description: row.description } : {}),
    ...(row.location !== undefined ? { location: row.location } : {}),
    startMs: row.startMs,
    endMs: row.endMs,
    allDay: row.allDay,
    status: row.status,
    googleUpdatedMs: row.googleUpdatedMs,
    syncState: row.syncState,
  };
}

export async function acceptCreateEventHandler(
  ctx: MutationCtx,
  args: CreateEventArgs & { userId: string; operationId: string },
): Promise<LocalAcceptedEvent> {
  assertTimePair(args.startMs, args.endMs, true);
  if (args.recurrence?.length === 0) {
    throw new Error("A recurring event needs a recurrence rule");
  }
  const scope = await writableCalendarScope(ctx, args.userId, args.calendarId);
  const localEventId = localEventIdForOperation(args.operationId);
  const providerEventId = googleEventIdForOperation(args.operationId);
  const allDay = args.allDay ?? false;
  const event: CalendarEventSnapshot = {
    localEventId,
    accountId: scope.accountId,
    calendarId: scope.calendarId,
    summary: args.summary,
    ...(args.description !== undefined
      ? { description: args.description }
      : {}),
    ...(args.location !== undefined ? { location: args.location } : {}),
    startMs: args.startMs,
    endMs: args.endMs,
    allDay,
    status: "confirmed",
    ...(args.timeZone !== undefined ? { timeZone: args.timeZone } : {}),
    ...(args.colorId !== undefined ? { colorId: args.colorId } : {}),
    ...(args.visibility !== undefined ? { visibility: args.visibility } : {}),
    ...(args.transparency !== undefined
      ? { transparency: args.transparency }
      : {}),
    ...(args.recurrence !== undefined
      ? { recurrence: args.recurrence, recurrenceScope: "allEvents" as const }
      : {}),
    ...(args.attendees !== undefined
      ? { attendees: args.attendees.map((attendee) => ({ ...attendee })) }
      : {}),
    ...(args.addConference
      ? {
          conference: {
            type: "hangoutsMeet",
            requestId: googleConferenceRequestIdForOperation(args.operationId),
          },
        }
      : {}),
  };
  await enqueueCalendarOperation(ctx, args.userId, {
    operationId: args.operationId,
    accountId: scope.accountId,
    calendarId: scope.calendarId,
    localEventId,
    kind: "create",
    payload: { event },
  });
  return acceptedEvent(
    ctx,
    args.userId,
    localEventId,
    args.operationId,
    providerEventId,
    scope.connectionId,
  );
}

function baseCommand(event: WritableEvent, operationId: string) {
  return {
    operationId,
    accountId: event.scope.accountId,
    calendarId: event.scope.calendarId,
    localEventId: event.localEventId,
    ...(event.remoteEventId !== undefined
      ? { remoteEventId: event.remoteEventId }
      : {}),
    ...(event.baseline !== undefined
      ? { baseRemoteSnapshot: event.baseline }
      : {}),
    ...(event.baseRemoteEtag !== undefined
      ? { baseRemoteEtag: event.baseRemoteEtag }
      : {}),
  };
}

type SnapshotAttendee = NonNullable<CalendarEventSnapshot["attendees"]>[number];

/** A public guest-list edit is a replacement for ordinary guests, but never a
 * license to erase the synced self/organizer markers used for write authority.
 * Requested attendees inherit their synced metadata unless explicitly edited. */
function mergeProjectedAttendees(
  current: readonly SnapshotAttendee[],
  requested: readonly SnapshotAttendee[],
): SnapshotAttendee[] {
  const currentByEmail = new Map(
    current.map((attendee) => [attendee.email.toLowerCase(), attendee]),
  );
  const requestedByEmail = new Map(
    requested.map((attendee) => [attendee.email.toLowerCase(), attendee]),
  );
  const result: SnapshotAttendee[] = [];
  const included = new Set<string>();

  for (const attendee of current) {
    if (!attendee.self && !attendee.organizer) continue;
    const key = attendee.email.toLowerCase();
    const replacement = requestedByEmail.get(key);
    result.push({
      ...attendee,
      ...replacement,
      ...(attendee.organizer !== undefined
        ? { organizer: attendee.organizer }
        : {}),
      ...(attendee.self !== undefined ? { self: attendee.self } : {}),
    });
    included.add(key);
  }

  for (const attendee of requested) {
    const key = attendee.email.toLowerCase();
    if (included.has(key)) continue;
    const existing = currentByEmail.get(key);
    result.push({ ...existing, ...attendee });
    included.add(key);
  }
  return result;
}

export async function acceptUpdateEventTimeHandler(
  ctx: MutationCtx,
  args: UpdateEventTimeArgs & { userId: string },
): Promise<LocalAcceptedEvent> {
  assertTimePair(args.startMs, args.endMs, true);
  const event = await writableEvent(ctx, args.userId, args.eventId, [
    "canEdit",
  ]);
  const operationId =
    args.operationId ??
    calendarOperationIdForIntent("calendar.update-time", {
      userId: args.userId,
      accountId: event.scope.accountId,
      calendarId: event.scope.calendarId,
      localEventId: event.localEventId,
      baseRemoteEtag: event.baseRemoteEtag ?? null,
      startMs: args.startMs,
      endMs: args.endMs,
      timeZone: args.timeZone ?? null,
    });
  await enqueueCalendarOperation(ctx, args.userId, {
    ...baseCommand(event, operationId),
    kind: "update",
    payload: {
      patch: {
        startMs: args.startMs,
        endMs: args.endMs,
        ...(args.timeZone !== undefined ? { timeZone: args.timeZone } : {}),
        ...(event.row.recurringEventId
          ? { recurrenceScope: "thisEvent" as const }
          : {}),
      },
    },
  });
  return acceptedEvent(ctx, args.userId, event.localEventId, operationId);
}

export async function acceptUpdateEventHandler(
  ctx: MutationCtx,
  args: Omit<UpdateEventArgs, "attendees" | "recurrence"> & {
    userId: string;
    operationId: string;
    attendees?: SnapshotAttendee[];
    recurrence?: string[] | null;
  },
): Promise<LocalAcceptedEvent> {
  assertTimePair(args.startMs, args.endMs, false);
  const event = await writableEvent(ctx, args.userId, args.eventId, [
    "canEdit",
  ]);
  if (
    args.expectedGoogleUpdatedMs !== undefined &&
    event.row.googleUpdatedMs !== args.expectedGoogleUpdatedMs
  ) {
    throw new Error(
      "The event changed after this proposal was made. Please propose it again.",
    );
  }
  if (args.recurrence !== undefined && args.recurrence !== null) {
    if (args.recurrence.length === 0) {
      throw new Error("A recurring event needs a recurrence rule");
    }
    if (!event.capabilities.canChangeRecurrence) {
      throw new Error("This event is already part of a recurring series");
    }
  }
  if (args.attendees !== undefined && !event.capabilities.canInviteOthers) {
    throw new Error(
      "The organiser does not allow you to invite or remove guests",
    );
  }
  if (
    args.expectedSeriesUpdatedMs !== undefined &&
    event.row.recurringEventId
  ) {
    const series = await ctx.db
      .query("recurringSeries")
      .withIndex("by_user_and_calendar_and_googleEventId", (query) =>
        query
          .eq("userId", args.userId)
          .eq("calendarId", event.row.calendarId)
          .eq("googleEventId", event.row.recurringEventId!),
      )
      .unique();
    if (!series || series.sourceUpdatedMs !== args.expectedSeriesUpdatedMs) {
      throw new Error(
        "The recurring series changed after this proposal was made. Please propose it again.",
      );
    }
  }
  const recurrenceScope = event.row.recurringEventId
    ? (args.scope ?? "thisEvent")
    : args.recurrence !== undefined
      ? "allEvents"
      : undefined;
  const patch = Object.fromEntries(
    Object.entries({
      summary: args.summary,
      description: args.description,
      location: args.location,
      colorId: args.colorId,
      visibility: args.visibility,
      transparency: args.transparency,
      startMs: args.startMs,
      endMs: args.endMs,
      allDay: args.allDay,
      attendees:
        args.attendees === undefined
          ? undefined
          : mergeProjectedAttendees(
              event.row.attendees ?? event.baseline?.attendees ?? [],
              args.attendees,
            ),
      recurrence: args.recurrence,
      timeZone: args.timeZone,
      recurrenceScope,
      conference:
        args.conference === undefined
          ? undefined
          : args.conference === null
            ? null
            : {
                type: "hangoutsMeet",
                requestId: googleConferenceRequestIdForOperation(
                  args.operationId,
                ),
              },
    }).filter(([, value]) => value !== undefined),
  ) as CalendarEventPatch;
  await enqueueCalendarOperation(ctx, args.userId, {
    ...baseCommand(event, args.operationId),
    kind: "update",
    payload: { patch } as CalendarOperationPayload,
  });
  return acceptedEvent(ctx, args.userId, event.localEventId, args.operationId);
}

export async function acceptRespondToEventHandler(
  ctx: MutationCtx,
  args: RespondToEventArgs & { userId: string },
): Promise<LocalAcceptedEvent> {
  const event = await writableEvent(ctx, args.userId, args.eventId, [
    "canRespond",
  ]);
  const operationId =
    args.operationId ??
    calendarOperationIdForIntent("calendar.respond", {
      userId: args.userId,
      accountId: event.scope.accountId,
      calendarId: event.scope.calendarId,
      localEventId: event.localEventId,
      baseRemoteEtag: event.baseRemoteEtag ?? null,
      responseStatus: args.responseStatus,
    });
  await enqueueCalendarOperation(ctx, args.userId, {
    ...baseCommand(event, operationId),
    kind: "respond",
    payload: { responseStatus: args.responseStatus },
  });
  return acceptedEvent(ctx, args.userId, event.localEventId, operationId);
}

export async function acceptDeleteEventHandler(
  ctx: MutationCtx,
  args: DeleteEventArgs & { userId: string; operationId: string },
): Promise<LocalDeleteReceipt> {
  const event = await writableEvent(ctx, args.userId, args.eventId, [
    "canDelete",
    "canRemoveSelf",
  ]);
  const recurrenceScope = event.row.recurringEventId
    ? (args.scope ?? "thisEvent")
    : undefined;
  if (
    recurrenceScope === "thisAndFollowing" &&
    !event.capabilities.isOrganizer
  ) {
    throw new Error(
      "Only the organizer can remove this and following events from the series",
    );
  }
  if (
    recurrenceScope === "thisAndFollowing" &&
    args.expectedSeriesUpdatedMs !== undefined
  ) {
    const series = await ctx.db
      .query("recurringSeries")
      .withIndex("by_user_and_calendar_and_googleEventId", (query) =>
        query
          .eq("userId", args.userId)
          .eq("calendarId", event.row.calendarId)
          .eq("googleEventId", event.row.recurringEventId!),
      )
      .unique();
    if (!series || series.sourceUpdatedMs !== args.expectedSeriesUpdatedMs) {
      throw new Error(
        "The recurring series changed after this proposal was made. Please propose it again.",
      );
    }
  }
  await enqueueCalendarOperation(ctx, args.userId, {
    ...baseCommand(event, args.operationId),
    kind: "delete",
    payload: (recurrenceScope
      ? { recurrenceScope }
      : {}) as CalendarOperationPayload,
  });
  return {
    operationId: args.operationId,
    localEventId: event.localEventId,
    syncState: "pending",
    deleted: true,
  };
}
