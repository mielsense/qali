import {
  AnalyticsUpIcon,
  Calendar03Icon,
  ChartAverageIcon,
  Clock01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { api } from "@qali/backend/convex/_generated/api";
import type { Doc } from "@qali/backend/convex/_generated/dataModel";
import { DataFrame } from "@qali/ui/components/data-frame";
import { EvilAreaChart } from "@qali/ui/components/evil-area-chart";
import { motion, useReducedMotion } from "motion/react";
import { useMemo } from "react";
import { createPortal } from "react-dom";

import { useQaliSettings } from "@/components/settings/settings-provider";
import { useWorkspaceHeaderTarget } from "@/components/workspace/workspace-chrome";
import { useStableQuery } from "@/components/calendar/use-stable-query";

import {
  buildCalendarInsights,
  CALENDAR_INSIGHT_WINDOW_DAYS,
} from "./calendar-insights";

const DAY_MS = 86_400_000;
const NO_EVENTS: Doc<"events">[] = [];

type Metric = Readonly<{
  label: string;
  value: string;
  detail: string;
  icon: IconSvgElement;
}>;

export function InsightsDashboard() {
  const workspaceHeader = useWorkspaceHeaderTarget();
  const { snapshot } = useQaliSettings();
  const reduceMotion = useReducedMotion();
  const timeZone = snapshot.settings.calendar.primaryTimeZone;
  const nowMs = useMemo(() => Date.now(), []);
  const queryRange = useMemo(
    () => ({
      startMs: nowMs - (CALENDAR_INSIGHT_WINDOW_DAYS - 1) * DAY_MS,
      endMs: nowMs + DAY_MS,
    }),
    [nowMs],
  );
  const events =
    useStableQuery(api.calendar.listEventsInRange, queryRange) ?? NO_EVENTS;
  const insights = useMemo(
    () => buildCalendarInsights(events, nowMs, timeZone),
    [events, nowMs, timeZone],
  );
  const weekdayMaximum = useMemo(
    () => Math.max(...insights.weekdays.map((item) => item.hours), 1),
    [insights.weekdays],
  );
  const daypartMaximum = useMemo(
    () => Math.max(...insights.dayparts.map((item) => item.hours), 1),
    [insights.dayparts],
  );

  const metrics: readonly Metric[] = [
    {
      label: "Events",
      value: String(insights.eventCount),
      detail: "Timed events",
      icon: Calendar03Icon,
    },
    {
      label: "Scheduled",
      value: `${formatNumber(insights.scheduledHours)}h`,
      detail: "Across 28 days",
      icon: Clock01Icon,
    },
    {
      label: "Average event",
      value: `${insights.averageEventMinutes}m`,
      detail: "Per calendar block",
      icon: ChartAverageIcon,
    },
    {
      label: "Busiest day",
      value: insights.busiestWeekday,
      detail: "By scheduled time",
      icon: AnalyticsUpIcon,
    },
    {
      label: "Active days",
      value: `${insights.activeDays} / ${CALENDAR_INSIGHT_WINDOW_DAYS}`,
      detail: "Days with timed events",
      icon: Calendar03Icon,
    },
    {
      label: "Longest event",
      value: formatDuration(insights.longestEventMinutes),
      detail: "Longest calendar block",
      icon: Clock01Icon,
    },
  ];

  const toolbar = (
    <header className="flex h-full items-center justify-between px-4">
      <div className="flex items-baseline gap-2">
        <h1 className="text-sm font-semibold tracking-tight">Insights</h1>
        <span className="text-xs text-muted-foreground">Calendar pulse</span>
      </div>
      <div className="qali-control qali-control--raised flex h-8 items-center rounded-xl px-3 text-xs font-medium text-muted-foreground">
        Last 28 days
      </div>
    </header>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {workspaceHeader ? createPortal(toolbar, workspaceHeader) : toolbar}
      <main
        className="min-h-0 flex-1 overflow-y-auto px-6 py-7"
        aria-label="Calendar insights"
      >
        <div className="mx-auto grid max-w-[1180px] gap-4">
          <div className="flex items-end justify-between gap-4 px-1 pb-1">
            <div>
              <h2 className="text-lg font-medium tracking-[-0.02em]">Overview</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                A quiet read on how your calendar is using time.
              </p>
            </div>
            <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
              {timeZone.replaceAll("_", " ")}
            </span>
          </div>
          <motion.section
            initial={reduceMotion ? false : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ type: "spring", stiffness: 360, damping: 34 }}
            className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6"
            aria-label="Overview"
          >
            {metrics.map((metric, index) => (
              <MetricCard
                key={metric.label}
                metric={metric}
                index={index}
                reduceMotion={Boolean(reduceMotion)}
              />
            ))}
          </motion.section>

          <motion.section
            initial={reduceMotion ? false : { opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{
              type: "spring",
              stiffness: 320,
              damping: 32,
              delay: reduceMotion ? 0 : 0.06,
            }}
            className="grid gap-4 xl:grid-cols-[minmax(0,1.75fr)_minmax(280px,0.75fr)]"
          >
            <DataFrame
              title="Scheduled time"
              description="Daily calendar load across the last 28 days"
              className="min-w-0"
              bodyClassName="p-3"
            >
              <EvilAreaChart
                ariaLabel="Scheduled hours by day over the last 28 days"
                data={insights.daily}
                xKey="label"
                series={[
                  {
                    dataKey: "hours",
                    label: "Scheduled",
                    color: "var(--chart-1)",
                    valueFormatter: (value) => `${formatNumber(value)}h`,
                  },
                ]}
              />
            </DataFrame>

            <DataFrame
              title="Weekly rhythm"
              description="Scheduled time by weekday"
              bodyClassName="grid min-h-[336px] content-center gap-4 p-4"
            >
              {insights.weekdays.map((day) => {
                return (
                  <div
                    key={day.label}
                    className="grid grid-cols-[2rem_1fr_3rem] items-center gap-3"
                  >
                    <span className="text-[11px] font-medium text-muted-foreground">
                      {day.shortLabel}
                    </span>
                    <div className="h-1.5 overflow-hidden rounded-full bg-foreground/[0.05]">
                      <motion.div
                        className="h-full rounded-full bg-[var(--chart-1)]"
                        initial={false}
                        animate={{
                          width: `${(day.hours / weekdayMaximum) * 100}%`,
                        }}
                        transition={
                          reduceMotion
                            ? { duration: 0 }
                            : {
                                type: "spring",
                                stiffness: 260,
                                damping: 30,
                              }
                        }
                      />
                    </div>
                    <span className="text-right font-mono text-[11px] tabular-nums text-muted-foreground">
                      {formatNumber(day.hours)}h
                    </span>
                  </div>
                );
              })}
            </DataFrame>
          </motion.section>

          <motion.section
            initial={reduceMotion ? false : { opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{
              type: "spring",
              stiffness: 320,
              damping: 32,
              delay: reduceMotion ? 0 : 0.1,
            }}
            className="grid gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.65fr)]"
          >
            <DataFrame
              title="Event cadence"
              description="Timed event count by day"
              className="min-w-0"
              bodyClassName="p-3"
            >
              <EvilAreaChart
                ariaLabel="Timed event count by day over the last 28 days"
                data={insights.daily}
                height={210}
                xKey="label"
                series={[
                  {
                    dataKey: "events",
                    label: "Events",
                    color: "var(--chart-2)",
                    valueFormatter: (value) =>
                      `${value} ${value === 1 ? "event" : "events"}`,
                  },
                ]}
              />
            </DataFrame>

            <DataFrame
              title="Time of day"
              description="Scheduled hours by event start time"
              bodyClassName="grid min-h-[236px] content-center gap-5 p-4"
            >
              {insights.dayparts.map((daypart) => (
                <div
                  key={daypart.label}
                  className="grid grid-cols-[4.5rem_1fr_3rem] items-center gap-3"
                >
                  <span className="text-[11px] font-medium text-muted-foreground">
                    {daypart.label}
                  </span>
                  <div className="h-1.5 overflow-hidden rounded-full bg-foreground/[0.05]">
                    <motion.div
                      className="h-full rounded-full bg-[var(--chart-2)]"
                      initial={false}
                      animate={{
                        width: `${(daypart.hours / daypartMaximum) * 100}%`,
                      }}
                      transition={
                        reduceMotion
                          ? { duration: 0 }
                          : {
                              type: "spring",
                              stiffness: 260,
                              damping: 30,
                            }
                      }
                    />
                  </div>
                  <span className="text-right font-mono text-[11px] tabular-nums text-muted-foreground">
                    {formatNumber(daypart.hours)}h
                  </span>
                </div>
              ))}
            </DataFrame>
          </motion.section>
        </div>
      </main>
    </div>
  );
}

function MetricCard({
  metric,
  index,
  reduceMotion,
}: {
  metric: Metric;
  index: number;
  reduceMotion: boolean;
}) {
  return (
    <motion.div
      initial={reduceMotion ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        type: "spring",
        stiffness: 380,
        damping: 34,
        delay: reduceMotion ? 0 : index * 0.035,
      }}
    >
      <DataFrame
        title={metric.label}
        icon={
          <HugeiconsIcon
            icon={metric.icon}
            strokeWidth={1.8}
            className="size-3.5"
            aria-hidden="true"
          />
        }
        className="h-full"
        bodyClassName="flex h-[76px] flex-col justify-center px-3.5 py-3"
      >
        <div className="truncate text-[25px] font-medium leading-none tracking-[-0.035em] tabular-nums">
          {metric.value}
        </div>
        <div className="mt-2 text-[11px] text-muted-foreground">
          {metric.detail}
        </div>
      </DataFrame>
    </motion.div>
  );
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(
    value,
  );
}

function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
}
