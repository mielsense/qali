import { cn } from "@qali/ui/lib/utils";

import {
  calendarTimeZoneColumns,
  CALENDAR_HEADER_LAYOUT,
  gridHeight,
  TIME_ZONE_GUTTER_PADDING,
  TIME_ZONE_GUTTER_WIDTH,
} from "./calendar-header-layout";
import { type CalendarTimeRange, timeRangePct } from "./preferences";
import { TimeGutter, timeGutterLabels } from "./time-gutter";
import {
  createZonedCalendarClock,
  type CivilDate,
} from "./zoned-calendar-clock";

function formatNow(now: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    timeZone,
  }).format(now);
}

/** The hour-labels column, pinned to the left of the paging day/week panels.
 * Its header block matches the panel header height so the hour rows align. */
export function GutterColumn({
  allDayHeight,
  now,
  timeRange,
  hourHeight,
  primaryTimeZone,
  secondaryTimeZones,
  referenceDate,
}: {
  allDayHeight: number;
  now: number;
  timeRange: CalendarTimeRange;
  hourHeight: number;
  primaryTimeZone: string;
  secondaryTimeZones: readonly string[];
  referenceDate: CivilDate;
}) {
  const clock = createZonedCalendarClock(primaryTimeZone);
  const zones = calendarTimeZoneColumns(primaryTimeZone, secondaryTimeZones);
  const timeZones = zones.map(({ timeZone }) => timeZone);
  const labels = timeGutterLabels({
    clock,
    date: referenceDate,
    timeRange,
    timeZones,
  });
  const nowWall = clock.instantToWallTime(now);
  const nowMinutes = nowWall.minute;
  const nowVisible =
    nowMinutes >= timeRange.startHour * 60 &&
    nowMinutes <= timeRange.endHour * 60;
  const nowTopPct = timeRangePct(nowMinutes, timeRange);
  return (
    <div className="flex h-full flex-col bg-background">
      <div
        className="sticky top-0 z-10 flex shrink-0 items-start border-b border-border bg-calendar-header"
        style={{
          height: CALENDAR_HEADER_LAYOUT.dayStripHeight + allDayHeight,
          paddingInline: TIME_ZONE_GUTTER_PADDING,
        }}
      >
        {zones.map((zone) => (
          <span
            key={zone.timeZone}
            className={cn(
              "flex h-[34px] min-w-0 flex-1 items-center justify-center truncate px-1 text-[10px]",
              zone.kind === "primary"
                ? "font-semibold text-foreground/80"
                : "font-medium text-muted-foreground/65",
            )}
          >
            {zone.timeZone.split("/").pop()?.replaceAll("_", " ") ??
              zone.timeZone}
          </span>
        ))}
      </div>
      {/* The sticky gutter wrapper is stretched only to the scroller's client
          height, but the day strip's content runs taller (MIN_DAY_HEIGHT grid +
          spacer). These children carry their own bg so the gutter stays opaque
          through that overflow — otherwise the off-screen buffer day bleeds
          through at the bottom. */}
      <div
        className="relative flex flex-1 bg-background"
        style={{
          minHeight: gridHeight({ ...timeRange, hourHeight }),
          paddingInline: TIME_ZONE_GUTTER_PADDING,
        }}
      >
        {zones.map((zone) => (
          <div
            key={zone.timeZone}
            className="h-full"
            style={{ width: TIME_ZONE_GUTTER_WIDTH }}
          >
            <TimeGutter timeZone={zone.timeZone} labels={labels} />
          </div>
        ))}
        {nowVisible && (
          <span
            className="pointer-events-none absolute right-1.5 z-0 -translate-y-1/2 rounded-full bg-red-500 px-1.5 py-0.5 text-xs font-semibold leading-none tabular-nums text-white shadow-sm"
            style={{ top: `${nowTopPct}%` }}
          >
            {formatNow(now, primaryTimeZone)}
            <span
              aria-hidden
              className="absolute top-1/2 left-full h-0.5 w-1.5 -translate-y-1/2 bg-red-500"
            />
          </span>
        )}
      </div>
    </div>
  );
}
