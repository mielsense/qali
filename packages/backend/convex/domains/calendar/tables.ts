import { defineTable } from "convex/server";
import { v } from "convex/values";

import {
  calendarEventSnapshotValidator,
  calendarOperationPayloadValidator,
  calendarOperationStateValidator,
  eventDocValidator,
  googleEventValidator,
} from "./validators";
import { calendarColorKeyValidator } from "./preferences";

/** Table definitions owned by the calendar domain, composed into schema.ts. */
export const calendarTables = {
  // One row per Google calendar in the user's CalendarList. Holds display
  // metadata, the user's visibility choice, and the per-calendar sync token.
  calendars: defineTable({
    userId: v.string(),
    // Collision-safe application identity. Optional only for legacy rows that
    // have not yet passed the account-aware backfill.
    calendarKey: v.optional(v.string()),
    googleCalendarId: v.string(),
    summary: v.optional(v.string()),
    summaryOverride: v.optional(v.string()),
    backgroundColor: v.optional(v.string()),
    foregroundColor: v.optional(v.string()),
    // Qali-only display preference. Google CalendarList refreshes update the
    // provider colors above but never overwrite this local choice.
    colorOverride: v.optional(calendarColorKeyValidator),
    primary: v.optional(v.boolean()),
    accessRole: v.optional(v.string()),
    timeZone: v.optional(v.string()),
    // Google's own Calendar UI visibility. This only seeds the local choice
    // when a calendar is first discovered; later local toggles are preserved.
    googleSelected: v.optional(v.boolean()),
    selected: v.boolean(),
    syncToken: v.optional(v.string()),
    lastSyncAt: v.optional(v.number()),
    // Current full-resync generation for this calendar's `events` rows. Bumped
    // at the start of each full resync; the run stamps re-fetched rows with it
    // and sweeps rows carrying an older value. See syncOneCalendar.
    syncGeneration: v.optional(v.number()),
    accountId: v.optional(v.string()),
    // Provider-neutral fields (dual-written until cutover). `providerCalendarId`
    // mirrors `googleCalendarId`; `syncCursor` is the opaque per-calendar cursor
    // that mirrors `syncToken` (a Google sync token today, a Graph delta link
    // later). Optional until backfilled.
    connectionId: v.optional(v.id("calendarConnections")),
    providerCalendarId: v.optional(v.string()),
    syncCursor: v.optional(v.string()),
  })
    .index("by_user", ["userId"])
    .index("by_user_and_calendarKey", ["userId", "calendarKey"])
    .index("by_user_and_googleCalendarId", ["userId", "googleCalendarId"])
    // Staged neutral-id lookup; read by nothing until cutover.
    .index("by_connection_and_providerCalendarId", [
      "connectionId",
      "providerCalendarId",
    ]),

  // One row per synced Google Calendar event. See eventDocValidator.
  events: defineTable(eventDocValidator)
    .index("by_user_and_start", ["userId", "startMs"])
    // A dedicated (userId, calendarId) index would be redundant: every query
    // that only constrains those two reuses by_user_and_calendar_and_end by
    // prefix. Dropping it cuts a full index copy of the largest table.
    .index("by_user_and_calendar_and_end", ["userId", "calendarId", "endMs"])
    .index("by_user_and_calendar_and_googleEventId", [
      "userId",
      "calendarId",
      "googleEventId",
    ])
    .index("by_user_and_localEventId", ["userId", "localEventId"])
    .index("by_user_calendar_generation", [
      "userId",
      "calendarId",
      "syncGeneration",
    ])
    // Provider-neutral event-id lookup, the successor to the Google-id index
    // above. Staged: built now but read by nothing until cutover, after which the
    // Google-id index is retired. Costs one extra index copy on the largest table
    // for the duration of the migration — an accepted, temporary cost.
    .index("by_connection_and_providerEventId", [
      "connectionId",
      "providerEventId",
    ]),

  // One physical copy of a Google *public* calendar's events (holidays,
  // birthdays), shared across every user who selects that calendar. Stored once
  // rather than per-user. No `userId`: the row belongs to the calendar, not a
  // person. See isSharedPublicCalendar in lib/calendars.ts.
  sharedEvents: defineTable(googleEventValidator)
    .index("by_calendar_and_start", ["calendarId", "startMs"])
    .index("by_calendar_and_end", ["calendarId", "endMs"])
    .index("by_calendar_and_googleEventId", ["calendarId", "googleEventId"]),

  // One row per shared public calendar: its user-independent sync token plus a
  // lease so exactly one user's sync refreshes it at a time.
  sharedCalendars: defineTable({
    googleCalendarId: v.string(),
    syncToken: v.optional(v.string()),
    lastSyncAt: v.optional(v.number()),
    // Held while a sync runs; a second user finding a live lease skips its run.
    syncLeaseExpiresAt: v.optional(v.number()),
  }).index("by_googleCalendarId", ["googleCalendarId"]),

  // One row per recurring master. Expanded event instances share this rule;
  // keeping it separately avoids duplicating it across every occurrence.
  recurringSeries: defineTable({
    userId: v.string(),
    calendarId: v.string(),
    providerCalendarId: v.optional(v.string()),
    googleEventId: v.string(),
    recurrence: v.array(v.string()),
    // The instance update time that this rule was fetched against. A newer
    // synced instance invalidates the cache and triggers one master refresh.
    sourceUpdatedMs: v.number(),
    // Provider-neutral fields (dual-written until cutover). `providerEventId`
    // mirrors `googleEventId`. Optional until backfilled.
    connectionId: v.optional(v.id("calendarConnections")),
    providerEventId: v.optional(v.string()),
  })
    .index("by_user_and_calendar_and_googleEventId", [
      "userId",
      "calendarId",
      "googleEventId",
    ])
    // Staged neutral-id lookup; read by nothing until cutover.
    .index("by_connection_and_providerEventId", [
      "connectionId",
      "providerEventId",
    ]),

  // Immutable local-first write intent. `status`/`idempotencyKey` remain as a
  // migration bridge for the pre-desktop provider-neutral expansion; `state`
  // and the scoped identity fields are the desktop ledger authority.
  calendarOperations: defineTable({
    connectionId: v.optional(v.id("calendarConnections")),
    userId: v.string(),
    operationId: v.optional(v.string()),
    idempotencyKey: v.string(),
    accountId: v.optional(v.string()),
    calendarId: v.optional(v.string()),
    localEventId: v.optional(v.string()),
    remoteEventId: v.optional(v.string()),
    providerCalendarId: v.optional(v.string()),
    providerEventId: v.optional(v.string()),
    kind: v.union(
      v.literal("create"),
      v.literal("update"),
      v.literal("move"),
      v.literal("respond"),
      v.literal("delete"),
    ),
    payload: v.optional(calendarOperationPayloadValidator),
    baseRemoteSnapshot: v.optional(calendarEventSnapshotValidator),
    baseRemoteEtag: v.optional(v.string()),
    // Mutable safe upload precondition. The original base above remains the
    // immutable command history used to explain/recover conflicts.
    uploadBaseRemoteSnapshot: v.optional(calendarEventSnapshotValidator),
    uploadBaseRemoteEtag: v.optional(v.string()),
    predecessorOperationId: v.optional(v.string()),
    // Materialized readiness prevents blocked chains from occupying the lease
    // candidate index ahead of independent events.
    leaseReady: v.optional(v.boolean()),
    nextLeaseAt: v.optional(v.number()),
    state: v.optional(calendarOperationStateValidator),
    // Compatibility mirror consumed only by the staged cloud migration code.
    status: v.union(
      v.literal("pending"),
      v.literal("succeeded"),
      v.literal("ambiguous"),
      v.literal("failed"),
    ),
    attemptCount: v.optional(v.number()),
    leaseId: v.optional(v.string()),
    leaseExpiresAt: v.optional(v.number()),
    leasePreviousState: v.optional(calendarOperationStateValidator),
    leaseLeaderOperationId: v.optional(v.string()),
    retryAt: v.optional(v.number()),
    safeError: v.optional(v.string()),
    lastError: v.optional(v.string()),
    remoteReceipt: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_connection_and_key", ["connectionId", "idempotencyKey"])
    .index("by_user_and_status", ["userId", "status"])
    .index("by_user_and_operationId", ["userId", "operationId"])
    .index("by_user_and_leaseId", ["userId", "leaseId"])
    .index("by_user_and_localEvent_and_createdAt", [
      "userId",
      "localEventId",
      "createdAt",
    ])
    .index("by_user_and_localEvent_and_state_and_createdAt", [
      "userId",
      "localEventId",
      "state",
      "createdAt",
    ])
    .index("by_user_and_state_and_createdAt", ["userId", "state", "createdAt"])
    .index("by_user_account_state_ready_due_created", [
      "userId",
      "accountId",
      "state",
      "leaseReady",
      "nextLeaseAt",
      "createdAt",
    ])
    .index("by_user_and_predecessorOperationId", [
      "userId",
      "predecessorOperationId",
    ])
    .index("by_user_and_leaseLeaderOperationId", [
      "userId",
      "leaseLeaderOperationId",
    ]),
};
