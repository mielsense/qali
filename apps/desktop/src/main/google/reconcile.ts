import type { GoogleEvent, GoogleEventWrite } from "./types";

export type RemoteEventSnapshot = Readonly<{
  localEventId: string;
  accountId: string;
  calendarId: string;
  /** Raw Google calendar id. Never use `calendarId` at the provider boundary. */
  providerCalendarId?: string;
  remoteEventId?: string;
  summary?: string;
  description?: string;
  location?: string;
  startMs: number;
  endMs: number;
  allDay: boolean;
  status: string;
  timeZone?: string;
  colorId?: string;
  visibility?: string;
  transparency?: string;
  recurrence?: string[];
  recurrenceScope?: "thisEvent" | "thisAndFollowing" | "allEvents";
  attendees?: Array<
    Readonly<{
      email: string;
      displayName?: string;
      responseStatus?: string;
      optional?: boolean;
      organizer?: boolean;
      self?: boolean;
    }>
  >;
  responseStatus?: string;
  conference?: Readonly<{
    type?: string;
    name?: string;
    url?: string;
    requestId?: string;
  }> | null;
  conferenceUrl?: string;
  conferenceName?: string;
  conferenceType?: string;
  hangoutLink?: string;
}>;

export type RemoteEventReceipt = Readonly<{
  remoteSnapshot: RemoteEventSnapshot;
  remoteEtag?: string;
  remoteUpdatedAt?: number;
}>;

const MAX_BACKOFF_MS = 5 * 60_000;
const BASE_BACKOFF_MS = 1_000;

export function backoffDelayMs(
  attemptCount: number,
  retryAfterMs: number | undefined,
  random: () => number = Math.random,
): number {
  const attempt = Math.max(1, Math.min(Math.trunc(attemptCount), 32));
  const exponential = Math.min(
    BASE_BACKOFF_MS * 2 ** (attempt - 1),
    MAX_BACKOFF_MS,
  );
  const randomValue = Math.min(1, Math.max(0, random()));
  const jittered = Math.round(exponential * (1 + randomValue * 0.25));
  return Math.min(MAX_BACKOFF_MS, Math.max(jittered, retryAfterMs ?? 0));
}

function defined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}

export function googleEventToRemoteSnapshot(
  event: GoogleEvent,
  scope: Readonly<{
    accountId: string;
    calendarId: string;
    providerCalendarId: string;
    localEventId: string;
  }>,
): RemoteEventReceipt {
  if (
    event.calendarId !== scope.providerCalendarId ||
    event.id.length === 0 ||
    event.startMs === undefined ||
    event.endMs === undefined ||
    event.allDay === undefined
  ) {
    throw new Error("GOOGLE_RECONCILIATION_SCOPE_INVALID");
  }
  const attendees = event.attendees
    ?.filter((attendee) => typeof attendee.email === "string")
    .map((attendee) =>
      defined({
        email: attendee.email!,
        displayName: attendee.displayName,
        responseStatus: attendee.responseStatus,
        optional: attendee.optional,
        organizer: attendee.organizer,
        self: attendee.self,
      }),
    );
  const remoteSnapshot = defined({
    localEventId: scope.localEventId,
    accountId: scope.accountId,
    calendarId: scope.calendarId,
    providerCalendarId: scope.providerCalendarId,
    remoteEventId: event.id,
    summary: event.summary,
    description: event.description,
    location: event.location,
    startMs: event.startMs,
    endMs: event.endMs,
    allDay: event.allDay,
    status: event.status,
    timeZone: event.start?.timeZone,
    colorId: event.colorId,
    visibility: event.visibility,
    transparency: event.transparency,
    recurrence: event.recurrence ? [...event.recurrence] : undefined,
    attendees,
    conferenceUrl: event.conferenceUrl,
    conferenceName: event.conferenceName,
    conferenceType: event.conferenceType,
    hangoutLink: event.hangoutLink,
  }) as RemoteEventSnapshot;
  return defined({
    remoteSnapshot,
    remoteEtag: event.etag,
    remoteUpdatedAt: event.updatedMs,
  });
}

export type RecurringTarget =
  | Readonly<{
      kind: "primitive";
      target: Readonly<{ calendarId: string; eventId: string }>;
    }>
  | Readonly<{
      kind: "split";
      master: Readonly<{ calendarId: string; eventId: string }>;
      splitAtMs: number;
    }>;

export function resolveRecurringTarget(
  args: Readonly<{
    calendarId: string;
    eventId: string;
    recurringEventId?: string;
    occurrenceStartMs?: number;
    scope?: "thisEvent" | "thisAndFollowing" | "allEvents";
  }>,
): RecurringTarget {
  const scope = args.scope ?? "thisEvent";
  if (scope === "thisEvent" || args.recurringEventId === undefined) {
    return {
      kind: "primitive",
      target: { calendarId: args.calendarId, eventId: args.eventId },
    };
  }
  if (scope === "allEvents") {
    return {
      kind: "primitive",
      target: {
        calendarId: args.calendarId,
        eventId: args.recurringEventId,
      },
    };
  }
  if (!Number.isFinite(args.occurrenceStartMs)) {
    throw new Error("GOOGLE_RECURRENCE_SPLIT_POINT_REQUIRED");
  }
  return {
    kind: "split",
    master: { calendarId: args.calendarId, eventId: args.recurringEventId },
    splitAtMs: args.occurrenceStartMs!,
  };
}

