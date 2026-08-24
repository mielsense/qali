# Compatibility Baseline

Snapshot of the callable/scheduled backend surface as of the start of the provider-ready
refactor (branch `fix/assistant-enhancements`). Later stages diff `_generated/api.d.ts` and this
file to prove no public wire contract or scheduled reference was silently broken.

Expected changes over the course of the provider refactor were limited to:
- adding `api.calendarSync.syncNow` (provider-neutral facade; `api.googleSync.syncNow` retained),
- additive optional storage fields on existing tables,
- the honest `Id<"events"> | Id<"sharedEvents">` id union on shared-event reads.

The later desktop product cleanup intentionally retired the complete public-booking and
in-app booking-notification vertical slices. They are no longer part of the supported
wire contract, schema, assistant tool set, maintenance jobs, or packaged source.

## Public API surface (`api.*`)

- `api.assistant.confirmAction`, `api.assistant.sendMessage`
- `api.assistantData.isAvailable`, `api.assistantData.listMessages`, `api.assistantData.listPendingActions`, `api.assistantData.listThreads`, `api.assistantData.monthlyQuota`
- `api.assistantMaintenance.deleteThread`
- `api.auth.getCurrentUser`
- `api.calendar.createEvent`, `api.calendar.deleteEvent`, `api.calendar.getEventById`, `api.calendar.getEventRecurrence`, `api.calendar.listCalendars`, `api.calendar.listEvents`, `api.calendar.listEventsInRange`, `api.calendar.refreshEventRecurrence`, `api.calendar.respondToEvent`, `api.calendar.setCalendarSelected`, `api.calendar.updateEvent`, `api.calendar.updateEventTime`
- `api.contacts.listContacts`
- `api.googleSync.syncNow`
- `api.healthCheck.get`
- `api.people.listPeople`
- `api.privateData.get`
- `api.waitlist.join`

## Scheduled / cross-called internal references (`internal.*`)

These are invoked from crons, `ctx.scheduler.*`, or `ctx.run{Query,Mutation,Action}` and must keep
resolving unless the owning product surface is explicitly retired.

- assistantData: appendBlock, claimAction, failTurn, finishTurn, flushText, getHistory, getRecurringSeriesVersion, getThreadActions, listEventsForAssistant, recordProposal, rejectAction, releaseStaleAction, retryClaimedAction, setSuggestions, settleClaimedAction, startTurn
- assistantMaintenance: pruneAgedThreads
- calendar: deleteEventRow, getEventContext, getPrimaryCalendarId, listSharedEventsForAssistant, upsertEvent, upsertRecurringSeries
- googleSync: applyEngagementScores, backfillPeople, beginCalendarFullResync, beginContactsFullResync, claimSharedCalendarSync, claimSyncLease, cleanupRemovedCalendarEvents, clearCalendarEventsBatch, clearSharedCalendarEventsBatch, commitCalendarFullResync, enqueueEngagementRefresh, enqueueSyncs, ensureSyncState, getSyncState, listCalendarsForUser, listEventsPageForEngagement, recomputeEngagement, reconcileCalendars, recordSyncOutcome, releaseSharedCalendarLease, setCalendarSyncToken, setContactsSync, setOtherContactsSync, setSharedCalendarSynced, sweepStaleCalendarEventsBatch, sweepStaleContactsBatch, sweepStaleOtherPeopleBatch, syncUser, upsertContactsPage, upsertEventsPage, upsertOtherContactsPage, upsertSharedEventsPage
- maintenance: clearEventAttendees, enqueueEventPrune, enqueueSharedEventPrune, migratePublicCalendarsToShared, pruneRateLimits, pruneSharedCalendarEvents, pruneUserEvents, purgeNonSharedSharedEvents, purgeUserData

## Test baseline

`fix/assistant-enhancements`: 111 unit tests (`bun test convex`), 8 integration tests
(`vitest run`, `*.itest.ts`), passing `check-types` and workspace build.
