import { v } from "convex/values";

/**
 * The event validators, owned by the calendar domain. They are declared here
 * (rather than in schema.ts) so both the schema and the action→mutation
 * boundaries that push a MappedEvent across can share one definition without a
 * circular import back through schema.ts. `googleEventValidator` is also imported
 * by googleSync (upsert page) and the calendar upsert mutation.
 */

/** A guest on an event. Mirrors the subset of Google's attendee object we keep;
 * `responseStatus` is "needsAction" | "declined" | "tentative" | "accepted".
 * Shared by the `events` table and the mutation validators that write to it. */
export const attendeeValidator = v.object({
  email: v.string(),
  displayName: v.optional(v.string()),
  responseStatus: v.optional(v.string()),
  organizer: v.optional(v.boolean()),
  self: v.optional(v.boolean()),
  optional: v.optional(v.boolean()),
});

/** A single person Google names on an event — its organizer or its creator.
 * Unlike an attendee this is not a guest list entry, so it carries no RSVP.
 * `self` is set by Google when the person is the calendar this copy lives on,
 * which makes it authoritative: never infer ownership by matching emails. */
export const personValidator = v.object({
  email: v.optional(v.string()),
  displayName: v.optional(v.string()),
  self: v.optional(v.boolean()),
});

export const calendarOperationStateValidator = v.union(
  v.literal("pending"),
  v.literal("syncing"),
  v.literal("succeeded"),
  v.literal("conflict"),
  v.literal("ambiguous"),
  v.literal("failed"),
  v.literal("cancelled"),
);

export const calendarSyncStateValidator = v.union(
  v.literal("synced"),
  calendarOperationStateValidator,
);

const recurrenceScopeValidator = v.union(
  v.literal("thisEvent"),
  v.literal("thisAndFollowing"),
  v.literal("allEvents"),
);

const operationAttendeeValidator = v.object({
  email: v.string(),
  displayName: v.optional(v.string()),
  responseStatus: v.optional(v.string()),
  optional: v.optional(v.boolean()),
  organizer: v.optional(v.boolean()),
  self: v.optional(v.boolean()),
});

const conferenceSnapshotValidator = v.object({
  type: v.optional(v.string()),
  name: v.optional(v.string()),
  url: v.optional(v.string()),
  requestId: v.optional(v.string()),
});

/** Provider-neutral confirmed baseline used by the local operation reducer. */
export const calendarEventSnapshotValidator = v.object({
  localEventId: v.string(),
  accountId: v.string(),
  calendarId: v.string(),
  providerCalendarId: v.optional(v.string()),
  remoteEventId: v.optional(v.string()),
  summary: v.optional(v.string()),
  description: v.optional(v.string()),
  location: v.optional(v.string()),
  startMs: v.number(),
  endMs: v.number(),
  allDay: v.boolean(),
  status: v.string(),
  timeZone: v.optional(v.string()),
  colorId: v.optional(v.string()),
  visibility: v.optional(v.string()),
  transparency: v.optional(v.string()),
  recurrence: v.optional(v.array(v.string())),
  recurrenceScope: v.optional(recurrenceScopeValidator),
  attendees: v.optional(v.array(operationAttendeeValidator)),
  responseStatus: v.optional(v.string()),
  conference: v.optional(v.union(conferenceSnapshotValidator, v.null())),
  conferenceUrl: v.optional(v.string()),
  conferenceName: v.optional(v.string()),
  conferenceType: v.optional(v.string()),
  hangoutLink: v.optional(v.string()),
});

export const calendarEventPatchValidator = v.object({
  summary: v.optional(v.union(v.string(), v.null())),
  description: v.optional(v.union(v.string(), v.null())),
  location: v.optional(v.union(v.string(), v.null())),
  startMs: v.optional(v.number()),
  endMs: v.optional(v.number()),
  allDay: v.optional(v.boolean()),
  status: v.optional(v.string()),
  timeZone: v.optional(v.union(v.string(), v.null())),
  colorId: v.optional(v.union(v.string(), v.null())),
  visibility: v.optional(v.union(v.string(), v.null())),
  transparency: v.optional(v.union(v.string(), v.null())),
  recurrence: v.optional(v.union(v.array(v.string()), v.null())),
  recurrenceScope: v.optional(recurrenceScopeValidator),
  attendees: v.optional(v.array(operationAttendeeValidator)),
  responseStatus: v.optional(v.string()),
  conference: v.optional(v.union(conferenceSnapshotValidator, v.null())),
  conferenceUrl: v.optional(v.union(v.string(), v.null())),
  conferenceName: v.optional(v.union(v.string(), v.null())),
  conferenceType: v.optional(v.union(v.string(), v.null())),
  hangoutLink: v.optional(v.union(v.string(), v.null())),
});

