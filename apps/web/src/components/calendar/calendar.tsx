import {
  ArrowDown01Icon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { api } from "@qali/backend/convex/_generated/api";
import type { Doc } from "@qali/backend/convex/_generated/dataModel";
import { Button } from "@qali/ui/components/button";
import { Checkbox } from "@qali/ui/components/checkbox";
import {
  Tabs,
  TabsList,
  TabsTrigger,
} from "@qali/ui/components/tabs";
import { GooDropdown } from "@qali/ui/components/ui/goo-dropdown";
import { cn } from "@qali/ui/lib/utils";
import { useMutation } from "convex/react";
import {
  addDays,
  getISOWeek,
  isSameDay,
  isSameMonth,
  startOfDay,
} from "date-fns";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useCommand } from "@/commands/command-provider";
import { useQaliSettings } from "@/components/settings/settings-provider";
import { CalendarPager, type CalendarPagerHandle } from "./calendar-pager";
import { calendarTodayTarget } from "./calendar-header-layout";
import { calendarPickerPanelMetrics } from "./calendar-control-layout";
import { CALENDAR_COLOR_CHOICES, calendarColorVar } from "./colors";
import {
  addPages,
  calendarDisplayName,
  type CalendarView,
  dayKey,
  eventQueryRange,
  pageDays,
  pageStart,
  STRIP_SIDE_DAYS,
  stripDays,
  VIEW_BUFFER,
  VIEW_COLUMNS,
  VIEW_NAV_DAYS,
  viewTitle,
} from "./lib";
import { timeRangePct } from "./preferences";
import { MonthPanel } from "./month-panel";
import { MonthPicker } from "./month-picker";
import { TimeStrip, type TimeStripHandle } from "./time-strip";
import { NO_REVEAL, type Reveal } from "./today-pulse";
import { useStableQuery } from "./use-stable-query";
import { createZonedCalendarClock } from "./zoned-calendar-clock";
import { useDock } from "@/components/workspace/dock-context";
import { useWorkspaceHeaderTarget } from "@/components/workspace/workspace-chrome";

const VIEWS: CalendarView[] = ["day", "week", "month"];
/** Stable empty fallback: a fresh `[]` each render would defeat the
 * memoization downstream in the strip. */
const NO_EVENTS: Doc<"events">[] = [];

