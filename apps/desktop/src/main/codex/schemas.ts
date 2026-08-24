import { z } from "zod";

const DAY_MS = 24 * 60 * 60 * 1_000;

export const ASSISTANT_PROTOCOL_LIMITS = Object.freeze({
  maxRequestBytes: 4_000,
  maxProviderJsonBytes: 64 * 1_024,
  maxSelectedCalendars: 32,
  maxSummaryMessages: 12,
  maxSummaryMessageBytes: 4_000,
  maxSummaryBytes: 12_000,
  maxClarificationBytes: 1_000,
  maxReads: 8,
  maxReadResults: 100,
  maxAggregateReadResults: 250,
  maxReadContextBytes: 64 * 1_024,
  maxRangeMs: 366 * DAY_MS,
  maxMarkdownBytes: 8_000,
  maxProposals: 8,
  maxTitleBytes: 500,
  maxDescriptionBytes: 4_000,
  maxLocationBytes: 1_000,
  maxAttendees: 100,
  maxAttendeeBytes: 320,
  maxRecurrenceLines: 10,
  maxRecurrenceLineBytes: 500,
} as const);

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function boundedString(maxBytes: number, label: string, allowEmpty = false) {
  return z
    .string()
    .refine(
      (value) => allowEmpty || value.trim().length > 0,
      `${label} is required`,
    )
    .refine((value) => utf8Bytes(value) <= maxBytes, `${label} is too large`)
    .refine(
      (value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value),
      `${label} contains control characters`,
    );
}

const opaqueId = boundedString(256, "identifier");
const calendarIds = z
  .array(opaqueId)
  .max(ASSISTANT_PROTOCOL_LIMITS.maxSelectedCalendars)
  .refine(
    (values) => new Set(values).size === values.length,
    "calendar identifiers must be unique",
  );
const readCalendarIds = calendarIds.refine(
  (values) => values.length > 0,
  "at least one calendar identifier is required",
);

const boundedLimit = z
  .number()
  .int()
  .min(1)
  .max(ASSISTANT_PROTOCOL_LIMITS.maxReadResults);

const rangeFields = {
  startMs: z.number().finite().int(),
  endMs: z.number().finite().int(),
};

function validRange(value: { startMs: number; endMs: number }): boolean {
  return (
    value.endMs > value.startMs &&
    value.endMs - value.startMs <= ASSISTANT_PROTOCOL_LIMITS.maxRangeMs
  );
}

const listCalendarsRead = z
  .object({
    kind: z.literal("listCalendars"),
    limit: boundedLimit,
  })
  .strict();

const searchEventsRead = z
  .object({
    kind: z.literal("searchEvents"),
    calendarIds: readCalendarIds.optional(),
    ...rangeFields,
    query: boundedString(500, "search query").optional(),
    limit: boundedLimit,
  })
  .strict()
  .refine(
    validRange,
    "calendar range must be positive and no longer than 366 days",
  );

const getEventRead = z
  .object({
    kind: z.literal("getEvent"),
    calendarId: opaqueId,
    eventId: opaqueId,
  })
  .strict();

const getAvailabilityRead = z
  .object({
    kind: z.literal("getAvailability"),
    calendarIds: readCalendarIds.optional(),
    ...rangeFields,
    durationMinutes: z
      .number()
      .int()
      .min(5)
      .max(24 * 60),
    limit: boundedLimit,
  })
  .strict()
  .refine(
    validRange,
    "calendar range must be positive and no longer than 366 days",
  );

export const CalendarRead = z.discriminatedUnion("kind", [
  listCalendarsRead,
  searchEventsRead,
  getEventRead,
  getAvailabilityRead,
]);
export type CalendarRead = z.infer<typeof CalendarRead>;

const plannerClarification = z
  .object({
    kind: z.literal("clarification"),
    question: boundedString(
      ASSISTANT_PROTOCOL_LIMITS.maxClarificationBytes,
      "clarification",
    ),
  })
  .strict();

const plannerReads = z
  .object({
    kind: z.literal("reads"),
    reads: z.array(CalendarRead).max(ASSISTANT_PROTOCOL_LIMITS.maxReads),
  })
  .strict();

export const PlannerOutput = z.discriminatedUnion("kind", [
  plannerClarification,
  plannerReads,
]);
export type PlannerOutputValue = z.infer<typeof PlannerOutput>;

const dateKey = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    return (
      !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
    );
  }, "invalid date");

const timedRange = z
  .object({
    kind: z.literal("timed"),
    ...rangeFields,
  })
  .strict()
  .refine(
    validRange,
    "event range must be positive and no longer than 366 days",
  );

