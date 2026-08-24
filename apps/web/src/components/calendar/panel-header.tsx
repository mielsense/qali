import { cn } from "@qali/ui/lib/utils";
import { format, isSameDay } from "date-fns";
import { motion } from "motion/react";

import { useDock } from "@/components/workspace/dock-context";

import { useEventColor } from "./colors";
import {
  allDaySurfacePosition,
  eventSurfacePresentation,
  eventSurfaceState,
  EVENT_SURFACE_GUTTERS,
} from "./event-surface";
import {
  ALLDAY_BAND_PADDING,
  ALLDAY_EVENT_GAP,
  ALLDAY_EVENT_HEIGHT,
  type AllDayEventLayout,
  dayColsTemplate,
  dayKey,
} from "./lib";
import { CALENDAR_HEADER_LAYOUT } from "./calendar-header-layout";
import { press } from "./motion";
import { useEventCapabilities } from "./permissions";
import { RevealFlash, type Reveal } from "./today-pulse";

interface PanelHeaderProps {
  days: Date[];
  today: Date;
  allDayEvents: AllDayEventLayout[];
  allDayHeight: number;
  allDayExpanded: boolean;
  allDayInternallyScrollable: boolean;
  /** The active reveal target; pulses today's date pill when it's the target
   * (a Today jump) or an all-day card matching the revealed item. */
  reveal: Reveal;
}

/** Weekday/date row plus the all-day band for a single day or week page.
 * Contains no gutter column — the time gutter is pinned as a sibling. */
