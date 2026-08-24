// @ts-expect-error Bun supplies its test module at runtime.
import { describe, expect, test } from "bun:test";

import {
  assertCalendarCommand,
  compactCalendarOperations,
  orderCalendarOperations,
  type CalendarOperation,
} from "./operations";

function op(
  operationId: string,
  kind: CalendarOperation["kind"],
  payload: CalendarOperation["payload"],
  createdAt: number,
  state: CalendarOperation["state"] = "pending",
): CalendarOperation {
  return {
    operationId,
    accountId: "account-1",
    calendarId: "primary",
    localEventId: "local-1",
    kind,
    payload,
    state,
    attemptCount: 0,
    createdAt,
    updatedAt: createdAt,
  };
}

describe("calendar operation ledger", () => {
  test("operation states are exact and terminal rows remain immutable barriers", () => {
    expect(
      compactCalendarOperations([
        op("succeeded", "update", { patch: { summary: "Remote" } }, 1, "succeeded"),
        {
          ...op("pending", "update", { patch: { summary: "Local" } }, 2),
          predecessorOperationId: "succeeded",
        },
      ]),
    ).toEqual([
      expect.objectContaining({ operationId: "succeeded", state: "succeeded" }),
      expect.objectContaining({ operationId: "pending", state: "pending" }),
    ]);
  });

  test("compacts a create and ordered edits into one deterministic create", () => {
    const compacted = compactCalendarOperations([
      op("create", "create", {
        event: {
          localEventId: "local-1",
          accountId: "account-1",
          calendarId: "primary",
          summary: "Lunch",
          startMs: 1,
          endMs: 2,
          allDay: false,
          status: "confirmed",
        },
      }, 1),
      { ...op("patch", "update", { patch: { summary: "Dinner" } }, 2), predecessorOperationId: "create" },
    ]);

    expect(compacted).toHaveLength(1);
    expect(compacted[0]).toMatchObject({
      operationId: "create",
      kind: "create",
      payload: { event: { summary: "Dinner" } },
    });
  });

  test("combines consecutive unsynchronized patches in dependency order", () => {
    const compacted = compactCalendarOperations([
      op("patchone", "update", {
        patch: { summary: "First", location: "Room A" },
      }, 1),
      {
        ...op("patchtwo", "update", {
          patch: { summary: "Second", description: "Bring notes" },
        }, 2),
        predecessorOperationId: "patchone",
      },
    ]);

    expect(compacted).toHaveLength(1);
    expect(compacted[0]).toMatchObject({
      operationId: "patchone",
      kind: "update",
      payload: {
        patch: {
          summary: "Second",
          location: "Room A",
          description: "Bring notes",
        },
      },
    });
  });

  test("create followed by delete becomes a cancelled local-only sequence", () => {
    const compacted = compactCalendarOperations([
      op("create", "create", {
        event: {
          localEventId: "local-1",
          accountId: "account-1",
          calendarId: "primary",
          startMs: 1,
          endMs: 2,
          allDay: false,
          status: "confirmed",
        },
      }, 1),
      { ...op("delete", "delete", {}, 2), predecessorOperationId: "create" },
    ]);

    expect(compacted).toEqual([
      expect.objectContaining({ operationId: "create", state: "cancelled" }),
      expect.objectContaining({ operationId: "delete", state: "cancelled" }),
    ]);
  });

  test("local-only cancellation does not consume an independent event", () => {
    const independent = {
      ...op("independent", "update", { patch: { summary: "Keep" } }, 3),
      localEventId: "local-2",
    };
    const compacted = compactCalendarOperations([
      op("create", "create", {
        event: {
          localEventId: "local-1",
          accountId: "account-1",
          calendarId: "primary",
          startMs: 1,
          endMs: 2,
          allDay: false,
          status: "confirmed",
        },
      }, 1),
      { ...op("delete", "delete", {}, 2), predecessorOperationId: "create" },
      independent,
    ]);

    expect(compacted.map((entry) => entry.operationId)).toEqual([
      "create",
      "delete",
      "independent",
    ]);
    expect(compacted[2]).toEqual(independent);
  });

  test("move keeps its identity dependency and serializes later event work", () => {
    const ordered = orderCalendarOperations([
      {
        ...op("later", "update", { patch: { summary: "After move" } }, 3),
        predecessorOperationId: "move",
      },
      {
        ...op(
          "move",
          "move",
          { destinationCalendarId: "other" },
          2,
        ),
        predecessorOperationId: "before",
      },
      op("before", "update", { patch: { location: "A" } }, 1),
    ]);

    expect(ordered.map((entry) => entry.operationId)).toEqual([
      "before",
      "move",
      "later",
    ]);
  });

  test("rejects unbounded or invalid commands before durable insertion", () => {
    expect(() =>
      assertCalendarCommand({
        operationId: "not a stable id",
        accountId: "account-1",
        calendarId: "primary",
        localEventId: "local-1",
        kind: "update",
        payload: { patch: { summary: "x".repeat(10_001) } },
      }),
    ).toThrow();

    expect(() =>
      assertCalendarCommand({
        operationId: "operation_invalid_payload",
        accountId: "account-1",
        calendarId: "primary",
        localEventId: "local-1",
        kind: "delete",
        payload: { patch: { summary: "not a delete" } },
      }),
    ).toThrow("CALENDAR_COMMAND_PAYLOAD_MISMATCH");

    expect(() =>
      assertCalendarCommand({
        operationId: "operation_invalid_scope",
        accountId: "account-1",
        calendarId: "primary",
        localEventId: "local-1",
        kind: "update",
        payload: { patch: { summary: "Local" } },
        baseRemoteSnapshot: {
          localEventId: "another-event",
          accountId: "account-1",
          calendarId: "primary",
          startMs: 1,
          endMs: 2,
          allDay: false,
          status: "confirmed",
        },
      }),
    ).toThrow("CALENDAR_COMMAND_SCOPE_MISMATCH");
  });

  test("rejects identity changes disguised as ordinary event patches", () => {
    expect(() =>
      assertCalendarCommand({
        operationId: "operation_forged_identity",
        accountId: "account-1",
        calendarId: "primary",
        localEventId: "local-1",
        remoteEventId: "remote-1",
        kind: "update",
        payload: { patch: { calendarId: "another-calendar" } },
        baseRemoteSnapshot: {
          localEventId: "local-1",
          accountId: "account-1",
          calendarId: "primary",
          remoteEventId: "remote-1",
          startMs: 1,
          endMs: 2,
          allDay: false,
          status: "confirmed",
        },
        baseRemoteEtag: "etag-1",
      }),
    ).toThrow("CALENDAR_COMMAND_IDENTITY_MUTATION");
  });

  test("requires a usable confirmed precondition for remote non-create work", () => {
    expect(() =>
      assertCalendarCommand({
        operationId: "operation_missing_precondition",
        accountId: "account-1",
        calendarId: "primary",
        localEventId: "local-1",
        remoteEventId: "remote-1",
        kind: "update",
        payload: { patch: { summary: "Local" } },
      }),
    ).toThrow("CALENDAR_COMMAND_PRECONDITION_REQUIRED");

    expect(() =>
      assertCalendarCommand({
        operationId: "operation_local_cancel",
        accountId: "account-1",
        calendarId: "primary",
        localEventId: "local-1",
        kind: "delete",
        payload: {},
      }),
    ).not.toThrow();
  });

  test("preserves only an explicit valid recurring delete scope", () => {
    expect(() =>
      assertCalendarCommand({
        operationId: "operation_scoped_delete",
        accountId: "account-1",
        calendarId: "primary",
        localEventId: "local-1",
        kind: "delete",
        payload: { recurrenceScope: "thisAndFollowing" },
      }),
    ).not.toThrow();
    expect(() =>
      assertCalendarCommand({
        operationId: "operation_forged_scope",
        accountId: "account-1",
        calendarId: "primary",
        localEventId: "local-1",
        kind: "delete",
        payload: { recurrenceScope: "future" } as never,
      }),
    ).toThrow("CALENDAR_COMMAND_PAYLOAD_MISMATCH");
  });
});
