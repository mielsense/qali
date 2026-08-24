/** Read handler for the calendar-derived attendee directory. */

import type { QueryCtx } from "../../_generated/server";
import { optionalLocalUser } from "../desktop/identity";

// How many people the picker/assistant load. Ordered by engagement, so this is
// the top-N most relevant; a personal directory rarely exceeds it. Bounds the
// bytes each connected client reads per subscription.
const PEOPLE_LIMIT = 500;

/** The unified people directory for the current user: the email-keyed union of
 * saved Google connections, Other Contacts, and people harvested from calendar
 * events. Read via `by_user_and_score` descending, so the most-met people come
 * first straight from the index — no whole-directory load or JS sort per client.
 * People with no shared meetings have no score and sort to the tail. */
export async function listPeopleHandler(ctx: QueryCtx) {
  const user = await optionalLocalUser(ctx);
  if (!user) {
    return [];
  }
  const rows = await ctx.db
    .query("people")
    .withIndex("by_user_and_score", (q) => q.eq("userId", user.id))
    .order("desc")
    .take(PEOPLE_LIMIT);
  return rows.map((p) => ({
    email: p.email,
    displayName: p.displayName,
    // Calendar attendees do not carry profile photos. Keep the existing UI
    // shape stable without persisting a Contacts-derived URL.
    photoUrl: undefined,
    score: p.score ?? 0,
    meetingCount: p.meetingCount ?? 0,
    lastMetMs: p.lastMetMs,
    nextMeetingMs: p.nextMeetingMs,
  }));
}
