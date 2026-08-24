import { v } from "convex/values";

import { mutation } from "../../_generated/server";
import { calendarOperationIdForIntent } from "../../lib/assistantLogic";
import { optionalLocalUser } from "../desktop/identity";
import { applyStoredAssistantProposal } from "./tools";

/** Provider-free confirmation for proposals produced by the desktop assistant. */
export const confirmAction = mutation({
  args: {
    actionId: v.id("assistantActions"),
    decision: v.union(v.literal("confirm"), v.literal("discard")),
  },
  handler: async (ctx, args) => {
    const user = await optionalLocalUser(ctx);
    if (!user) throw new Error("Not authenticated");

    const stored = await ctx.db.get(args.actionId);
    if (!stored || stored.userId !== user.id) throw new Error("Proposal not found");
    if (stored.status === "applied") {
      if (args.decision !== "confirm") throw new Error("Proposal already confirmed");
      return {
        actionId: stored._id,
        decision: "confirm" as const,
        operationId: stored.operationId,
        status: "applied" as const,
      };
    }
    if (stored.status === "rejected") {
      if (args.decision !== "discard") throw new Error("Proposal already discarded");
      return {
        actionId: stored._id,
        decision: "discard" as const,
        status: "rejected" as const,
      };
    }
    if (stored.status !== "pending") throw new Error("Proposal is not pending");
    if (args.decision === "discard") {
      await ctx.db.patch(stored._id, { status: "rejected", decidedAt: Date.now() });
      return {
        actionId: stored._id,
        decision: "discard" as const,
        status: "rejected" as const,
      };
    }

    const operationId = calendarOperationIdForIntent(
      "assistant-proposal-confirmation",
      { actionId: String(stored._id) },
    );
    const resultSummary = await applyStoredAssistantProposal(
      ctx,
      user.id,
      stored,
      operationId,
    );
    await ctx.db.patch(stored._id, {
      operationId,
      status: "applied",
      resultSummary,
      decidedAt: Date.now(),
    });
    return {
      actionId: stored._id,
      decision: "confirm" as const,
      operationId,
      status: "applied" as const,
    };
  },
});
