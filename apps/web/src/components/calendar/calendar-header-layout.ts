import type { ZonedCalendarClock } from "./zoned-calendar-clock";

export const CALENDAR_HEADER_LAYOUT = Object.freeze({
  toolbarHeight: 44,
  dayStripHeight: 34,
  dayLabelAlignment: "center" as const,
  dayLabelFlow: "inline" as const,
  topHairline: false,
  edgeStyle: "flat" as const,
  timeZoneOrder: "references-first-primary-last" as const,
  continuousDividers: true,
  scrollOwner: "timed-grid" as const,
});

export const ALL_DAY_ROW_HEIGHT = 36;
export const MAX_EXPANDED_ALL_DAY_ROWS = 3;
export const TIME_ZONE_GUTTER_WIDTH = 48;
export const TIME_ZONE_GUTTER_PADDING = 6;

export function allDayBandMetrics({
  laneCount,
  expanded,
}: {
  laneCount: number;
  expanded: boolean;
}): Readonly<{
  visibleRows: 1 | 2 | 3;
  height: number;
  internallyScrollable: boolean;
}> {
  if (!Number.isInteger(laneCount) || laneCount < 0) {
    throw new RangeError("All-day lane count must be a non-negative integer");
  }
  if (laneCount === 0) {
    return { visibleRows: 1, height: 0, internallyScrollable: false };
  }
  const visibleRows = (
    expanded ? Math.min(laneCount, MAX_EXPANDED_ALL_DAY_ROWS) : 1
  ) as 1 | 2 | 3;
  return {
    visibleRows,
    height: visibleRows * ALL_DAY_ROW_HEIGHT,
    internallyScrollable: expanded && laneCount > MAX_EXPANDED_ALL_DAY_ROWS,
  };
}

export function gutterWidth(zoneCount: 1 | 2 | 3): number {
  if (!Number.isInteger(zoneCount) || zoneCount < 1 || zoneCount > 3) {
    throw new RangeError("Calendar supports one to three time-zone gutters");
  }
  return zoneCount * TIME_ZONE_GUTTER_WIDTH + TIME_ZONE_GUTTER_PADDING * 2;
}

export function calendarTimeZoneColumns(
  primaryTimeZone: string,
  secondaryTimeZones: readonly string[],
): ReadonlyArray<{
  kind: "primary" | "reference";
  timeZone: string;
}> {
  return [
    ...secondaryTimeZones.slice(0, 2).map((timeZone) => ({
      kind: "reference" as const,
      timeZone,
    })),
    { kind: "primary" as const, timeZone: primaryTimeZone },
  ];
}

export function gridHeight({
  startHour,
  endHour,
  hourHeight,
}: {
  startHour: number;
  endHour: number;
  hourHeight: number;
}): number {
  if (
    !Number.isInteger(startHour) ||
    !Number.isInteger(endHour) ||
    startHour < 0 ||
    endHour > 24 ||
    endHour <= startHour ||
    !Number.isFinite(hourHeight) ||
    hourHeight <= 0
  ) {
    throw new RangeError("Calendar grid geometry is outside its bounds");
  }
  return (endHour - startHour) * hourHeight;
}

/** Ensure the sticky weekday/date header's containing block spans the entire
 * vertical timeline instead of ending at the scroller's viewport height. */
export function timeStripLaneMinHeight({
  allDayHeight,
  ...timeGrid
}: {
  startHour: number;
  endHour: number;
  hourHeight: number;
  allDayHeight: number;
}): number {
  if (!Number.isFinite(allDayHeight) || allDayHeight < 0) {
    throw new RangeError("All-day height must be a non-negative number");
  }
  return (
    CALENDAR_HEADER_LAYOUT.dayStripHeight +
    allDayHeight +
    gridHeight(timeGrid)
  );
}

export function preserveTimedScrollTop({
  scrollTop,
  previousAllDayHeight,
  nextAllDayHeight,
}: {
  scrollTop: number;
  previousAllDayHeight: number;
  nextAllDayHeight: number;
}): number {
  return Math.max(0, scrollTop + nextAllDayHeight - previousAllDayHeight);
}

/** Return a browser `Date` carrying the configured primary-zone civil date.
 * Calendar paging still uses date-fns/local date fields, so constructing local
 * midnight from the civil parts preserves that date without treating it as an
 * instant in the browser zone. */
export function calendarTodayTarget(
  clock: Pick<ZonedCalendarClock, "today">,
  nowMs: number,
): Date {
  const [year, month, day] = clock.today(nowMs).split("-").map(Number);
  return new Date(year, month - 1, day);
}
