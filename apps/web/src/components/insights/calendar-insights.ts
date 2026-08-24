const DAY_MS = 86_400_000;
const WINDOW_DAYS = 28;

export type CalendarInsightEvent = Readonly<{
  startMs: number;
  endMs: number;
  allDay?: boolean;
  status?: string;
}>;

export type CalendarInsightDay = Readonly<{
  key: string;
  label: string;
  hours: number;
  events: number;
}>;

export type CalendarInsightWeekday = Readonly<{
  label: string;
  shortLabel: string;
  hours: number;
}>;

export type CalendarInsightDaypart = Readonly<{
  label: string;
  hours: number;
}>;

export type CalendarInsights = Readonly<{
  eventCount: number;
  scheduledHours: number;
  averageEventMinutes: number;
  busiestWeekday: string;
  activeDays: number;
  longestEventMinutes: number;
  daily: readonly CalendarInsightDay[];
  weekdays: readonly CalendarInsightWeekday[];
  dayparts: readonly CalendarInsightDaypart[];
}>;

const WEEKDAYS = [
  ["Monday", "Mon"],
  ["Tuesday", "Tue"],
  ["Wednesday", "Wed"],
  ["Thursday", "Thu"],
  ["Friday", "Fri"],
  ["Saturday", "Sat"],
  ["Sunday", "Sun"],
] as const;

const DAYPARTS = ["Morning", "Afternoon", "Evening", "Night"] as const;

function dayKey(timestamp: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(timestamp);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function weekday(timestamp: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
  }).format(timestamp);
}

function dayLabel(timestamp: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    day: "numeric",
  }).format(timestamp);
}

function eventHour(timestamp: number, timeZone: string): number {
  const hour = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    hourCycle: "h23",
  })
    .formatToParts(timestamp)
    .find((part) => part.type === "hour")?.value;
  return Number(hour ?? 0);
}

function daypartFor(timestamp: number, timeZone: string) {
  const hour = eventHour(timestamp, timeZone);
  if (hour >= 5 && hour < 12) return "Morning";
  if (hour >= 12 && hour < 17) return "Afternoon";
  if (hour >= 17 && hour < 22) return "Evening";
  return "Night";
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export function buildCalendarInsights(
  events: readonly CalendarInsightEvent[],
  nowMs: number,
  timeZone: string,
): CalendarInsights {
  const dailyMutable = Array.from({ length: WINDOW_DAYS }, (_, index) => {
    const timestamp = nowMs - (WINDOW_DAYS - 1 - index) * DAY_MS;
    return {
      key: dayKey(timestamp, timeZone),
      label: dayLabel(timestamp, timeZone),
      hours: 0,
      events: 0,
    };
  });
  const dailyByKey = new Map(dailyMutable.map((day) => [day.key, day]));
  const weekdayHours = new Map<string, number>(
    WEEKDAYS.map(([label]) => [label, 0]),
  );
  const daypartHours = new Map<string, number>(
    DAYPARTS.map((label) => [label, 0]),
  );
  let durationMinutes = 0;
  let eventCount = 0;
  let longestEventMinutes = 0;

  for (const event of events) {
    if (
      event.allDay ||
      event.status === "cancelled" ||
      !Number.isFinite(event.startMs) ||
      !Number.isFinite(event.endMs) ||
      event.endMs <= event.startMs
    ) {
      continue;
    }
    const day = dailyByKey.get(dayKey(event.startMs, timeZone));
    if (!day) continue;
    // A single malformed or multi-day event should not dominate the chart.
    const minutes = Math.min((event.endMs - event.startMs) / 60_000, 1_440);
    eventCount += 1;
    durationMinutes += minutes;
    longestEventMinutes = Math.max(longestEventMinutes, minutes);
    day.events += 1;
    day.hours += minutes / 60;
    const eventWeekday = weekday(event.startMs, timeZone);
    weekdayHours.set(
      eventWeekday,
      (weekdayHours.get(eventWeekday) ?? 0) + minutes / 60,
    );
    const eventDaypart = daypartFor(event.startMs, timeZone);
    daypartHours.set(
      eventDaypart,
      (daypartHours.get(eventDaypart) ?? 0) + minutes / 60,
    );
  }

  const weekdays = WEEKDAYS.map(([label, shortLabel]) => ({
    label,
    shortLabel,
    hours: round(weekdayHours.get(label) ?? 0),
  }));
  const busiest = weekdays.reduce((current, candidate) =>
    candidate.hours > current.hours ? candidate : current,
  );
  const dayparts = DAYPARTS.map((label) => ({
    label,
    hours: round(daypartHours.get(label) ?? 0),
  }));

  return {
    eventCount,
    scheduledHours: round(durationMinutes / 60),
    averageEventMinutes: eventCount ? Math.round(durationMinutes / eventCount) : 0,
    busiestWeekday: busiest.hours > 0 ? busiest.label : "—",
    activeDays: dailyMutable.filter((day) => day.events > 0).length,
    longestEventMinutes: Math.round(longestEventMinutes),
    daily: dailyMutable.map((day) => ({ ...day, hours: round(day.hours) })),
    weekdays,
    dayparts,
  };
}

export const CALENDAR_INSIGHT_WINDOW_DAYS = WINDOW_DAYS;
