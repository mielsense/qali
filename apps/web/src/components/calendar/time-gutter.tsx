import { type CalendarTimeRange, timeRangePct } from "./preferences";
import type { CivilDate, ZonedCalendarClock } from "./zoned-calendar-clock";

export type TimeGridOccurrence = Readonly<{
  instantMs: number;
  offsetMinutes: number;
  fold: 0 | 1;
}>;

export type TimeGridSlot = Readonly<{
  minute: number;
  topPct: number;
  droppable: boolean;
  occurrences: readonly TimeGridOccurrence[];
}>;

export type TimeGutterLabel = Readonly<{
  zone: string;
  minute: number;
  instantMs: number;
  offsetMinutes: number;
  fold: 0 | 1;
  topPct: number;
  label: string;
  repeated: boolean;
}>;

export type TimeGridPlacement = Readonly<{
  topPct: number;
  heightPct: number;
}>;

export function droppableInstantForMinute({
  clock,
  date,
  minute,
  preferredFold = 0,
}: {
  clock: ZonedCalendarClock;
  date: CivilDate;
  minute: number;
  preferredFold?: 0 | 1;
}): number | null {
  const resolution = clock.wallTimeToInstant(date, minute, "reject");
  if (resolution.kind !== "rejected") return resolution.instantMs;
  if (resolution.reason === "gap") return null;
  return (
    (
      resolution.candidates.find(({ fold }) => fold === preferredFold) ??
      resolution.candidates[0]
    )?.instantMs ?? null
  );
}

export function timeGridPlacement({
  clock,
  date,
  startMs,
  endMs,
  timeRange,
}: {
  clock: ZonedCalendarClock;
  date: CivilDate;
  startMs: number;
  endMs: number;
  timeRange: CalendarTimeRange;
}): TimeGridPlacement {
  assertTimeRange(timeRange);
  const day = clock.day(date);
  const minuteAt = (instantMs: number) => {
    if (instantMs <= day.startMs) return timeRange.startHour * 60;
    if (instantMs >= day.endMs) return timeRange.endHour * 60;
    const wall = clock.instantToWallTime(instantMs);
    if (wall.date < date) return timeRange.startHour * 60;
    if (wall.date > date) return timeRange.endHour * 60;
    // Both occurrences of an overlap intentionally occupy the same civil row.
    // The event card's minimum height preserves their hit target.
    return wall.minute;
  };
  const startMinute = minuteAt(startMs);
  const endMinute = Math.max(startMinute, minuteAt(endMs));
  const topPct = timeRangePct(startMinute, timeRange);
  return {
    topPct,
    heightPct: timeRangePct(endMinute, timeRange) - topPct,
  };
}

export function civilIntervalPlacement({
  clock,
  date,
  startMinute,
  endMinute,
  timeRange,
}: {
  clock: ZonedCalendarClock;
  date: CivilDate;
  startMinute: number;
  endMinute: number;
  timeRange: CalendarTimeRange;
}): Readonly<{
  startMs: number;
  endMs: number;
  topPct: number;
  heightPct: number;
}> | null {
  if (endMinute <= startMinute || startMinute < 0 || endMinute > 24 * 60) {
    throw new RangeError("Civil interval is outside one ordered day");
  }
  const day = clock.day(date);
  const startMs = droppableInstantForMinute({
    clock,
    date,
    minute: startMinute,
  });
  const endMs =
    endMinute === 24 * 60
      ? day.endMs
      : droppableInstantForMinute({ clock, date, minute: endMinute });
  if (startMs === null || endMs === null) return null;
  return {
    startMs,
    endMs,
    ...timeGridPlacement({ clock, date, startMs, endMs, timeRange }),
  };
}

function assertTimeRange(timeRange: CalendarTimeRange): void {
  if (
    !Number.isInteger(timeRange.startHour) ||
    !Number.isInteger(timeRange.endHour) ||
    timeRange.startHour < 0 ||
    timeRange.endHour > 24 ||
    timeRange.endHour <= timeRange.startHour
  ) {
    throw new RangeError("Time gutter range is invalid");
  }
}

