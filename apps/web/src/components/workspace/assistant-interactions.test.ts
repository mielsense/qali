// @ts-expect-error Bun supplies its test module at runtime; the web app's
// TypeScript config intentionally includes browser globals only.
import { describe, expect, test } from "bun:test";

import {
  acknowledgedAssistantUserMessageId,
  assistantAttemptSettled,
  assistantFailurePresentation,
  freshAssistantThreadId,
  isNearScrollBottom,
  revealTargetForAction,
  safeAssistantLink,
  shouldOpenAssistantShortcut,
  shouldSendAssistantMessage,
} from "./assistant-interactions";
import { assistantSendError } from "@/lib/desktop/assistant";

describe("assistant interactions", () => {
  test("selects the newly created fresh-chat thread only after send acceptance", () => {
    expect(
      freshAssistantThreadId({
        startFresh: true,
        currentThreadId: null,
        latestThreadId: "older-thread",
        acceptedPreviousThreadId: "older-thread",
      }),
    ).toBeNull();
    expect(
      freshAssistantThreadId({
        startFresh: true,
        currentThreadId: null,
        latestThreadId: "new-thread",
        acceptedPreviousThreadId: "older-thread",
      }),
    ).toBe("new-thread");
  });

  test("keeps an accepted attempt active until its durable reply settles", () => {
    const prior = { _id: "old", role: "user", blocks: [{ type: "text", text: "Earlier" }] };
    const accepted = { _id: "new", role: "user", blocks: [{ type: "text", text: "Find time" }] };
    expect(assistantAttemptSettled([prior, accepted], "old", "Find time")).toBe(false);
    expect(
      assistantAttemptSettled(
        [prior, accepted, { _id: "reply", role: "assistant", status: "complete", blocks: [{ type: "text", text: "Here is a time" }] }],
        "old",
        "Find time",
      ),
    ).toBe(true);
  });
  test("maps every known assistant failure to bounded recovery copy", () => {
    expect(assistantFailurePresentation("authentication-required")).toEqual({
      title: "Sign in to Codex",
      action: "sign-in",
    });
    expect(assistantFailurePresentation("outcome-unknown")).toEqual({
      title: "The response outcome is unknown",
      action: null,
    });
  });
  test("keeps typed desktop failures out of the pending-send lifecycle", () => {
    expect(assistantSendError({ kind: "rejected", reason: "schema-failure" }))
      .toMatch(/response/i);
    expect(assistantSendError({ kind: "rejected", reason: "cancelled" }))
      .toMatch(/cancelled/i);
    expect(assistantSendError({ kind: "accepted", attemptId: "attempt_1" }))
      .toBeNull();
  });
  test("follows scrolling only near the bottom", () => {
    expect(
      isNearScrollBottom({ scrollHeight: 500, scrollTop: 260, clientHeight: 200 }),
    ).toBe(true);
    expect(
      isNearScrollBottom({ scrollHeight: 500, scrollTop: 200, clientHeight: 200 }),
    ).toBe(false);
  });

  test("does not send Enter while composing or adding a newline", () => {
    expect(
      shouldSendAssistantMessage({
        key: "Enter",
        shiftKey: false,
        isComposing: false,
      }),
    ).toBe(true);
    expect(
      shouldSendAssistantMessage({
        key: "Enter",
        shiftKey: false,
        isComposing: true,
      }),
    ).toBe(false);
    expect(
      shouldSendAssistantMessage({
        key: "Enter",
        shiftKey: true,
        isComposing: false,
      }),
    ).toBe(false);
  });

  test("respects consumed, editable, and blocked assistant shortcuts", () => {
    const event = {
      key: "j",
      metaKey: true,
      ctrlKey: false,
      defaultPrevented: false,
    };
    expect(
      shouldOpenAssistantShortcut(event, {
        blocked: false,
        editableTarget: false,
      }),
    ).toBe(true);
    expect(
      shouldOpenAssistantShortcut(
        { ...event, defaultPrevented: true },
        { blocked: false, editableTarget: false },
      ),
    ).toBe(false);
    expect(
      shouldOpenAssistantShortcut(event, {
        blocked: false,
        editableTarget: true,
      }),
    ).toBe(false);
    expect(
      shouldOpenAssistantShortcut(event, {
        blocked: true,
        editableTarget: false,
      }),
    ).toBe(false);
  });

  test("allows only absolute HTTP links", () => {
    expect(safeAssistantLink("https://example.com/path")).toBe(
      "https://example.com/path",
    );
    expect(safeAssistantLink("javascript:alert(1)")).toBeNull();
    expect(safeAssistantLink("data:text/html,unsafe")).toBeNull();
    expect(safeAssistantLink("/internal")).toBeNull();
  });

  test("acknowledges only the newly appended matching user message", () => {
    const previous = {
      _id: "old",
      role: "user",
      blocks: [{ type: "text", text: "Same prompt" }],
    };
    expect(
      acknowledgedAssistantUserMessageId([previous], "old", "Same prompt"),
    ).toBeNull();
    expect(
      acknowledgedAssistantUserMessageId(
        [
          previous,
          {
            _id: "new",
            role: "user",
            blocks: [{ type: "text", text: "Same prompt" }],
          },
        ],
        "old",
        "Same prompt",
      ),
    ).toBe("new");
  });

  describe("reveal target for an applied proposal", () => {
    test("created events flash by operationId at their start time", () => {
      expect(
        revealTargetForAction({
          tool: "create_event",
          operationId: "goog-abc",
          input: JSON.stringify({
            summary: "Sync",
            time: { kind: "timed", startMs: 1_000, endMs: 2_000 },
          }),
        }),
      ).toEqual({ flashId: "goog-abc", startMs: 1_000 });
    });

    test("a created all-day event flashes without a scroll target", () => {
      expect(
        revealTargetForAction({
          tool: "create_event",
          operationId: "goog-allday",
          input: JSON.stringify({
            time: { kind: "allDay", startDate: "2026-08-07", endDate: "2026-08-08" },
          }),
        }),
      ).toEqual({ flashId: "goog-allday" });
    });

    test("a created event with no operationId has nothing to reveal", () => {
      expect(
        revealTargetForAction({
          tool: "create_event",
          input: JSON.stringify({
            time: { kind: "timed", startMs: 1, endMs: 2 },
          }),
        }),
      ).toBeNull();
    });

    test("moves and timed updates flash the event by id at the new time", () => {
      expect(
        revealTargetForAction({
          tool: "move_event",
          input: JSON.stringify({
            eventId: "ev1",
            time: { kind: "timed", startMs: 5_000, endMs: 6_000 },
          }),
        }),
      ).toEqual({ flashId: "ev1", startMs: 5_000 });
    });

    test("an update with no new time pulses the card in place", () => {
      expect(
        revealTargetForAction({
          tool: "update_event",
          input: JSON.stringify({ eventId: "ev2", summary: "Renamed" }),
        }),
      ).toEqual({ flashId: "ev2" });
    });

    test("deletions reveal nothing", () => {
      expect(
        revealTargetForAction({
          tool: "delete_event",
          input: JSON.stringify({ eventId: "ev3" }),
        }),
      ).toBeNull();
    });

    test("malformed input is handled gracefully", () => {
      expect(
        revealTargetForAction({ tool: "create_event", input: "not json" }),
      ).toBeNull();
    });
  });
});