const allDayRange = z
  .object({
    kind: z.literal("allDay"),
    startDate: dateKey,
    endDate: dateKey,
  })
  .strict()
  .refine(
    (value) =>
      value.endDate > value.startDate &&
      Date.parse(`${value.endDate}T00:00:00.000Z`) -
        Date.parse(`${value.startDate}T00:00:00.000Z`) <=
        ASSISTANT_PROTOCOL_LIMITS.maxRangeMs,
    "all-day end date must be exclusive, later than start, and within 366 days",
  );

export const AssistantEventRange = z.discriminatedUnion("kind", [
  timedRange,
  allDayRange,
]);

const recurrenceEnd = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("never") }).strict(),
  z.object({ kind: z.literal("onDate"), date: dateKey }).strict(),
  z
    .object({
      kind: z.literal("count"),
      count: z.number().int().min(1).max(10_000),
    })
    .strict(),
]);

const recurrence = z
  .object({
    frequency: z.enum(["daily", "weekly", "monthly", "yearly"]),
    interval: z.number().int().min(1).max(100).optional(),
    weekdays: z
      .array(
        z.enum([
          "monday",
          "tuesday",
          "wednesday",
          "thursday",
          "friday",
          "saturday",
          "sunday",
        ]),
      )
      .min(1)
      .max(7)
      .refine(
        (values) => new Set(values).size === values.length,
        "recurrence weekdays must be unique",
      )
      .optional(),
    end: recurrenceEnd.optional(),
    sourceLines: z
      .array(
        boundedString(
          ASSISTANT_PROTOCOL_LIMITS.maxRecurrenceLineBytes,
          "recurrence line",
        ),
      )
      .max(ASSISTANT_PROTOCOL_LIMITS.maxRecurrenceLines)
      .optional(),
  })
  .strict()
  .refine(
    (value) => value.frequency === "weekly" || value.weekdays === undefined,
    "weekdays are valid only for weekly recurrence",
  );

const attendee = boundedString(
  ASSISTANT_PROTOCOL_LIMITS.maxAttendeeBytes,
  "attendee",
).pipe(z.string().email());
const attendees = z.array(attendee).max(ASSISTANT_PROTOCOL_LIMITS.maxAttendees);
const summary = boundedString(
  ASSISTANT_PROTOCOL_LIMITS.maxTitleBytes,
  "summary",
);
const description = boundedString(
  ASSISTANT_PROTOCOL_LIMITS.maxDescriptionBytes,
  "description",
  true,
);
const location = boundedString(
  ASSISTANT_PROTOCOL_LIMITS.maxLocationBytes,
  "location",
  true,
);
const recurrenceScope = z.enum(["thisEvent", "thisAndFollowing", "allEvents"]);
const eventRevision = z.string().regex(/^revision_[a-f0-9]{32}$/);
const seriesRevision = z.string().regex(/^series_[a-f0-9]{32}$/);

const createProposal = z
  .object({
    kind: z.literal("create"),
    calendarId: opaqueId,
    summary,
    time: AssistantEventRange,
    description: description.optional(),
    location: location.optional(),
    attendees: attendees.optional(),
    recurrence: recurrence.optional(),
  })
  .strict();

const updateChanges = z
  .object({
    summary: summary.optional(),
    time: AssistantEventRange.optional(),
    description: description.optional(),
    location: location.optional(),
    attendees: attendees.optional(),
    recurrence: recurrence.nullable().optional(),
  })
  .strict()
  .refine(
    (value) => Object.values(value).some((entry) => entry !== undefined),
    "update changes cannot be empty",
  );

const updateProposal = z
  .object({
    kind: z.literal("update"),
    calendarId: opaqueId,
    eventId: opaqueId,
    expectedUpdatedAt: z.number().finite().nonnegative(),
    expectedRevision: eventRevision,
    expectedSeriesRevision: seriesRevision.optional(),
    changes: updateChanges,
    scope: recurrenceScope.optional(),
  })
  .strict();

const deleteProposal = z
  .object({
    kind: z.literal("delete"),
    calendarId: opaqueId,
    eventId: opaqueId,
    expectedUpdatedAt: z.number().finite().nonnegative(),
    expectedRevision: eventRevision,
    expectedSeriesRevision: seriesRevision.optional(),
    scope: recurrenceScope,
  })
  .strict();

export const AssistantProposal = z.discriminatedUnion("kind", [
  createProposal,
  updateProposal,
  deleteProposal,
]);
export type AssistantProposalValue = z.infer<typeof AssistantProposal>;

export const FinalizerOutput = z
  .object({
    markdown: boundedString(
      ASSISTANT_PROTOCOL_LIMITS.maxMarkdownBytes,
      "Markdown",
      true,
    ),
    proposals: z
      .array(AssistantProposal)
      .max(ASSISTANT_PROTOCOL_LIMITS.maxProposals),
  })
  .strict();
