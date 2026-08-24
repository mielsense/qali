export type CreateCalendarCandidate = Readonly<{
  googleCalendarId: string;
  accessRole?: string;
  primary?: boolean;
}>;

export function isWritableCalendar(
  calendar: CreateCalendarCandidate,
): boolean {
  return calendar.accessRole === "owner" || calendar.accessRole === "writer";
}

/** Resolve a creation target without ever reviving a removed or read-only
 * preference. An explicit form choice wins, then the durable default, then the
 * provider primary and finally the first writable calendar. */
export function resolveCreateCalendarId(
  calendars: readonly CreateCalendarCandidate[],
  explicitCalendarId: string | undefined,
  defaultCalendarId: string | null | undefined,
): string | undefined {
  const writable = calendars.filter(isWritableCalendar);
  const selected = (calendarId: string | null | undefined) =>
    calendarId
      ? writable.find(
          (calendar) => calendar.googleCalendarId === calendarId,
        )?.googleCalendarId
      : undefined;

  return (
    selected(explicitCalendarId) ??
    selected(defaultCalendarId) ??
    writable.find((calendar) => calendar.primary)?.googleCalendarId ??
    writable[0]?.googleCalendarId
  );
}
