// @ts-expect-error Bun supplies its test module at runtime.
import { afterEach, describe, expect, test } from "bun:test";

import type { ActionCtx } from "../../_generated/server";
import { LOCAL_AUTH_ISSUERS, LOCAL_AUTH_SUBJECT } from "../desktop/identity";
import {
  googleConferenceRequestIdForOperation,
  googleEventIdForOperation,
  localEventIdForOperation,
} from "../../lib/assistantLogic";
import { createEventHandler } from "./service";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function rendererIdentity() {
  return {
    issuer: LOCAL_AUTH_ISSUERS.test,
    subject: LOCAL_AUTH_SUBJECT,
    tokenIdentifier: `${LOCAL_AUTH_ISSUERS.test}|${LOCAL_AUTH_SUBJECT}`,
    email: "local@qali.app",
    name: "Qali User",
    role: "renderer",
  };
}

const createArgs = {
  calendarId: "primary@example.com",
  summary: "Offline planning",
  startMs: Date.parse("2026-09-01T09:00:00.000Z"),
  endMs: Date.parse("2026-09-01T10:00:00.000Z"),
  addConference: true,
  operationId: "123e4567-e89b-12d3-a456-426614174000",
};

describe("local calendar write acceptance", () => {
  test("create commits locally while Google is unreachable", async () => {
    const mutationCalls: Record<string, unknown>[] = [];
    const accepted = {
      operationId: createArgs.operationId,
      localEventId: localEventIdForOperation(createArgs.operationId),
      googleEventId: `local-${localEventIdForOperation(createArgs.operationId)}`,
      calendarId: createArgs.calendarId,
      summary: createArgs.summary,
      startMs: createArgs.startMs,
      endMs: createArgs.endMs,
      allDay: false,
      status: "confirmed",
      googleUpdatedMs: 0,
      syncState: "pending",
    } as const;
    const ctx = {
      auth: { getUserIdentity: async () => rendererIdentity() },
      runMutation: async (
        _reference: unknown,
        args: Record<string, unknown>,
      ) => {
        mutationCalls.push(args);
        return accepted;
      },
    } as unknown as ActionCtx;
    let fetched = false;
    globalThis.fetch = (async () => {
      fetched = true;
      throw new Error("offline");
    }) as typeof fetch;

    const result = await createEventHandler(ctx, createArgs);

    expect(result).toEqual(accepted);
    expect(result.syncState).toBe("pending");
    expect(mutationCalls).toEqual([
      expect.objectContaining({
        userId: LOCAL_AUTH_SUBJECT,
        operationId: createArgs.operationId,
      }),
    ]);
    expect(fetched).toBe(false);
  });

  test("stable operation identities hand deterministic provider ids to sync", () => {
    const operationId = "Operation_with-WXYZ-and-provider-unsafe-characters";
    const eventId = googleEventIdForOperation(operationId);
    const conferenceId = googleConferenceRequestIdForOperation(operationId);
    const localId = localEventIdForOperation(operationId);

    expect(googleEventIdForOperation(operationId)).toBe(eventId);
    expect(googleConferenceRequestIdForOperation(operationId)).toBe(
      conferenceId,
    );
    expect(localEventIdForOperation(operationId)).toBe(localId);
    expect(eventId).toMatch(/^[a-v0-9]{5,100}$/);
    expect(conferenceId).toMatch(/^[a-v0-9]{5,128}$/);
    expect(localId).toMatch(/^local_[a-f0-9]{32}$/);
    expect(eventId).not.toBe(conferenceId);
  });
});