export type FinalizerOutputValue = z.infer<typeof FinalizerOutput>;

export const ConversationSummaryMessage = z
  .object({
    role: z.enum(["user", "assistant"]),
    text: boundedString(
      ASSISTANT_PROTOCOL_LIMITS.maxSummaryMessageBytes,
      "summary message",
      true,
    ),
  })
  .strict();
export type ConversationSummaryMessage = z.infer<
  typeof ConversationSummaryMessage
>;

export const AssistantAttemptContext = z
  .object({
    conversationId: opaqueId,
    userMessageId: opaqueId,
    assistantMessageId: opaqueId,
    selectedCalendarIds: calendarIds,
    summary: z
      .array(ConversationSummaryMessage)
      .max(ASSISTANT_PROTOCOL_LIMITS.maxSummaryMessages),
  })
  .strict()
  .superRefine((value, context) => {
    const total = value.summary.reduce(
      (count, message) => count + utf8Bytes(message.text),
      0,
    );
    if (total > ASSISTANT_PROTOCOL_LIMITS.maxSummaryBytes) {
      context.addIssue({
        code: "custom",
        message: "ASSISTANT_SUMMARY_TOO_LARGE",
        path: ["summary"],
      });
    }
  });
export type AssistantAttemptContext = z.infer<typeof AssistantAttemptContext>;

export const AssistantCoordinatorRequest = z
  .object({
    text: boundedString(
      ASSISTANT_PROTOCOL_LIMITS.maxRequestBytes,
      "assistant request",
    ),
    timeZone: boundedString(256, "time zone"),
  })
  .strict();

const calendarItem = z
  .object({
    calendarId: opaqueId,
    summary: boundedString(
      ASSISTANT_PROTOCOL_LIMITS.maxTitleBytes,
      "calendar summary",
      true,
    ).optional(),
    selected: z.boolean(),
    writable: z.boolean(),
    timeZone: boundedString(256, "time zone").optional(),
  })
  .strict();

const eventItem = z
  .object({
    eventId: opaqueId,
    calendarId: opaqueId,
    summary: summary.optional(),
    description: description.optional(),
    location: location.optional(),
    startMs: z.number().finite().int(),
    endMs: z.number().finite().int(),
    allDay: z.boolean(),
    attendees: attendees.optional(),
    recurrence: z
      .array(
        boundedString(
          ASSISTANT_PROTOCOL_LIMITS.maxRecurrenceLineBytes,
          "recurrence line",
        ),
      )
      .max(ASSISTANT_PROTOCOL_LIMITS.maxRecurrenceLines)
      .optional(),
    revision: eventRevision,
    seriesRevision: seriesRevision.optional(),
    updatedAt: z.number().finite().nonnegative(),
    writable: z.boolean().optional(),
  })
  .strict()
  .refine(
    (value) => value.endMs > value.startMs,
    "event end must be later than start",
  );

const availabilityItem = z
  .object({
    startMs: z.number().finite().int(),
    endMs: z.number().finite().int(),
  })
  .strict()
  .refine(
    (value) => value.endMs > value.startMs,
    "availability end must be later than start",
  );

const readResultRows = [
  z
    .object({
      readIndex: z.number().int().nonnegative(),
      kind: z.literal("listCalendars"),
      items: z.array(calendarItem),
    })
    .strict(),
  z
    .object({
      readIndex: z.number().int().nonnegative(),
      kind: z.literal("searchEvents"),
      items: z.array(eventItem),
    })
    .strict(),
  z
    .object({
      readIndex: z.number().int().nonnegative(),
      kind: z.literal("getEvent"),
      items: z.array(eventItem).max(1),
    })
    .strict(),
  z
    .object({
      readIndex: z.number().int().nonnegative(),
      kind: z.literal("getAvailability"),
      items: z.array(availabilityItem),
    })
    .strict(),
] as const;

export const CalendarReadResultRow = z.discriminatedUnion(
  "kind",
  readResultRows,
);
export const CalendarReadBatch = z
  .object({ rows: z.array(CalendarReadResultRow) })
  .strict();
export type CalendarReadBatch = z.infer<typeof CalendarReadBatch>;

const forbiddenAuthorityKey =
  /^(?:tool|toolcall|tools|command|shell|argv|executable|filesystem|filepath|path|network|fetch|credential|credentials|token|secret|function|functioncall|endpoint|mcp)$/i;

function rejectAuthorityShapes(value: unknown): void {
  if (Array.isArray(value)) {
    for (const entry of value) rejectAuthorityShapes(entry);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (forbiddenAuthorityKey.test(key)) {
      throw new Error("ASSISTANT_FORBIDDEN_AUTHORITY_SHAPE");
    }
    rejectAuthorityShapes(entry);
  }
}