export function CalendarWeekView() {
  const workspaceHeader = useWorkspaceHeaderTarget();
  const { snapshot } = useQaliSettings();
  const calendarSettings = snapshot.settings.calendar;
  const clock = useMemo(
    () => createZonedCalendarClock(calendarSettings.primaryTimeZone),
    [calendarSettings.primaryTimeZone],
  );
  const timeRange = {
    startHour: calendarSettings.dayStartHour,
    endHour: calendarSettings.dayEndHour,
  };
  const [view, setView] = useState<CalendarView>(calendarSettings.defaultView);
  const [anchor, setAnchor] = useState(() =>
    pageStart("week", calendarTodayTarget(clock, Date.now())),
  );
  const [reveal, setReveal] = useState<Reveal>(NO_REVEAL);
  const pagerRef = useRef<CalendarPagerHandle>(null);
  const stripRef = useRef<TimeStripHandle>(null);

  // Month pages by whole months; day/week slide a continuous day strip.
  const layout = useMemo(() => {
    if (view === "month") {
      const buffer = VIEW_BUFFER.month;
      const pageStarts = Array.from({ length: 2 * buffer + 1 }, (_, i) =>
        addPages("month", anchor, i - buffer),
      );
      return {
        mode: "month" as const,
        pageStarts,
        centerIndex: buffer,
      };
    }
    const columns = VIEW_COLUMNS[view];
    const navDays = VIEW_NAV_DAYS[view];
    const side = STRIP_SIDE_DAYS[view];
    return {
      mode: "strip" as const,
      columns,
      navDays,
      anchorIndex: side,
      days: stripDays(anchor, columns, side),
    };
  }, [view, anchor]);

  // The query window is quantized to a week/month boundary, so scrolling
  // within it reuses the same Convex subscription instead of refetching per
  // day. `useStableQuery` holds the previous result across the boundary
  // crossings that do change it, and because each window fully contains the
  // strips reachable from it, that stale result is never missing a visible
  // day — the grid never blanks. `bucketDayEvents`/`MonthPanel` filter the
  // extra events down to the rendered days.
  const queryRange = useMemo(
    () => eventQueryRange(view, anchor),
    [view, anchor],
  );
  const events =
    useStableQuery(api.calendar.listEventsInRange, queryRange) ?? NO_EVENTS;

  const calendars = useStableQuery(api.calendar.listCalendars) ?? [];

  // Tell the dock which day its Create button should seed a new event on: today
  // when the current page shows it, otherwise the page's own start. The dock
  // reads this plus the events below to land on the next free slot.
  const { openCreate, registerCreateSeed, registerReveal } = useDock();
  const focusDayMs = useMemo(() => {
    const today = startOfDay(calendarTodayTarget(clock, Date.now()));
    const onPage = pageDays(view, anchor).some((day) => isSameDay(day, today));
    return (onPage ? today : startOfDay(anchor)).getTime();
  }, [view, anchor, clock]);
  useEffect(() => {
    registerCreateSeed({ dayStartMs: focusDayMs, events });
    return () => registerCreateSeed(null);
  }, [registerCreateSeed, focusDayMs, events]);

  // Prev/next: step one page (month) or the configured day count, animating the scroll.
  const step = (dir: number) => {
    if (layout.mode === "month") {
      pagerRef.current?.scrollToIndex(layout.centerIndex + dir, "smooth");
    } else {
      stripRef.current?.scrollToIndex(
        layout.anchorIndex + dir * layout.navDays,
        "smooth",
      );
    }
  };

  // Jump to the page/day containing `date`.
  const jumpTo = useCallback(
    (date: Date) => {
      setAnchor(pageStart(view, date));
    },
    [view],
  );

  // Settle handlers must keep a stable identity across renders: the scrollers
  // derive their recentering effect's dependencies from them, so an inline
  // arrow here re-fires that effect on every render and yanks the scroll
  // position mid-gesture. The functional updates make `[]` deps correct.
  const handleSettleDeltaDays = useCallback(
    (delta: number) => setAnchor((a) => addDays(a, delta)),
    [],
  );
  const handleSettleDeltaPages = useCallback(
    (delta: number) => setAnchor((a) => addPages("month", a, delta)),
    [],
  );

  // Move a target day/time to center, then pulse the item there. When the day is
  // already in the buffered window we scroll to it for real (continuous, through
  // the actual days); otherwise the days between aren't rendered, so we rebuild
  // centered on it under a directional slide transition. Day/week center the day
  // among the visible columns and ease vertically to `vertical` (a pct of the
  // day, "now" for the current-time line, or null to keep the position); month
  // shows the whole month. `flashId` is the reveal key of the item to pulse.
  // Bump the reveal so the matching item pulses; `at` lets a late-mounting card
  // (an assistant change still syncing back) know the reveal is fresh.
  const bumpReveal = (flashId: string) =>
    setReveal((prev) => ({
      id: flashId,
      nonce: prev.nonce + 1,
      at: Date.now(),
    }));

  const revealTarget = (spec: {
    date: Date;
    vertical: number | "now" | null;
    flashId: string;
  }) => {
    const flash = () => bumpReveal(spec.flashId);
    const scrollColumn = (index: number) => {
      if (spec.vertical === "now") {
        stripRef.current?.scrollToTodayColumn(index, flash);
      } else {
        stripRef.current?.scrollToColumn(index, spec.vertical, flash);
      }
    };

    if (layout.mode === "strip") {
      const centerOffset = Math.floor(layout.columns / 2);
      const dayIndex = layout.days.findIndex((d) => isSameDay(d, spec.date));
      const targetIndex = dayIndex - centerOffset;
      const maxIndex = layout.days.length - layout.columns;
      // On-strip and fully scrollable to a centered position: real scroll.
      if (dayIndex !== -1 && targetIndex >= 0 && targetIndex <= maxIndex) {
        scrollColumn(targetIndex);
        return;
      }
      const target = addDays(startOfDay(spec.date), -centerOffset);
      // Anchor can't move (the target sits at a short-buffer edge): scroll as
      // far toward centered as the strip allows rather than rebuilding to the
      // same place.
      if (target.getTime() === anchor.getTime()) {
        scrollColumn(Math.max(0, Math.min(targetIndex, maxIndex)));
        return;
      }
      if (spec.vertical === "now") stripRef.current?.primeCenterNow();
      else stripRef.current?.primeCenterAt(spec.vertical);
      setAnchor(target);
      flash();
      return;
    }

    // Month.
    const monthIndex = layout.pageStarts.findIndex((s) =>
      isSameMonth(s, spec.date),
    );
    if (monthIndex !== -1) {
      pagerRef.current?.scrollToIndex(monthIndex, "smooth", flash);
      return;
    }
    const target = pageStart("month", spec.date);
    if (target.getTime() === anchor.getTime()) {
      flash();
      return;
    }
    setAnchor(target);
    flash();
  };

  // Today is just a reveal of today's date pill at the current-time line.
  const goToToday = () => {
    const today = calendarTodayTarget(clock, Date.now());
    revealTarget({
      date: today,
      vertical: "now",
      flashId: dayKey(today),
    });
  };

  // The panels reach for an item by its start time and reveal key. In month
  // view there is no time position, so we flash the whole day cell (keyed by
  // day) instead of the item. Without a start time we can only pulse an item
  // that is already on screen.
  const revealItem = (input: { startMs?: number; flashId: string }) => {
    if (input.startMs == null) {
      bumpReveal(input.flashId);
      return;
    }
    const date = new Date(input.startMs);
    if (layout.mode === "month") {
      revealTarget({ date, vertical: null, flashId: dayKey(date) });
    } else {
      revealTarget({
        date,
        vertical: timeRangePct(
          clock.instantToWallTime(input.startMs).minute,
          timeRange,
        ),
        flashId: input.flashId,
      });
    }
  };

  // Register with the dock through a ref so a single stable callback always runs
  // the latest closure (which reads the current view/anchor), the way the create
  // seed is registered — without re-registering on every scroll settle.
  const revealItemRef = useRef(revealItem);
  revealItemRef.current = revealItem;
  useEffect(() => {
    registerReveal((input) => revealItemRef.current(input));
    return () => registerReveal(null);
  }, [registerReveal]);

  const switchView = (next: CalendarView) => {
    const apply = () => {
      setAnchor(pageStart(next, anchor));
      setView(next);
    };
    apply();
  };

  const openDay = (day: Date) => {
    setAnchor(pageStart("day", day));
    setView("day");
  };

  const dispatchDayView = useCommand("calendar.view.day", () =>
    switchView("day"),
  );
  const dispatchWeekView = useCommand("calendar.view.week", () =>
    switchView("week"),
  );
  const dispatchMonthView = useCommand("calendar.view.month", () =>
    switchView("month"),
  );
  const dispatchToday = useCommand("calendar.today", goToToday);
  const dispatchPrevious = useCommand("calendar.navigate.previous", () =>
    step(-1),
  );
  const dispatchNext = useCommand("calendar.navigate.next", () => step(1));
  useCommand("calendar.event.create", openCreate);
  const viewCommands: Readonly<Record<CalendarView, () => boolean>> = {
    day: dispatchDayView,
    week: dispatchWeekView,
    month: dispatchMonthView,
  };

  const toolbar = (
    <header
      data-dock-keep-open
      className="calendar-window-header flex h-[52px] shrink-0 items-center justify-between gap-4 bg-transparent px-4"
    >
      <div className="flex items-center justify-center gap-2 text-sm">
        <MonthPicker
          selectedWeekStart={pageStart("week", anchor)}
          onSelect={jumpTo}
        >
          <span className="font-medium">{viewTitle(view, anchor)}</span>
          {view === "week" && (
            <span className="flex items-center gap-1 rounded-md bg-secondary px-2 py-0.5 text-xs font-medium text-secondary-foreground">
              W{getISOWeek(anchor)}
              <HugeiconsIcon
                icon={ArrowDown01Icon}
                strokeWidth={2}
                className="size-3"
              />
            </span>
          )}
        </MonthPicker>
      </div>

      <div className="flex items-center gap-2">
        <Tabs value={view}>
          <TabsList variant="raised" className="h-8 rounded-[8px] p-0.5">
          {VIEWS.map((v) => (
            <TabsTrigger
              key={v}
              value={v}
              onClick={viewCommands[v]}
              className="h-7 min-w-12 rounded-[6px] px-2.5 py-1 capitalize"
            >
              {v}
            </TabsTrigger>
          ))}
          </TabsList>
        </Tabs>

        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="raised"
            size="sm"
            onClick={dispatchToday}
            className="h-8 rounded-[8px]"
          >
            Today
          </Button>
          <Button
            type="button"
            variant="raised"
            size="icon-sm"
            aria-label="Previous"
            onClick={dispatchPrevious}
            className="rounded-[8px]"
          >
            <HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={2} />
          </Button>
          <Button
            type="button"
            variant="raised"
            size="icon-sm"
            aria-label="Next"
            onClick={dispatchNext}
            className="rounded-[8px]"
          >
            <HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2} />
          </Button>
        </div>

        <CalendarPicker calendars={calendars} />

      </div>
    </header>
  );
  return (
    <div className="flex h-full min-h-0 flex-col">
      {workspaceHeader ? createPortal(toolbar, workspaceHeader) : toolbar}

      <div className="calendar-body-vt flex min-h-0 flex-1 flex-col">
        {layout.mode === "month" ? (
          <CalendarPager
            ref={pagerRef}
            pageStarts={layout.pageStarts}
            centerIndex={layout.centerIndex}
            gutterWidth={0}
            onSettleDelta={handleSettleDeltaPages}
            renderPage={(start) => (
              <MonthPanel
                monthStart={start}
                days={pageDays("month", start)}
                today={calendarTodayTarget(clock, Date.now())}
                events={events}
                onSelectDay={openDay}
                reveal={reveal}
              />
            )}
          />
        ) : (
          <TimeStrip
            ref={stripRef}
            days={layout.days}
            anchorIndex={layout.anchorIndex}
            columns={layout.columns}
            events={events}
            onSettleDeltaDays={handleSettleDeltaDays}
            reveal={reveal}
            timeRange={timeRange}
            hourHeight={calendarSettings.hourHeight}
            primaryTimeZone={calendarSettings.primaryTimeZone}
            secondaryTimeZones={calendarSettings.secondaryTimeZones}
          />
        )}
      </div>
    </div>
  );
}

