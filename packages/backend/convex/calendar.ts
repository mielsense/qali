/**
 * Stable public facade for the calendar domain. The logic lives in
 * `domains/calendar/`; this file keeps every `api.calendar.*` /
 * `internal.calendar.*` path and argument shape fixed.
 */

import { v } from "convex/values";

import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import {
  acceptCreateEventHandler,
  acceptDeleteEventHandler,
  acceptRespondToEventHandler,
  acceptUpdateEventHandler,
  acceptUpdateEventTimeHandler,
  deleteEventRowHandler,
  setCalendarColorHandler,
  setCalendarSelectedHandler,
  upsertEventHandler,
  upsertRecurringSeriesHandler,
} from "./domains/calendar/mutations";
import {
  getEventByIdHandler,
  getEventContextHandler,
  getEventRecurrenceHandler,
  getPrimaryCalendarIdHandler,
  listCalendarsHandler,
  listEventsHandler,
  listEventsInRangeHandler,
  listSharedEventsForAssistantHandler,
} from "./domains/calendar/queries";
import {
  createEventHandler,
  deleteEventHandler,
  refreshEventRecurrenceHandler,
  respondToEventHandler,
  updateEventHandler,
  updateEventTimeHandler,
} from "./domains/calendar/service";
import { calendarColorKeyValidator } from "./domains/calendar/preferences";
import { googleEventValidator } from "./domains/calendar/validators";

// Re-exported for the web app, which types its calendar grid against it.
export type { EventView } from "./domains/calendar/model";

const eventIdArg = v.union(v.id("events"), v.id("sharedEvents"));

// --- Queries --------------------------------------------------------------

export const listSharedEventsForAssistant = internalQuery({
  args: { userId: v.string(), startMs: v.number(), endMs: v.number() },
  handler: (ctx, args) => listSharedEventsForAssistantHandler(ctx, args),
});

export const listCalendars = query({
  args: {},
  handler: (ctx) => listCalendarsHandler(ctx),
});

export const listEvents = query({
  args: {},
  handler: (ctx) => listEventsHandler(ctx),
});

export const listEventsInRange = query({
  args: { startMs: v.number(), endMs: v.number() },
  handler: (ctx, args) => listEventsInRangeHandler(ctx, args),
});

export const getEventById = query({
  args: { eventId: eventIdArg },
  handler: (ctx, args) => getEventByIdHandler(ctx, args),
});

export const getEventRecurrence = query({
  args: { eventId: eventIdArg },
  handler: (ctx, args) => getEventRecurrenceHandler(ctx, args),
});

export const getEventContext = internalQuery({
  args: { eventId: eventIdArg, userId: v.string() },
  handler: (ctx, args) => getEventContextHandler(ctx, args),
});

export const getPrimaryCalendarId = internalQuery({
  args: { userId: v.string() },
  handler: (ctx, args) => getPrimaryCalendarIdHandler(ctx, args),
});

// --- Mutations (our side only) -------------------------------------------

export const setCalendarSelected = mutation({
  args: { calendarId: v.id("calendars"), selected: v.boolean() },
  handler: (ctx, args) => setCalendarSelectedHandler(ctx, args),
});

export const setCalendarColor = mutation({
  args: {
    calendarId: v.id("calendars"),
    color: v.union(calendarColorKeyValidator, v.null()),
  },
  handler: (ctx, args) => setCalendarColorHandler(ctx, args),
});

export const deleteEventRow = internalMutation({
  args: {
    eventId: v.id("events"),
    userId: v.string(),
    calendarId: v.optional(v.string()),
    recurringEventId: v.optional(v.string()),
  },
  handler: (ctx, args) => deleteEventRowHandler(ctx, args),
});

export const upsertEvent = internalMutation({
  args: { userId: v.string(), event: googleEventValidator },
  handler: (ctx, args) => upsertEventHandler(ctx, args),
});

export const upsertRecurringSeries = internalMutation({
  args: {
    userId: v.string(),
    calendarId: v.string(),
    googleEventId: v.string(),
    recurrence: v.array(v.string()),
    sourceUpdatedMs: v.number(),
    replacedEventId: v.optional(v.id("events")),
  },
  handler: (ctx, args) => upsertRecurringSeriesHandler(ctx, args),
});

