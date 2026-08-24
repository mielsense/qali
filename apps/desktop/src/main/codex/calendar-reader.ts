import {
  ASSISTANT_PROTOCOL_LIMITS,
  CalendarReadBatch,
  type CalendarRead,
  type CalendarReadBatch as CalendarReadBatchValue,
} from "./schemas";

export type CalendarReadAuthority = Readonly<{
  attemptId: string;
  selectedCalendarIds: readonly string[];
}>;

export interface CalendarReader {
  execute(
    reads: readonly CalendarRead[],
    authority?: CalendarReadAuthority,
  ): Promise<CalendarReadBatchValue>;
}

export type AssistantCalendarReadClient = Readonly<{
  read(
    input: Readonly<{
      attemptId: string;
      selectedCalendarIds: readonly string[];
      reads: readonly CalendarRead[];
    }>,
  ): Promise<unknown>;
}>;

function itemKey(value: Record<string, unknown>): string {
  return [
    value.calendarId,
    value.eventId,
    value.startMs,
    value.endMs,
    value.summary,
  ]
    .map((entry) => String(entry ?? ""))
    .join("\u0000");
}

export function normalizeCalendarReadBatch(
  value: unknown,
  reads: readonly CalendarRead[],
): CalendarReadBatchValue {
  const parsed = CalendarReadBatch.parse(value);
  if (parsed.rows.length !== reads.length) {
    throw new Error("ASSISTANT_READ_RESULT_MISMATCH");
  }
  let itemCount = 0;
  const rows = parsed.rows.map((row, index) => {
    if (row.readIndex !== index || row.kind !== reads[index]?.kind) {
      throw new Error("ASSISTANT_READ_RESULT_MISMATCH");
    }
    if (row.items.length > ASSISTANT_PROTOCOL_LIMITS.maxReadResults) {
      throw new Error("ASSISTANT_READ_RESULT_TOO_LARGE");
    }
    itemCount += row.items.length;
    return {
      ...row,
      items: [...row.items].sort((left, right) =>
        itemKey(left as unknown as Record<string, unknown>).localeCompare(
          itemKey(right as unknown as Record<string, unknown>),
        ),
      ),
    } as typeof row;
  });
  if (itemCount > ASSISTANT_PROTOCOL_LIMITS.maxAggregateReadResults) {
    throw new Error("ASSISTANT_READ_RESULT_TOO_LARGE");
  }
  const result = { rows } as CalendarReadBatchValue;
  if (
    Buffer.byteLength(JSON.stringify(result), "utf8") >
    ASSISTANT_PROTOCOL_LIMITS.maxReadContextBytes
  ) {
    throw new Error("ASSISTANT_READ_CONTEXT_TOO_LARGE");
  }
  return result;
}

export function createApplicationCalendarReader(
  client: AssistantCalendarReadClient,
): CalendarReader {
  return {
    async execute(reads, authority) {
      if (!authority) throw new Error("ASSISTANT_READ_AUTHORITY_REQUIRED");
      if (reads.length > ASSISTANT_PROTOCOL_LIMITS.maxReads) {
        throw new Error("ASSISTANT_TOO_MANY_READS");
      }
      const value = await client.read({
        attemptId: authority.attemptId,
        selectedCalendarIds: authority.selectedCalendarIds,
        reads,
      });
      return normalizeCalendarReadBatch(value, reads);
    },
  };
}