export function timeGridSlots({
  clock,
  date,
  timeRange,
  stepMinutes = 15,
}: {
  clock: ZonedCalendarClock;
  date: CivilDate;
  timeRange: CalendarTimeRange;
  stepMinutes?: number;
}): readonly TimeGridSlot[] {
  assertTimeRange(timeRange);
  if (!Number.isInteger(stepMinutes) || stepMinutes <= 0 || 60 % stepMinutes) {
    throw new RangeError("Grid step must divide an hour evenly");
  }
  const slots: TimeGridSlot[] = [];
  for (
    let minute = timeRange.startHour * 60;
    minute < timeRange.endHour * 60;
    minute += stepMinutes
  ) {
    const resolution = clock.wallTimeToInstant(date, minute, "reject");
    const occurrences =
      resolution.kind === "rejected"
        ? resolution.reason === "ambiguous"
          ? resolution.candidates
          : []
        : [
            {
              instantMs: resolution.instantMs,
              offsetMinutes: resolution.offsetMinutes,
              fold: resolution.fold,
            },
          ];
    slots.push(
      Object.freeze({
        minute,
        topPct: timeRangePct(minute, timeRange),
        droppable: occurrences.length > 0,
        occurrences: Object.freeze(occurrences),
      }),
    );
  }
  return Object.freeze(slots);
}

export function timeGutterLabels({
  clock,
  date,
  timeRange,
  timeZones,
}: {
  clock: ZonedCalendarClock;
  date: CivilDate;
  timeRange: CalendarTimeRange;
  timeZones: readonly string[];
}): readonly TimeGutterLabel[] {
  assertTimeRange(timeRange);
  if (timeZones.length < 1 || timeZones.length > 3) {
    throw new RangeError("Calendar supports one to three time-zone gutters");
  }
  const labels: TimeGutterLabel[] = [];
  for (
    let minute = (timeRange.startHour + 1) * 60;
    minute < timeRange.endHour * 60;
    minute += 60
  ) {
    const resolution = clock.wallTimeToInstant(date, minute, "reject");
    if (resolution.kind === "rejected" && resolution.reason === "gap") continue;
    const projected = clock.secondaryLabelsForTick(date, minute, timeZones);
    for (const zone of timeZones) {
      const zoneLabels = projected.filter((label) => label.zone === zone);
      const repeated = zoneLabels.length > 1;
      for (const item of zoneLabels) {
        const compact = new Intl.DateTimeFormat("en-GB", {
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h23",
          timeZone: zone,
        }).format(item.instantMs);
        labels.push(
          Object.freeze({
            zone,
            minute,
            instantMs: item.instantMs,
            offsetMinutes: item.offsetMinutes,
            fold: item.fold,
            topPct: timeRangePct(minute, timeRange),
            label: repeated ? item.label : compact,
            repeated,
          }),
        );
      }
    }
  }
  return Object.freeze(labels);
}

interface TimeGutterProps {
  timeZone: string;
  labels: readonly TimeGutterLabel[];
}

export function TimeGutter({ timeZone, labels }: TimeGutterProps) {
  return (
    <div className="relative h-full">
      {labels
        .filter((label) => label.zone === timeZone)
        .map((label) => (
          <span
            key={`${label.instantMs}:${label.offsetMinutes}:${label.fold}`}
            data-instant={label.instantMs}
            data-offset={label.offsetMinutes}
            data-fold={label.fold}
            className="absolute inset-x-0 -translate-y-1/2 truncate text-center text-[10px] leading-3 tabular-nums text-muted-foreground"
            style={{
              top: `${label.topPct}%`,
              ...(label.fold === 1 ? { marginTop: 10 } : {}),
            }}
          >
            {label.label}
          </span>
        ))}
    </div>
  );
}