const attendeeArgs = v.array(
  v.object({
    email: v.string(),
    displayName: v.optional(v.string()),
    responseStatus: v.optional(v.string()),
    optional: v.optional(v.boolean()),
  }),
);

const recurrenceScopeArg = v.union(
  v.literal("thisEvent"),
  v.literal("thisAndFollowing"),
  v.literal("allEvents"),
);

export const acceptCreateEvent = internalMutation({
  args: {
    userId: v.string(),
    operationId: v.string(),
    summary: v.string(),
    startMs: v.number(),
    endMs: v.number(),
    description: v.optional(v.string()),
    location: v.optional(v.string()),
    allDay: v.optional(v.boolean()),
    calendarId: v.optional(v.string()),
    colorId: v.optional(v.string()),
    visibility: v.optional(v.string()),
    transparency: v.optional(v.string()),
    recurrence: v.optional(v.array(v.string())),
    attendees: v.optional(
      v.array(
        v.object({
          email: v.string(),
          displayName: v.optional(v.string()),
        }),
      ),
    ),
    timeZone: v.optional(v.string()),
    addConference: v.optional(v.boolean()),
  },
  handler: (ctx, args) => acceptCreateEventHandler(ctx, args),
});

export const acceptUpdateEventTime = internalMutation({
  args: {
    userId: v.string(),
    operationId: v.optional(v.string()),
    eventId: v.id("events"),
    startMs: v.number(),
    endMs: v.number(),
    timeZone: v.optional(v.string()),
  },
  handler: (ctx, args) => acceptUpdateEventTimeHandler(ctx, args),
});

export const acceptUpdateEvent = internalMutation({
  args: {
    userId: v.string(),
    operationId: v.string(),
    eventId: v.id("events"),
    summary: v.optional(v.string()),
    description: v.optional(v.union(v.string(), v.null())),
    location: v.optional(v.union(v.string(), v.null())),
    colorId: v.optional(v.union(v.string(), v.null())),
    visibility: v.optional(v.union(v.string(), v.null())),
    transparency: v.optional(v.string()),
    startMs: v.optional(v.number()),
    endMs: v.optional(v.number()),
    allDay: v.optional(v.boolean()),
    attendees: v.optional(attendeeArgs),
    recurrence: v.optional(v.array(v.string())),
    timeZone: v.optional(v.string()),
    conference: v.optional(v.union(v.literal("meet"), v.null())),
    scope: v.optional(recurrenceScopeArg),
    expectedGoogleUpdatedMs: v.optional(v.number()),
    expectedSeriesUpdatedMs: v.optional(v.number()),
  },
  handler: (ctx, args) => acceptUpdateEventHandler(ctx, args),
});

export const acceptRespondToEvent = internalMutation({
  args: {
    userId: v.string(),
    operationId: v.optional(v.string()),
    eventId: v.id("events"),
    responseStatus: v.union(
      v.literal("accepted"),
      v.literal("tentative"),
      v.literal("declined"),
    ),
  },
  handler: (ctx, args) => acceptRespondToEventHandler(ctx, args),
});

export const acceptDeleteEvent = internalMutation({
  args: {
    userId: v.string(),
    operationId: v.string(),
    eventId: v.id("events"),
    scope: v.optional(recurrenceScopeArg),
    expectedSeriesUpdatedMs: v.optional(v.number()),
  },
  handler: (ctx, args) => acceptDeleteEventHandler(ctx, args),
});

// --- Actions (accept locally; the desktop broker synchronizes later) ------

export const createEvent = action({
  args: {
    summary: v.string(),
    startMs: v.number(),
    endMs: v.number(),
    description: v.optional(v.string()),
    location: v.optional(v.string()),
    allDay: v.optional(v.boolean()),
    /** Google calendar to create in; defaults to the user's primary. */
    calendarId: v.optional(v.string()),
    /** Google event colour override ("1".."11"); absent inherits the calendar. */
    colorId: v.optional(v.string()),
    visibility: v.optional(v.string()),
    /** Google's `transparency`: "transparent" (free); absent = busy (the default). */
    transparency: v.optional(v.string()),
    /** RFC5545 recurrence lines (RRULE), e.g. ["RRULE:FREQ=WEEKLY;BYDAY=MO"]. */
    recurrence: v.optional(v.array(v.string())),
    /** Guests to invite. Google emails each one an invitation on create. */
    attendees: v.optional(
      v.array(
        v.object({
          email: v.string(),
          displayName: v.optional(v.string()),
        }),
      ),
    ),
    /** Client IANA time zone; Google requires it for recurring timed events. */
    timeZone: v.optional(v.string()),
    /** Ask Google to mint a Google Meet link; the URL comes back as `hangoutLink`. */
    addConference: v.optional(v.boolean()),
    /** Idempotency key, stable across retries of the same user intent. */
    operationId: v.optional(v.string()),
  },
  handler: (ctx, args) => createEventHandler(ctx, args),
});