export const calendarOperationPayloadValidator = v.union(
  v.object({ event: calendarEventSnapshotValidator }),
  v.object({ patch: calendarEventPatchValidator }),
  v.object({
    destinationCalendarId: v.string(),
    destinationProviderCalendarId: v.optional(v.string()),
  }),
  v.object({
    responseStatus: v.union(
      v.literal("accepted"),
      v.literal("tentative"),
      v.literal("declined"),
    ),
  }),
  v.object({ recurrenceScope: v.optional(recurrenceScopeValidator) }),
);

/** One event exactly as Google gave it to us, after mapping. Shared by the
 * `events` table and by every action→mutation boundary that pushes a
 * MappedEvent across, so the shape is declared once and cannot drift. */
export const googleEventValidator = v.object({
  googleEventId: v.string(),
  calendarId: v.string(),
  summary: v.optional(v.string()),
  description: v.optional(v.string()),
  location: v.optional(v.string()),
  startMs: v.number(),
  endMs: v.number(),
  allDay: v.boolean(),
  status: v.string(),
  htmlLink: v.optional(v.string()),
  // Google's per-event color override ("1".."11"); absent means the event
  // inherits its calendar's color.
  colorId: v.optional(v.string()),
  // Google's `visibility`: "default" | "public" | "private" | "confidential".
  visibility: v.optional(v.string()),
  // Google's `transparency`: "opaque" (busy) | "transparent" (free).
  transparency: v.optional(v.string()),
  // Guests invited to the event, refreshed by every sync. See attendeeValidator.
  attendees: v.optional(v.array(attendeeValidator)),
  // Google set this when it withheld part of the guest list, so a short
  // `attendees` array is not proof that the list is short.
  attendeesOmitted: v.optional(v.boolean()),
  googleUpdatedMs: v.number(),

  // --- Who controls this event -------------------------------------------
  // `organizer.self` is the ownership test; `creator` differs when someone
  // scheduled on the organizer's behalf, and is only worth showing then.
  organizer: v.optional(personValidator),
  creator: v.optional(personValidator),
  // The three guest permissions. Each is tri-state on purpose: Google omits
  // them at their default, and the defaults disagree — absent guestsCanModify
  // means false, absent guestsCanInviteOthers/SeeOtherGuests mean true. Read
  // them only through lib/permissions.ts, which encodes that.
  guestsCanModify: v.optional(v.boolean()),
  guestsCanInviteOthers: v.optional(v.boolean()),
  guestsCanSeeOtherGuests: v.optional(v.boolean()),
  // Google forbids structural changes to a locked event, whoever you are.
  locked: v.optional(v.boolean()),
  // "default" | "birthday" | "outOfOffice" | "focusTime" | "workingLocation" |
  // "fromGmail". Several of these are generated by Google and reject edits even
  // on a calendar you own.
  eventType: v.optional(v.string()),
  // Set on an expanded instance of a recurring series (we sync with
  // singleEvents=true, so we only ever hold instances, never the master).
  recurringEventId: v.optional(v.string()),
  // The Google Meet URL, when the event has one.
  hangoutLink: v.optional(v.string()),
  // Provider-neutral conference metadata. Google Meet also remains available
  // through hangoutLink for existing create/edit behavior.
  conferenceUrl: v.optional(v.string()),
  conferenceName: v.optional(v.string()),
  conferenceType: v.optional(v.string()),
});

/** The stored row: everything Google told us, plus the local user it belongs
 * to. `userId` is ours alone — it never round-trips to Google. */
export const eventDocValidator = googleEventValidator.extend({
  userId: v.string(),
  localEventId: v.optional(v.string()),
  accountId: v.optional(v.string()),
  remoteSnapshot: v.optional(calendarEventSnapshotValidator),
  remoteEtag: v.optional(v.string()),
  remoteUpdatedAt: v.optional(v.number()),
  syncState: v.optional(calendarSyncStateValidator),
  // Monotonic per-calendar full-resync marker. A full resync stamps every
  // re-fetched row with a fresh generation, then deletes the rows still carrying
  // an older one — so the previous snapshot stays live for conflict
  // detection until the new one is fully written (see syncOneCalendar). Left
  // absent on incrementally-written rows; the next full resync re-stamps any that
  // still exist in Google, so absence never causes a wrongful sweep.
  syncGeneration: v.optional(v.number()),
  // Provider-neutral fields, dual-written alongside the Google-named columns
  // above during the connection-model migration and read with legacy fallback
  // until cutover. `providerEventId` mirrors `googleEventId`, `providerUpdatedMs`
  // mirrors `googleUpdatedMs`. Optional until backfilled. See Stage 5.
  connectionId: v.optional(v.id("calendarConnections")),
  providerEventId: v.optional(v.string()),
  providerUpdatedMs: v.optional(v.number()),
});
