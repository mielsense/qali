import type { Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";

/**
 * Find (or lazily create) the user's single Google calendar connection.
 *
 * Connection == the login grant in v1, so the credential is still resolved
 * through Better Auth — this row only carries the neutral provider identity and
 * capabilities. Reused by the backfill and every dual-write path, so a user the
 * backfill missed (or who signed up since) still gets a connection on their next
 * write or sync. Idempotent: one Google connection per user.
 */
export async function ensureGoogleConnection(
  ctx: MutationCtx,
  userId: string,
  accountId?: string,
): Promise<Id<"calendarConnections">> {
  if (accountId !== undefined) {
    const scoped = await ctx.db
      .query("calendarConnections")
      .withIndex("by_user_provider_account", (q) =>
        q
          .eq("userId", userId)
          .eq("provider", "google")
          .eq("accountId", accountId),
      )
      .unique();
    if (!scoped || scoped.status !== "active") {
      throw new Error("GOOGLE_ACCOUNT_NOT_ATTACHED");
    }
    return scoped._id;
  }
  const rows = await ctx.db
    .query("calendarConnections")
    .withIndex("by_user_and_provider", (q) =>
      q.eq("userId", userId).eq("provider", "google"),
    )
    .take(10);
  const active = rows.filter((row) => row.status === "active");
  if (active.length === 1) return active[0]!._id;
  if (active.length > 1 || rows.length > 0) {
    throw new Error("GOOGLE_ACCOUNT_SELECTION_REQUIRED");
  }
  const now = Date.now();
  return await ctx.db.insert("calendarConnections", {
    userId,
    provider: "google",
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
}