export const refreshEventRecurrence = action({
  args: { eventId: eventIdArg },
  handler: (ctx, args) => refreshEventRecurrenceHandler(ctx, args),
});

export const updateEventTime = action({
  args: {
    eventId: v.id("events"),
    startMs: v.number(),
    endMs: v.number(),
    /** Client IANA time zone; Google needs it to anchor a timed instant. */
    timeZone: v.optional(v.string()),
    /** Optional caller retry key; otherwise derived from the authenticated intent. */
    operationId: v.optional(v.string()),
  },
  handler: (ctx, args) => updateEventTimeHandler(ctx, args),
});

export const updateEvent = action({
  args: {
    eventId: v.id("events"),
    summary: v.optional(v.string()),
    /** HTML description (bold/italic/underline/links/lists). `null` clears it. */
    description: v.optional(v.union(v.string(), v.null())),
    location: v.optional(v.union(v.string(), v.null())),
    /** Google event colour ("1".."11"); `null` reverts to the calendar's. */
    colorId: v.optional(v.union(v.string(), v.null())),
    visibility: v.optional(v.union(v.string(), v.null())),
    /** Google's `transparency`: "opaque" (busy) | "transparent" (free). */
    transparency: v.optional(v.string()),
    /** Send both ends together, or neither. All-day values are UTC-midnight
     * instants with an exclusive end, as `createEvent` expects them. */
    startMs: v.optional(v.number()),
    endMs: v.optional(v.number()),
    allDay: v.optional(v.boolean()),
    /** Replaces the guest list wholesale — anyone omitted is uninvited. Carry
     * each existing guest's `responseStatus` through or their RSVP is reset. */
    attendees: v.optional(
      v.array(
        v.object({
          email: v.string(),
          displayName: v.optional(v.string()),
          responseStatus: v.optional(v.string()),
          optional: v.optional(v.boolean()),
        }),
      ),
    ),
    /** Convert a single event into a recurring master. Existing series rules
     * are intentionally edited through neither this action nor the UI. */
    recurrence: v.optional(v.array(v.string())),
    /** Client IANA time zone; Google needs it to anchor a timed instant. */
    timeZone: v.optional(v.string()),
    /** `"meet"` mints a Google Meet link, `null` clears the existing one, and
     * absent leaves conferencing untouched. */
    conference: v.optional(v.union(v.literal("meet"), v.null())),
    /** How far the edit reaches on a recurring event. Absent = `"thisEvent"`.
     * Ignored (forced to `"thisEvent"`) for a non-recurring event. */
    scope: v.optional(recurrenceScopeArg),
    /** Idempotency key, stable across retries of the same user intent. */
    operationId: v.optional(v.string()),
  },
  handler: (ctx, args) => updateEventHandler(ctx, args),
});

export const respondToEvent = action({
  args: {
    eventId: v.id("events"),
    responseStatus: v.union(
      v.literal("accepted"),
      v.literal("tentative"),
      v.literal("declined"),
    ),
    /** Optional caller retry key; otherwise derived from the authenticated intent. */
    operationId: v.optional(v.string()),
  },
  handler: (ctx, args) => respondToEventHandler(ctx, args),
});

export const deleteEvent = action({
  args: {
    eventId: v.id("events"),
    scope: v.optional(recurrenceScopeArg),
    operationId: v.optional(v.string()),
    /** Cached recurring-master version required for future-only deletion. */
    expectedSeriesUpdatedMs: v.optional(v.number()),
  },
  handler: (ctx, args) => deleteEventHandler(ctx, args),
});
