// @ts-expect-error Bun supplies its test module at runtime.
import { describe, expect, test } from "bun:test";

import {
  rebaseRemoteSnapshot,
  reducePendingOperations,
  type CalendarEventSnapshot,
  type CalendarOperation,
} from "./projection";

const baseEvent: CalendarEventSnapshot = {
  localEventId: "local-1",
  accountId: "account-1",
  calendarId: "primary",
  remoteEventId: "remote-1",
  summary: "Lunch",
  location: "A",
  startMs: 10,
  endMs: 20,
  allDay: false,
  status: "confirmed",
};

function operation(
  operationId: string,
  kind: CalendarOperation["kind"],
  payload: CalendarOperation["payload"],
  createdAt: number,
): CalendarOperation {
  return {
    operationId,
    accountId: "account-1",
    calendarId: "primary",
    localEventId: "local-1",
    remoteEventId: "remote-1",
    kind,
    payload,
    state: "pending",
    attemptCount: 0,
    createdAt,
    updatedAt: createdAt,
  };
}

describe("calendar event projection", () => {
  test("create then edit projects as one final event", () => {
    const created = operation(
      "op-create",
      "create",
      {
        event: {
          ...baseEvent,
          remoteEventId: undefined,
          summary: "Lunch",
        },
      },
      1,
    );
    const edited = operation(
      "op-edit",
      "update",
      { patch: { summary: "Dinner" } },
      2,
    );

    expect(reducePendingOperations(null, [created, edited])).toMatchObject({
      summary: "Dinner",
      syncState: "pending",
    });
  });

  test("create then delete cancels the local-only projection", () => {
    const created = operation(
      "op-create",
      "create",
      { event: { ...baseEvent, remoteEventId: undefined } },
      1,
    );
    const deleted = operation("op-delete", "delete", {}, 2);

    expect(reducePendingOperations(null, [created, deleted])).toBeNull();
  });

  test("orders patches deterministically by predecessor then creation order", () => {
    const second = {
      ...operation("op-2", "update", { patch: { summary: "Second" } }, 20),
      predecessorOperationId: "op-1",
    };
    const first = operation(
      "op-1",
      "update",
      { patch: { summary: "First" } },
      10,
    );

    expect(reducePendingOperations(baseEvent, [second, first])).toMatchObject({
      summary: "Second",
      syncState: "pending",
    });
  });

  test("remote pull rebases disjoint local fields", () => {
    const result = rebaseRemoteSnapshot(
      baseEvent,
      { ...baseEvent, location: "B" },
      [operation("op-edit", "update", { patch: { summary: "New" } }, 1)],
    );

    expect(result.projection).toMatchObject({ summary: "New", location: "B" });
    expect(result.conflicts).toEqual([]);
  });

  test("time fields conflict as one atomic group", () => {
    const result = rebaseRemoteSnapshot(
      baseEvent,
      { ...baseEvent, startMs: 20 },
      [operation("op-edit", "update", { patch: { endMs: 30 } }, 1)],
    );

    expect(result.conflicts).toEqual(["time"]);
    expect(result.projection).toMatchObject({ endMs: 30, syncState: "conflict" });
  });

  test("conflict barriers preserve later intent without compacting across them", () => {
    const barrier = {
      ...operation("op-conflict", "update", { patch: { summary: "Local" } }, 1),
      state: "conflict" as const,
    };
    const later = {
      ...operation("op-later", "update", { patch: { location: "Later" } }, 2),
      predecessorOperationId: "op-conflict",
    };

    expect(reducePendingOperations(baseEvent, [barrier, later])).toMatchObject({
      summary: "Local",
      location: "Later",
      syncState: "conflict",
    });
  });
});