function untilTimestamp(splitAtMs: number): string {
  if (!Number.isFinite(splitAtMs)) {
    throw new Error("GOOGLE_RECURRENCE_SPLIT_POINT_REQUIRED");
  }
  return new Date(splitAtMs - 1_000)
    .toISOString()
    .replaceAll("-", "")
    .replaceAll(":", "")
    .replace(".000", "");
}

export function trimRecurrenceBefore(
  recurrence: readonly string[],
  splitAtMs: number,
): string[] {
  if (recurrence.length === 0 || recurrence.length > 64) {
    throw new Error("GOOGLE_RECURRENCE_RULE_REQUIRED");
  }
  let foundRule = false;
  const until = untilTimestamp(splitAtMs);
  const result = recurrence.map((line) => {
    if (!line.startsWith("RRULE:")) return line;
    foundRule = true;
    const parts = line
      .slice("RRULE:".length)
      .split(";")
      .filter(
        (part) => !part.startsWith("COUNT=") && !part.startsWith("UNTIL="),
      );
    return `RRULE:${parts.join(";")};UNTIL=${until}`;
  });
  if (!foundRule) throw new Error("GOOGLE_RECURRENCE_RULE_REQUIRED");
  return result;
}

export function futureRecurrence(recurrence: readonly string[]): string[] {
  return recurrence.map((line) => {
    if (!line.startsWith("RRULE:")) return line;
    return `RRULE:${line
      .slice("RRULE:".length)
      .split(";")
      .filter(
        (part) => !part.startsWith("COUNT=") && !part.startsWith("UNTIL="),
      )
      .join(";")}`;
  });
}

export function snapshotToGoogleWrite(
  snapshot: RemoteEventSnapshot,
): GoogleEventWrite {
  return defined({
    summary: snapshot.summary,
    description: snapshot.description,
    location: snapshot.location,
    startMs: snapshot.startMs,
    endMs: snapshot.endMs,
    allDay: snapshot.allDay,
    timeZone: snapshot.timeZone,
    colorId: snapshot.colorId,
    visibility: snapshot.visibility,
    transparency: snapshot.transparency,
    attendees: snapshot.attendees?.map((attendee) => ({ ...attendee })),
    recurrence: snapshot.recurrence,
    conference:
      snapshot.conference === null
        ? "remove"
        : snapshot.conference?.requestId
          ? "add"
          : undefined,
  });
}

export function eventMatchesWrite(
  event: GoogleEvent,
  write: GoogleEventWrite,
  conferenceRequestId?: string,
): boolean {
  const checks: Array<[unknown, unknown]> = [
    [write.summary, event.summary],
    [write.description, event.description],
    [write.location, event.location],
    [write.startMs, event.startMs],
    [write.endMs, event.endMs],
    [write.allDay, event.allDay],
    [write.colorId, event.colorId],
    [write.visibility, event.visibility],
    [write.transparency, event.transparency],
    [write.timeZone, event.start?.timeZone],
  ];
  if (
    !checks.every(
      ([expected, actual]) =>
        expected === undefined ||
        (expected === null ? actual === undefined : expected === actual),
    )
  ) {
    return false;
  }
  if (
    write.recurrence !== undefined &&
    (event.recurrence === undefined ||
      write.recurrence.length !== event.recurrence.length ||
      write.recurrence.some((rule, index) => rule !== event.recurrence![index]))
  ) {
    return false;
  }
  if (write.attendees !== undefined) {
    if (
      event.attendees === undefined ||
      write.attendees.length !== event.attendees.length
    ) {
      return false;
    }
    for (const expected of write.attendees) {
      const actual = event.attendees.find(
        (attendee) => attendee.email === expected.email,
      );
      if (
        !actual ||
        ["displayName", "responseStatus", "optional", "organizer", "self"].some(
          (field) =>
            expected[field as keyof typeof expected] !== undefined &&
            expected[field as keyof typeof expected] !==
              actual[field as keyof typeof actual],
        )
      ) {
        return false;
      }
    }
  }
  if (write.conference === "remove") {
    return (
      event.conferenceUrl === undefined &&
      event.hangoutLink === undefined &&
      event.conferenceName === undefined &&
      event.conferenceType === undefined &&
      event.conferenceCreateRequest === undefined
    );
  }
  if (write.conference === "add") {
    return (
      conferenceRequestId !== undefined &&
      event.conferenceCreateRequest?.requestId === conferenceRequestId
    );
  }
  return true;
}