export function PanelHeader({
  days,
  today: primaryToday,
  allDayEvents,
  allDayHeight,
  allDayExpanded,
  allDayInternallyScrollable,
  reveal,
}: PanelHeaderProps) {
  const { open } = useDock();
  const colorFor = useEventColor();
  const capabilitiesFor = useEventCapabilities();
  const template = dayColsTemplate(days.length);
  // Absolutely positioned cards don't contribute to the rail's scroll height, so
  // when expanded past the visible cap we'd have no way to reach the lower lanes.
  // A zero-width spacer sized to the rendered lane stack restores that scroll.
  const renderedLaneCount = allDayEvents.reduce((max, { lane }) => {
    if (!allDayExpanded && lane >= 1) return max;
    return Math.max(max, lane + 1);
  }, 0);
  const railContentHeight =
    renderedLaneCount === 0
      ? 0
      : ALLDAY_BAND_PADDING * 2 +
        renderedLaneCount * ALLDAY_EVENT_HEIGHT +
        (renderedLaneCount - 1) * ALLDAY_EVENT_GAP;
  return (
    <div
      className="relative flex flex-col border-b border-border bg-calendar-header"
      style={{
        height: CALENDAR_HEADER_LAYOUT.dayStripHeight + allDayHeight,
      }}
    >
      {/* Column dividers as one continuous overlay so the lines run the full
       * header height — through both the date row and the all-day band —
       * rather than stopping where each row's own borders end. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 grid"
        style={{ gridTemplateColumns: template }}
      >
        {days.map((day, index) => (
          <div
            key={day.getTime()}
            className={cn(
              "border-l border-border",
              index === days.length - 1 && "border-r",
            )}
          />
        ))}
      </div>
      <div
        className="relative grid shrink-0"
        style={{
          gridTemplateColumns: template,
          height: CALENDAR_HEADER_LAYOUT.dayStripHeight,
        }}
      >
        {days.map((day) => {
          const today = isSameDay(day, primaryToday);
          return (
            <div
              key={day.getTime()}
              className="inline-flex min-w-0 items-center justify-center gap-1.5 px-2 text-center"
            >
              <span
                className={cn(
                  "text-[10px] leading-none font-semibold tracking-[0.09em] uppercase",
                  today ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {format(day, "EEE")}
              </span>
              {today ? (
                <span className="relative flex size-5 items-center justify-center overflow-hidden rounded-full bg-primary text-xs leading-none font-semibold text-primary-foreground">
                  <RevealFlash
                    reveal={reveal}
                    targetId={dayKey(day)}
                    className="z-0 bg-[color-mix(in_oklab,white_55%,transparent)]"
                  />
                  <span className="relative z-10">{format(day, "d")}</span>
                </span>
              ) : (
                <span className="text-sm leading-none font-semibold tabular-nums">
                  {format(day, "d")}
                </span>
              )}
            </div>
          );
        })}
      </div>
      <div
        id="calendar-all-day-rail"
        className={cn(
          // The height tracks the visible days' all-day lanes, so it eases both
          // when they change under a scroll and when the expand/collapse toggle
          // fires. Cards are positioned absolutely (rather than on a grid) so a
          // card's width can ease with a CSS transition when its span clamps at
          // the scroll edge — grid-column placement can't be transitioned.
          "relative",
          allDayInternallyScrollable ? "overflow-y-auto" : "overflow-hidden",
        )}
        style={{ height: allDayHeight }}
      >
        <div
          aria-hidden
          className="w-0 shrink-0"
          style={{ height: railContentHeight }}
        />
        {allDayEvents.map(({ event, startIdx, endIdx, lane, isConflicting }) => {
          if (!allDayExpanded && lane >= 1) return null;
          const colorVar = colorFor(event);
          const surfaceState = eventSurfaceState({
            canEdit: capabilitiesFor(event).canEdit,
            hasConflict: isConflicting,
          });
          const surface = eventSurfacePresentation({
            colorVar,
            variant: "all-day",
            state: surfaceState,
          });
          const hoverSurface = eventSurfacePresentation({
            colorVar,
            variant: "all-day",
            state: "hover",
          });
          const focusSurface = eventSurfacePresentation({
            colorVar,
            variant: "all-day",
            state: "focus",
          });
          const position = allDaySurfacePosition(lane);
          // Columns are equal 1fr tracks, so one day is `100% / days.length` of
          // the rail; matching surface insets keep every event edge clear.
          const colPct = `(100% / ${days.length})`;
          return (
            <motion.button
              type="button"
              key={event._id}
              data-event
              data-event-surface-state={surfaceState}
              onClick={() => open({ kind: "event", event })}
              whileTap={press.whileTap}
              transition={{ scale: press.transition }}
              className={cn(
                "absolute flex items-center overflow-hidden px-2.5 py-1.5 text-left text-xs font-medium leading-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                surface.className,
              )}
              style={{
                left: `calc(${colPct} * ${startIdx} + ${EVENT_SURFACE_GUTTERS.horizontalPx}px)`,
                width: `calc(${colPct} * ${endIdx - startIdx + 1} - ${EVENT_SURFACE_GUTTERS.horizontalPx * 2}px)`,
                top: position.topPx,
                height: position.heightPx,
                borderRadius: `${surface.radiusPx}px`,
                "--event-surface-background": surface.backgroundColor,
                "--event-surface-border": surface.borderColor,
                "--event-surface-highlight": surface.boxShadow,
                "--event-surface-foreground": surface.color,
                "--event-surface-color": `var(${colorVar})`,
                "--event-surface-hover-fill": `${hoverSurface.fillPercent}%`,
                "--event-surface-hover-edge": `${hoverSurface.edgePercent}%`,
                "--event-surface-focus-fill": `${focusSurface.fillPercent}%`,
                "--event-surface-focus-edge": `${focusSurface.edgePercent}%`,
              } as React.CSSProperties}
            >
              <RevealFlash
                reveal={reveal}
                targetId={[event._id, event.googleEventId]}
                className="rounded-lg bg-[color-mix(in_oklab,var(--primary)_45%,transparent)]"
              />
              <span className="truncate">{event.summary ?? "(No title)"}</span>
            </motion.button>
          );
        })}
      </div>
    </div>
  );
}
