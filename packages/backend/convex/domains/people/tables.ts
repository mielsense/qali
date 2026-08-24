import { defineTable } from "convex/server";
import { v } from "convex/values";

/** Calendar-derived attendee names used by the guest picker. */
export const peopleTables = {
  people: defineTable({
    userId: v.string(),
    email: v.string(),
    displayName: v.optional(v.string()),
    sources: v.array(v.literal("attendee")),
    // Engagement ranking, recomputed from the user's events on each sync (see
    // recomputeEngagement in googleSync.ts). A recency- + intimacy-weighted
    // frequency score orders the guest picker toward frequent, recent meeting
    // partners. The count/timestamps back tiebreaks and future UI hints. Absent
    // until the first recompute; treat missing as 0 / never.
    score: v.optional(v.number()),
    meetingCount: v.optional(v.number()),
    lastMetMs: v.optional(v.number()),
    nextMeetingMs: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_user_and_email", ["userId", "email"])
    // Ranked reads for the guest picker: query descending to get top scorers
    // without loading and JS-sorting the whole directory per client.
    .index("by_user_and_score", ["userId", "score"]),
};

/**
 * Transitional validators used only by the pre-contraction deployment. They
 * let an existing local database load long enough for the broker-only cleanup
 * mutation to erase provider-derived rows and normalize attendee rows.
 */
export const legacyPeopleTables = {
  contacts: defineTable({
    userId: v.string(),
    resourceName: v.string(),
    displayName: v.optional(v.string()),
    emails: v.array(v.string()),
    phones: v.array(v.string()),
    photoUrl: v.optional(v.string()),
    googleEtag: v.optional(v.string()),
    syncGeneration: v.optional(v.number()),
  })
    .index("by_user", ["userId"])
    .index("by_user_and_resourceName", ["userId", "resourceName"]),
  people: defineTable({
    userId: v.string(),
    email: v.string(),
    displayName: v.optional(v.string()),
    photoUrl: v.optional(v.string()),
    sources: v.array(
      v.union(
        v.literal("connection"),
        v.literal("other"),
        v.literal("attendee"),
      ),
    ),
    score: v.optional(v.number()),
    meetingCount: v.optional(v.number()),
    lastMetMs: v.optional(v.number()),
    nextMeetingMs: v.optional(v.number()),
    updatedAt: v.number(),
    otherSyncGeneration: v.optional(v.number()),
  })
    .index("by_user", ["userId"])
    .index("by_user_and_email", ["userId", "email"])
    .index("by_user_and_score", ["userId", "score"]),
};
