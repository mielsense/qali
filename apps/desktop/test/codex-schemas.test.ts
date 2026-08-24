import { describe, expect, test } from "bun:test";

import {
  ASSISTANT_PROTOCOL_LIMITS,
  AssistantAttemptContext,
  AssistantEventRange,
  CalendarRead,
  FinalizerOutput,
  PlannerOutput,
  normalizeFinalizerOutput,
  parseFinalizerJson,
  parsePlannerJson,
} from "../src/main/codex/schemas";

function schemaKeywords(value: unknown, keyword: string): string[] {
  const paths: string[] = [];
  const visit = (entry: unknown, path: string) => {
    if (Array.isArray(entry)) {
      entry.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    if (!entry || typeof entry !== "object") return;
    for (const [key, child] of Object.entries(entry)) {
      if (key === keyword) paths.push(`${path}.${key}`);
      visit(child, `${path}.${key}`);
    }
  };
  visit(value, "$schema");
  return paths;
}

test("production response schemas use Codex-compatible structured-output shapes", async () => {
  const resources = new URL("../resources/", import.meta.url);
  for (const name of [
    "codex-planner-output.schema.json",
    "codex-finalizer-output.schema.json",
  ]) {
    const schema = await Bun.file(new URL(name, resources)).json();
    expect(schema).toMatchObject({ type: "object", additionalProperties: false });
    expect(schemaKeywords(schema, "oneOf")).toEqual([]);
  }
});

const DAY_MS = 24 * 60 * 60 * 1_000;

describe("calendar-only Codex schemas", () => {
  test("committed phase schemas are distinct closed JSON resources", async () => {
    const resources = new URL("../resources/", import.meta.url);
    const planner = await Bun.file(
      new URL("codex-planner-output.schema.json", resources),
    ).json();
    const finalizer = await Bun.file(
      new URL("codex-finalizer-output.schema.json", resources),
    ).json();
    expect(planner.additionalProperties).toBe(false);
    expect(planner.type).toBe("object");
    expect(planner.properties.reads.anyOf[0].maxItems).toBe(8);
    expect(finalizer.additionalProperties).toBe(false);
    expect(finalizer.properties.proposals.maxItems).toBe(8);
    expect(JSON.stringify(finalizer)).toContain("expectedRevision");
    expect(JSON.stringify(planner)).not.toContain("proposals");
  });

  test("broker attempt context is strict and applies aggregate summary bounds", () => {
    const value = {
      conversationId: "thread-1",
      userMessageId: "message-1",
      assistantMessageId: "message-2",
      selectedCalendarIds: ["primary"],
      summary: [{ role: "user" as const, text: "Earlier request" }],
    };
    expect(AssistantAttemptContext.parse(value)).toEqual(value);
    expect(() =>
      AssistantAttemptContext.parse({ ...value, brokerToken: "secret" }),
    ).toThrow();
    expect(() =>
      AssistantAttemptContext.parse({
        ...value,
        summary: Array.from({ length: 4 }, () => ({
          role: "assistant",
          text: "é".repeat(2_000),
        })),
      }),
    ).toThrow("ASSISTANT_SUMMARY_TOO_LARGE");
  });

  test("planner is a strict clarification-or-reads union", () => {
    expect(
      PlannerOutput.parse({ kind: "clarification", question: "Which Friday?" }),
    ).toEqual({ kind: "clarification", question: "Which Friday?" });
    expect(() =>
      PlannerOutput.parse({
        kind: "clarification",
        question: "Which Friday?",
        reads: [],
      }),
    ).toThrow();
    expect(() =>
      PlannerOutput.parse({
        kind: "reads",
        reads: [{ kind: "fetchUrl", url: "https://example.test" }],
      }),
    ).toThrow();
  });

  test("planner accepts a 366-day edge and rejects one millisecond more", () => {
    const exact = {
      kind: "reads" as const,
      reads: [
        {
          kind: "searchEvents" as const,
          calendarIds: ["primary"],
          startMs: 0,
          endMs: 366 * DAY_MS,
          limit: 100,
        },
      ],
    };
    expect(PlannerOutput.parse(exact)).toEqual(exact);
    expect(() =>
      PlannerOutput.parse({
        ...exact,
        reads: [{ ...exact.reads[0], endMs: 366 * DAY_MS + 1 }],
      }),
    ).toThrow();
  });

  test("all-day proposals use real exclusive dates and the same 366-day ceiling", () => {
    expect(
      AssistantEventRange.parse({
        kind: "allDay",
        startDate: "2024-01-01",
        endDate: "2025-01-01",
      }),
    ).toBeTruthy();
    expect(() =>
      AssistantEventRange.parse({
        kind: "allDay",
        startDate: "2024-01-01",
        endDate: "2025-01-02",
      }),
    ).toThrow();
    expect(() =>
      AssistantEventRange.parse({
        kind: "allDay",
        startDate: "2026-02-30",
        endDate: "2026-03-02",
      }),
    ).toThrow();
  });

  test("planner bounds read count, per-read count, and selected identifiers", () => {
    const read = {
      kind: "listCalendars" as const,
      limit: ASSISTANT_PROTOCOL_LIMITS.maxReadResults,
    };
    expect(
      PlannerOutput.parse({
        kind: "reads",
        reads: Array.from(
          { length: ASSISTANT_PROTOCOL_LIMITS.maxReads },
          () => read,
        ),
      }).reads,
    ).toHaveLength(ASSISTANT_PROTOCOL_LIMITS.maxReads);
    expect(() =>
      PlannerOutput.parse({
        kind: "reads",
        reads: Array.from(
          { length: ASSISTANT_PROTOCOL_LIMITS.maxReads + 1 },
          () => read,
        ),
      }),
    ).toThrow();
    expect(() =>
      PlannerOutput.parse({
        kind: "reads",
        reads: [
          {
            kind: "searchEvents",
            calendarIds: Array.from(
              { length: ASSISTANT_PROTOCOL_LIMITS.maxSelectedCalendars + 1 },
              (_, index) => `calendar-${index}`,
            ),
            startMs: 0,
            endMs: DAY_MS,
            limit: 1,
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      CalendarRead.parse({
        kind: "searchEvents",
        calendarIds: [],
        startMs: 0,
        endMs: DAY_MS,
        limit: 1,
      }),
    ).toThrow();
  });

  test("provider JSON is byte bounded and validated again after parsing", () => {
    expect(() =>
      parsePlannerJson(
        "x".repeat(ASSISTANT_PROTOCOL_LIMITS.maxProviderJsonBytes + 1),
      ),
    ).toThrow("ASSISTANT_PROVIDER_JSON_TOO_LARGE");
    expect(() =>
      parsePlannerJson('{"kind":"reads","reads":[],"tool":"shell"}'),
    ).toThrow();
    expect(() =>
      parsePlannerJson('{"kind":"reads","reads":[],"network":{}}'),
    ).toThrow();
    expect(() =>
      parsePlannerJson('{"kind":"reads","reads":[]} trailing'),
    ).toThrow();
  });

  test("normalizes explicit nullable wire fields from Codex before strict parsing", () => {
    expect(
      parsePlannerJson(
        JSON.stringify({
          kind: "reads",
          question: null,
          reads: [
            {
              kind: "searchEvents",
              calendarIds: null,
              startMs: 0,
              endMs: DAY_MS,
              query: null,
              limit: 10,
            },
          ],
        }),
      ),
    ).toEqual({
      kind: "reads",
      reads: [
        { kind: "searchEvents", startMs: 0, endMs: DAY_MS, limit: 10 },
      ],
    });

    expect(
      parseFinalizerJson(
        JSON.stringify({
          markdown: "Ready.",
          proposals: [
            {
              kind: "create",
              calendarId: "primary",
              summary: "Review",
              time: { kind: "timed", startMs: 0, endMs: 60_000 },
              description: null,
              location: null,
              attendees: null,
              recurrence: null,
            },
          ],
        }),
      ),
    ).toEqual({
      markdown: "Ready.",
      proposals: [
        {
          kind: "create",
          calendarId: "primary",
          summary: "Review",
          time: { kind: "timed", startMs: 0, endMs: 60_000 },
        },
      ],
    });
  });

  test("finalizer accepts ordinary URL-like calendar text but no authority fields", () => {
    const value = {
      markdown:
        "Meet at https://example.test/room — the location came from the calendar.",
      proposals: [
        {
          kind: "create" as const,
          calendarId: "primary",
          summary: "Review https://example.test/spec",
          time: { kind: "timed" as const, startMs: 100, endMs: 200 },
          location: "https://meet.example.test/abc",
          attendees: ["Person@example.test"],
        },
      ],
    };
    expect(FinalizerOutput.parse(value)).toMatchObject(value);
    expect(() =>
      FinalizerOutput.parse({
        ...value,
        proposals: [{ ...value.proposals[0], shell: "rm -rf /" }],
      }),
    ).toThrow();
    expect(() =>
      parseFinalizerJson(
        JSON.stringify({ ...value, toolCall: { name: "calendar" } }),
      ),
    ).toThrow();
  });

  test("finalizer bounds Markdown, proposals, attendees, strings, and recurrence", () => {
    expect(() =>
      FinalizerOutput.parse({
        markdown: "é".repeat(ASSISTANT_PROTOCOL_LIMITS.maxMarkdownBytes),
        proposals: [],
      }),
    ).toThrow();
    expect(() =>
      FinalizerOutput.parse({
        markdown: "ok",
        proposals: Array.from(
          { length: ASSISTANT_PROTOCOL_LIMITS.maxProposals + 1 },
          (_, index) => ({
            kind: "create",
            calendarId: "primary",
            summary: `event-${index}`,
            time: { kind: "timed", startMs: 100, endMs: 200 },
          }),
        ),
      }),
    ).toThrow();
    expect(() =>
      FinalizerOutput.parse({
        markdown: "ok",
        proposals: [
          {
            kind: "create",
            calendarId: "primary",
            summary: "meeting",
            time: { kind: "timed", startMs: 100, endMs: 200 },
            attendees: Array.from(
              { length: ASSISTANT_PROTOCOL_LIMITS.maxAttendees + 1 },
              (_, index) => `person${index}@example.test`,
            ),
          },
        ],
      }),
    ).toThrow();
  });

  test("update and delete require identity, current-state version, and recurrence scope", () => {
    expect(() =>
      FinalizerOutput.parse({
        markdown: "ok",
        proposals: [
          {
            kind: "update",
            calendarId: "primary",
            eventId: "event-1",
            expectedUpdatedAt: 10,
            changes: {},
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      FinalizerOutput.parse({
        markdown: "ok",
        proposals: [
          {
            kind: "delete",
            calendarId: "primary",
            eventId: "event-1",
            expectedUpdatedAt: 10,
          },
        ],
      }),
    ).toThrow();
    expect(
      FinalizerOutput.parse({
        markdown: "ok",
        proposals: [
          {
            kind: "delete",
            calendarId: "primary",
            eventId: "event-1",
            expectedUpdatedAt: 10,
            expectedRevision: "revision_00000000000000000000000000000000",
            scope: "thisEvent",
          },
        ],
      }).proposals[0],
    ).toMatchObject({ kind: "delete", scope: "thisEvent" });
  });

  test("normalization is deterministic without erasing legitimate text", () => {
    const normalized = normalizeFinalizerOutput(
      FinalizerOutput.parse({
        markdown: "  Calendar answer  ",
        proposals: [
          {
            kind: "create",
            calendarId: " primary ",
            summary: "  Planning call  ",
            time: { kind: "timed", startMs: 100, endMs: 200 },
            attendees: ["B@example.test", "a@example.test", "b@example.test"],
          },
        ],
      }),
    );
    expect(normalized).toEqual({
      markdown: "Calendar answer",
      proposals: [
        {
          kind: "create",
          calendarId: "primary",
          summary: "Planning call",
          time: { kind: "timed", startMs: 100, endMs: 200 },
          attendees: ["a@example.test", "b@example.test"],
        },
      ],
    });
  });
});
