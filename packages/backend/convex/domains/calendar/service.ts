/** Provider-free calendar action boundary for the local desktop backend. */

import { eventCapabilities, type EventCapabilities } from "@qali/domain/permissions";

import { internal } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import type { ActionCtx } from "../../_generated/server";
import { optionalLocalUser } from "../desktop/identity";
import type { LocalAcceptedEvent, LocalDeleteReceipt } from "./mutations";

export type EventCapabilityName =
  | "canEdit"
  | "canRespond"
  | "canDelete"
  | "canRemoveSelf";

const CAPABILITY_DENIAL: Record<EventCapabilityName, string> = {
  canEdit: "You can't edit this event",
  canRespond: "You're not a guest on this event",
  canDelete: "You can't delete this event",
  canRemoveSelf: "You can't remove this event",
};

export async function resolveEventForWrite(
  ctx: ActionCtx,
  userId: string,
  eventId: Id<"events">,
  allowed: EventCapabilityName[],
): Promise<{ row: Doc<"events">; capabilities: EventCapabilities }> {
  const context = await ctx.runQuery(internal.calendar.getEventContext, {
    eventId,
    userId,
  });
  if (!context) throw new Error("Event not found");
  const capabilities = eventCapabilities(
    context.event,
    context.calendar ?? undefined,
  );
  if (!allowed.some((name) => capabilities[name])) {
    throw new Error(
      allowed[0] === "canEdit" && capabilities.readOnlyReason
        ? capabilities.readOnlyReason
        : CAPABILITY_DENIAL[allowed[0]!],
    );
  }
  return { row: context.event, capabilities };
}

export interface CreateEventArgs {
  summary: string;
  startMs: number;
  endMs: number;
  description?: string;
  location?: string;
  allDay?: boolean;
  calendarId?: string;
  colorId?: string;
  visibility?: string;
  transparency?: string;
  recurrence?: string[];
  attendees?: { email: string; displayName?: string }[];
  timeZone?: string;
  addConference?: boolean;
  operationId?: string;
}

export interface UpdateEventTimeArgs {
  eventId: Id<"events">;
  startMs: number;
  endMs: number;
  timeZone?: string;
  operationId?: string;
}

export type UpdateEventScope = "thisEvent" | "thisAndFollowing" | "allEvents";
export type DeleteEventScope = UpdateEventScope;

export type CalendarAttendeeInput = {
  email?: string;
  displayName?: string;
  responseStatus?: string;
  optional?: boolean;
};

export interface UpdateEventArgs {
  eventId: Id<"events">;
  summary?: string;
  description?: string | null;
  location?: string | null;
  colorId?: string | null;
  visibility?: string | null;
  transparency?: string;
  startMs?: number;
  endMs?: number;
  allDay?: boolean;
  attendees?: CalendarAttendeeInput[];
  recurrence?: string[];
  timeZone?: string;
  conference?: "meet" | null;
  scope?: UpdateEventScope;
  operationId?: string;
  expectedGoogleUpdatedMs?: number;
  expectedSeriesUpdatedMs?: number;
}

export interface RespondToEventArgs {
  eventId: Id<"events">;
  responseStatus: "accepted" | "tentative" | "declined";
  operationId?: string;
}

export interface DeleteEventArgs {
  eventId: Id<"events">;
  scope?: DeleteEventScope;
  operationId?: string;
  expectedSeriesUpdatedMs?: number;
}

async function localWriteUserId(ctx: ActionCtx): Promise<string> {
  const user = await optionalLocalUser(ctx);
  if (!user) throw new Error("Not authenticated");
  return user.id;
}

export async function createEventHandler(
  ctx: ActionCtx,
  args: CreateEventArgs,
): Promise<LocalAcceptedEvent> {
  const userId = await localWriteUserId(ctx);
  return await ctx.runMutation(internal.calendar.acceptCreateEvent, {
    ...args,
    userId,
    operationId: args.operationId ?? crypto.randomUUID(),
  });
}

/** Recurrence metadata arrives through the local Google worker's event page. */
export async function refreshEventRecurrenceHandler(
  ctx: ActionCtx,
  { eventId }: { eventId: Id<"events"> | Id<"sharedEvents"> },
): Promise<null> {
  const user = await optionalLocalUser(ctx);
  if (!user) throw new Error("Not authenticated");
  const context = await ctx.runQuery(internal.calendar.getEventContext, {
    eventId,
    userId: user.id,
  });
  if (!context) throw new Error("Event not found");
  return null;
}

export async function updateEventTimeHandler(
  ctx: ActionCtx,
  args: UpdateEventTimeArgs,
): Promise<LocalAcceptedEvent> {
  return await ctx.runMutation(internal.calendar.acceptUpdateEventTime, {
    ...args,
    userId: await localWriteUserId(ctx),
  });
}

export async function updateEventHandler(
  ctx: ActionCtx,
  args: UpdateEventArgs,
): Promise<LocalAcceptedEvent> {
  const { attendees: rawAttendees, ...writeArgs } = args;
  const attendees = rawAttendees?.flatMap((attendee) =>
    attendee.email
      ? [{
          email: attendee.email,
          ...(attendee.displayName === undefined ? {} : { displayName: attendee.displayName }),
          ...(attendee.responseStatus === undefined ? {} : { responseStatus: attendee.responseStatus }),
          ...(attendee.optional === undefined ? {} : { optional: attendee.optional }),
        }]
      : [],
  );
  return await ctx.runMutation(internal.calendar.acceptUpdateEvent, {
    ...writeArgs,
    ...(attendees === undefined ? {} : { attendees }),
    userId: await localWriteUserId(ctx),
    operationId: args.operationId ?? crypto.randomUUID(),
  });
}

export async function respondToEventHandler(
  ctx: ActionCtx,
  args: RespondToEventArgs,
): Promise<LocalAcceptedEvent> {
  return await ctx.runMutation(internal.calendar.acceptRespondToEvent, {
    ...args,
    userId: await localWriteUserId(ctx),
  });
}

export async function deleteEventHandler(
  ctx: ActionCtx,
  args: DeleteEventArgs,
): Promise<LocalDeleteReceipt> {
  return await ctx.runMutation(internal.calendar.acceptDeleteEvent, {
    ...args,
    userId: await localWriteUserId(ctx),
    operationId: args.operationId ?? crypto.randomUUID(),
  });
}
