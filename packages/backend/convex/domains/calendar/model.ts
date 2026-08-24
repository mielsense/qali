/**
 * Calendar domain model: the shared read helpers and the unified event view.
 * No Convex function wrappers here — those stay at the root facade `calendar.ts`.
 */

import type { Doc, Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import { isSharedPublicCalendar } from "../../lib/calendars";
import type {
  CalendarEventSnapshot,
  CalendarOperation,
} from "./operations";
import {
  MAX_EVENT_SPAN_MS,
  type RowBudget,
  spendRowBudget,
} from "../../lib/eventReads";

// The window is caller-supplied, so bound it: the widest legitimate view (a
// 7-month month-grid, see QUERY_SIDE_MONTHS on the client) is ~214 days, so 400
// days leaves headroom while stopping a forged range from scanning years of rows
// in one unpaginated read.
export const MAX_EVENT_RANGE_MS = 400 * 24 * 60 * 60 * 1000;

// Public calendars are small (a year of holidays is well under this), so a flat
// cap per calendar is enough to stay bounded without a density error.
export const ASSISTANT_SHARED_EVENT_LIMIT = 400;

function fnv1a(value: string, seed: number): string {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Deterministic local identity for a provider event. The provider ids remain
 * on the row and its unique lookup is checked before insertion; the two-seed
 * digest keeps this indexed identifier bounded even for unusually long ids. */
export function localEventIdForRemote(
  calendarId: string,
  remoteEventId: string,
): string {
  const input = `${calendarId}\0${remoteEventId}`;
  return `remote_${fnv1a(input, 0x811c9dc5)}${fnv1a(input, 0x9e3779b9)}`;
}

export function remoteSnapshotFromEvent(
  event: Readonly<{
    googleEventId: string;
    calendarId: string;
    summary?: string;
    description?: string;
    location?: string;
    startMs: number;
    endMs: number;
    allDay: boolean;
    status: string;
    colorId?: string;
    visibility?: string;
    transparency?: string;
    attendees?: Doc<"events">["attendees"];
    conferenceUrl?: string;
    conferenceName?: string;
    conferenceType?: string;
    hangoutLink?: string;
  }>,
  accountId: string,
  localEventId: string,
): CalendarEventSnapshot {
  return {
    localEventId,
    accountId,
    calendarId: event.calendarId,
    remoteEventId: event.googleEventId,
    ...(event.summary !== undefined ? { summary: event.summary } : {}),
    ...(event.description !== undefined ? { description: event.description } : {}),
    ...(event.location !== undefined ? { location: event.location } : {}),
    startMs: event.startMs,
    endMs: event.endMs,
    allDay: event.allDay,
    status: event.status,
    ...(event.colorId !== undefined ? { colorId: event.colorId } : {}),
    ...(event.visibility !== undefined ? { visibility: event.visibility } : {}),
    ...(event.transparency !== undefined
      ? { transparency: event.transparency }
      : {}),
    ...(event.attendees !== undefined
      ? {
          attendees: event.attendees.map((attendee) => ({
            email: attendee.email,
            ...(attendee.displayName !== undefined
              ? { displayName: attendee.displayName }
              : {}),
            ...(attendee.responseStatus !== undefined
              ? { responseStatus: attendee.responseStatus }
              : {}),
            ...(attendee.optional !== undefined
              ? { optional: attendee.optional }
              : {}),
            ...(attendee.organizer !== undefined
              ? { organizer: attendee.organizer }
              : {}),
            ...(attendee.self !== undefined ? { self: attendee.self } : {}),
          })),
        }
      : {}),
    ...(event.conferenceUrl !== undefined
      ? { conferenceUrl: event.conferenceUrl }
      : {}),
    ...(event.conferenceName !== undefined
      ? { conferenceName: event.conferenceName }
      : {}),
    ...(event.conferenceType !== undefined
      ? { conferenceType: event.conferenceType }
      : {}),
    ...(event.hangoutLink !== undefined
      ? { hangoutLink: event.hangoutLink }
      : {}),
  };
}

export function completeOperationFromRow(
  row: Doc<"calendarOperations">,
): CalendarOperation | null {
  if (
    !row.operationId ||
    !row.accountId ||
    !row.calendarId ||
    !row.localEventId ||
    !row.payload ||
    !row.state
  ) return null;
  return {
    operationId: row.operationId,
    accountId: row.accountId,
    calendarId: row.calendarId,
    localEventId: row.localEventId,
    remoteEventId: row.remoteEventId,
    kind: row.kind,
    payload: row.payload as CalendarOperation["payload"],
    baseRemoteSnapshot: row.baseRemoteSnapshot as CalendarEventSnapshot | undefined,
    baseRemoteEtag: row.baseRemoteEtag,
    uploadBaseRemoteSnapshot: row.uploadBaseRemoteSnapshot as
      | CalendarEventSnapshot
      | undefined,
    uploadBaseRemoteEtag: row.uploadBaseRemoteEtag,
    predecessorOperationId: row.predecessorOperationId,
    state: row.state,
    attemptCount: row.attemptCount ?? 0,
    leaseId: row.leaseId,
    leaseExpiresAt: row.leaseExpiresAt,
    leaseLeaderOperationId: row.leaseLeaderOperationId,
    retryAt: row.retryAt,
    safeError: row.safeError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Visible event namespaces. Personal calendars keep their collision-safe local
 * key; shared public caches are keyed by the raw provider calendar id.
 */
export async function selectedCalendarIds(
  ctx: QueryCtx,
  userId: string,
): Promise<Set<string>> {
  const calendars = await ctx.db
    .query("calendars")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  return new Set(
    calendars
      .filter((calendar) => calendar.selected)
      .map((calendar) => {
        const providerCalendarId =
          calendar.providerCalendarId ?? calendar.googleCalendarId;
        return isSharedPublicCalendar(providerCalendarId)
          ? providerCalendarId
          : calendar.googleCalendarId;
      }),
  );
}

/**
 * A calendar event as the client sees it: either a synced `events` row or a
 * public `sharedEvents` row (holidays, birthdays) presented in the same shape.
 *
 * The id is honestly the union of both tables rather than a cast to `Id<"events">`.
 * A shared row is read-only, so its `Id<"sharedEvents">` must never be handed to
 * an events-only mutation — the union makes the compiler enforce it. The read
 * queries that do accept a shared id already validate the union.
 */
export type EventView = Omit<Doc<"events">, "_id"> & {
  _id: Id<"events"> | Id<"sharedEvents">;
};

/** Present a shared (public-calendar) row in the unified {@link EventView} shape.
 * `sharedEvents` has every field `events` does except `userId` (stamped here to
 * the reader) and the id brand — so no cast is needed. */
export function sharedAsEvent(
  row: Doc<"sharedEvents">,
  userId: string,
): EventView {
  return { ...row, userId };
}

/** Selected public calendars' events overlapping [fromMs, toMs). These live once
 * in `sharedEvents` (not per-user), so we read them by calendar id and merge into
 * the caller's own events. Cancelled shared events are never stored.
 *
 * Ranged on `endMs` (not `startMs`) so a multi-day holiday that began before the
 * window is still returned; the far side is bounded by `MAX_EVENT_SPAN_MS` and the
 * combined row `budget` guards against a pathological range. */
export async function readSharedEventsInRange(
  ctx: QueryCtx,
  userId: string,
  publicCalendarIds: string[],
  fromMs: number,
  toMs: number,
  budget: RowBudget,
): Promise<EventView[]> {
  const spanEnd = toMs + MAX_EVENT_SPAN_MS;
  const out: EventView[] = [];
  for (const calendarId of publicCalendarIds) {
    const page = await ctx.db
      .query("sharedEvents")
      .withIndex("by_calendar_and_end", (q) =>
        q.eq("calendarId", calendarId).gt("endMs", fromMs).lte("endMs", spanEnd),
      )
      .take(budget.remaining + 1);
    spendRowBudget(budget, page.length);
    for (const r of page) {
      if (r.startMs < toMs) out.push(sharedAsEvent(r, userId));
    }
  }
  return out;
}

export { isSharedPublicCalendar };