function CalendarPicker({ calendars }: { calendars: Doc<"calendars">[] }) {
  const setSelected = useMutation(api.calendar.setCalendarSelected);
  const setColor = useMutation(api.calendar.setCalendarColor);
  const [colorCalendarId, setColorCalendarId] = useState<string | null>(null);
  const selectedCount = calendars.filter((c) => c.selected).length;
  // Primary first, then alphabetical by display name.
  const sorted = [...calendars].sort((a, b) => {
    if (a.primary !== b.primary) return a.primary ? -1 : 1;
    return calendarDisplayName(a).localeCompare(calendarDisplayName(b));
  });
  const panelMetrics = calendarPickerPanelMetrics({
    calendarCount: sorted.length,
    colorPaletteOpen: colorCalendarId !== null,
  });

  return (
    <GooDropdown
      trigger={
        <>
          <div className="flex items-center -space-x-1.5">
            {sorted
              .filter((c) => c.selected)
              .slice(0, 8)
              .map((c) => (
                <span
                  key={c._id}
                  className="size-4 rounded-full ring-2 ring-background"
                  style={{
                    backgroundColor: `var(${calendarColorVar(c)})`,
                  }}
                />
              ))}
          </div>
          <span className="text-sm">
            {calendars.length === 0
              ? "No calendars"
              : `${selectedCount} of ${calendars.length} calendar${
                  calendars.length === 1 ? "" : "s"
                }`}
          </span>
        </>
      }
      triggerLabel="Choose calendars"
      menuLabel="Calendars"
      panelContent={
        <div className="flex h-full min-h-0 flex-col">
          <p
            className="flex shrink-0 items-center px-1.5 text-xs font-medium opacity-70"
            style={{ height: panelMetrics.headingHeight }}
          >
            Calendars
          </p>
          <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-width:thin]">
            {sorted.map((cal, index) => {
              const checkboxId = `calendar-picker-${cal._id}`;
              const choosingColor = colorCalendarId === cal._id;
              const name = calendarDisplayName(cal);
              return (
                <div key={cal._id}>
                  <div className="flex h-8 items-center gap-2.5 rounded-lg px-1.5 transition-colors hover:bg-[var(--goo-hover-fill)]">
                    <Checkbox
                      id={checkboxId}
                      autoFocus={index === 0}
                      className="size-5 rounded-md border-primary-foreground/40 bg-primary-foreground/10 transition-colors focus-visible:border-primary-foreground focus-visible:ring-primary-foreground/30 data-checked:border-primary-foreground data-checked:bg-primary-foreground data-checked:text-primary dark:data-checked:bg-primary-foreground"
                      checked={cal.selected}
                      onCheckedChange={(checked) =>
                        void setSelected({
                          calendarId: cal._id,
                          selected: checked === true,
                        })
                      }
                    />
                    <button
                      type="button"
                      className="flex size-5 shrink-0 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-foreground/40"
                      aria-label={`Change ${name} color`}
                      aria-expanded={choosingColor}
                      onClick={() =>
                        setColorCalendarId(choosingColor ? null : cal._id)
                      }
                    >
                      <span
                        className="size-3 rounded-full ring-1 ring-primary-foreground/20"
                        style={{
                          backgroundColor: `var(${calendarColorVar(cal)})`,
                        }}
                      />
                    </button>
                    <label
                      htmlFor={checkboxId}
                      className="min-w-0 flex-1 cursor-pointer truncate text-sm"
                    >
                      {name}
                    </label>
                  </div>
                  {choosingColor ? (
                    <div
                      className="flex h-8 items-center gap-1 px-1.5"
                      aria-label={`${name} color choices`}
                    >
                      <button
                        type="button"
                        title="Use Google color"
                        aria-label={`Use Google color for ${name}`}
                        aria-pressed={cal.colorOverride === undefined}
                        className="flex size-5 items-center justify-center rounded-full border border-primary-foreground/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-foreground/40"
                        onClick={() => {
                          void setColor({ calendarId: cal._id, color: null });
                          setColorCalendarId(null);
                        }}
                      >
                        <span
                          className="size-2.5 rounded-full"
                          style={{
                            backgroundColor: `var(${calendarColorVar({
                              googleCalendarId: cal.googleCalendarId,
                              backgroundColor: cal.backgroundColor,
                            })})`,
                          }}
                        />
                      </button>
                      {CALENDAR_COLOR_CHOICES.map((choice) => (
                        <button
                          key={choice.key}
                          type="button"
                          title={`Use ${choice.key.replace("event-", "color ")}`}
                          aria-label={`Set ${name} to ${choice.key}`}
                          aria-pressed={cal.colorOverride === choice.key}
                          className="flex size-5 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-foreground/40"
                          onClick={() => {
                            void setColor({
                              calendarId: cal._id,
                              color: choice.key,
                            });
                            setColorCalendarId(null);
                          }}
                        >
                          <span
                            className={cn(
                              "size-3.5 rounded-full",
                              cal.colorOverride === choice.key &&
                                "ring-2 ring-primary-foreground ring-offset-1 ring-offset-[var(--goo-fill)]",
                            )}
                            style={{
                              backgroundColor: `var(${choice.colorVar})`,
                            }}
                          />
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      }
      contentHeight={panelMetrics.contentHeight}
      maxHeight={panelMetrics.maxHeight}
      align="end"
      side="bottom"
      gap={4}
      width={288}
      buttonRadius={8}
      panelRadius={panelMetrics.panelRadius}
      fill="var(--qali-goo-fill)"
      foreground="var(--foreground)"
      hoverFill="var(--qali-goo-control-fill)"
      activeFill="var(--qali-goo-fill)"
      activeForeground="var(--foreground)"
      activeHoverFill="var(--qali-goo-control-fill)"
      triggerClassName="qali-control qali-control--raised h-8 gap-2 rounded-[8px] hover:bg-accent"
    />
  );
}