function parseProviderJson(text: string): unknown {
  if (utf8Bytes(text) > ASSISTANT_PROTOCOL_LIMITS.maxProviderJsonBytes) {
    throw new Error("ASSISTANT_PROVIDER_JSON_TOO_LARGE");
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new Error("ASSISTANT_PROVIDER_JSON_INVALID");
  }
  rejectAuthorityShapes(value);
  return value;
}

export function parsePlannerJson(text: string): PlannerOutputValue {
  const providerValue = parseProviderJson(text);
  if (!providerValue || typeof providerValue !== "object") {
    return PlannerOutput.parse(providerValue);
  }
  const record = providerValue as Record<string, unknown>;
  if (record.kind === "clarification") {
    return PlannerOutput.parse({
      kind: record.kind,
      question: record.question,
    });
  }
  if (record.kind === "reads") {
    const reads = Array.isArray(record.reads)
      ? record.reads.map((read) =>
          read && typeof read === "object"
            ? Object.fromEntries(
                Object.entries(read).filter(([, value]) => value !== null),
              )
            : read,
        )
      : record.reads;
    return PlannerOutput.parse({ kind: record.kind, reads });
  }
  return PlannerOutput.parse(providerValue);
}

export function parseFinalizerJson(text: string): FinalizerOutputValue {
  const providerValue = normalizeStructuredFinalizerInput(
    parseProviderJson(text),
  );
  return normalizeFinalizerOutput(
    FinalizerOutput.parse(providerValue),
  );
}

function stripNullableFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNullableFields);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== null)
      .map(([key, entry]) => [key, stripNullableFields(entry)]),
  );
}

function normalizeStructuredFinalizerInput(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.proposals)) return value;
  return {
    ...record,
    proposals: record.proposals.map((proposal) => {
      if (!proposal || typeof proposal !== "object") return proposal;
      const normalized = stripNullableFields(proposal) as Record<
        string,
        unknown
      >;
      if (normalized.kind !== "update") return normalized;
      const originalChanges = (proposal as Record<string, unknown>).changes;
      if (!originalChanges || typeof originalChanges !== "object") {
        return normalized;
      }
      const recurrence = (originalChanges as Record<string, unknown>)
        .recurrence;
      if (
        recurrence &&
        typeof recurrence === "object" &&
        (recurrence as Record<string, unknown>).kind === "remove"
      ) {
        const changes = normalized.changes as Record<string, unknown>;
        normalized.changes = { ...changes, recurrence: null };
      }
      return normalized;
    }),
  };
}

function normalizedAttendees(
  values: readonly string[] | undefined,
): string[] | undefined {
  if (!values) return undefined;
  return [
    ...new Map(
      values.map((value) => [
        value.trim().toLowerCase(),
        value.trim().toLowerCase(),
      ]),
    ).values(),
  ].sort((left, right) => left.localeCompare(right));
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}

export function normalizeFinalizerOutput(
  value: FinalizerOutputValue,
): FinalizerOutputValue {
  return {
    markdown: value.markdown.trim(),
    proposals: value.proposals.map((proposal) => {
      if (proposal.kind === "create") {
        return withoutUndefined({
          ...proposal,
          calendarId: proposal.calendarId.trim(),
          summary: proposal.summary.trim(),
          description: proposal.description?.trim(),
          location: proposal.location?.trim(),
          attendees: normalizedAttendees(proposal.attendees),
        }) as typeof proposal;
      }
      if (proposal.kind === "update") {
        return {
          ...proposal,
          calendarId: proposal.calendarId.trim(),
          eventId: proposal.eventId.trim(),
          changes: withoutUndefined({
            ...proposal.changes,
            summary: proposal.changes.summary?.trim(),
            description: proposal.changes.description?.trim(),
            location: proposal.changes.location?.trim(),
            attendees: normalizedAttendees(proposal.changes.attendees),
          }) as typeof proposal.changes,
        };
      }
      return {
        ...proposal,
        calendarId: proposal.calendarId.trim(),
        eventId: proposal.eventId.trim(),
      };
    }),
  };
}

export function assertSummaryBounds(
  summaryMessages: readonly ConversationSummaryMessage[],
): void {
  if (summaryMessages.length > ASSISTANT_PROTOCOL_LIMITS.maxSummaryMessages) {
    throw new Error("ASSISTANT_SUMMARY_TOO_LARGE");
  }
  const total = summaryMessages.reduce(
    (bytes, message) => bytes + utf8Bytes(message.text),
    0,
  );
  if (total > ASSISTANT_PROTOCOL_LIMITS.maxSummaryBytes) {
    throw new Error("ASSISTANT_SUMMARY_TOO_LARGE");
  }
}
