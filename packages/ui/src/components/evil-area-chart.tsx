"use client"

import { motion, useReducedMotion } from "motion/react"
import * as React from "react"
import {
  Area,
  AreaChart,
  CartesianGrid,
  XAxis,
  YAxis,
} from "recharts"

import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@qali/ui/components/chart"
import { cn } from "@qali/ui/lib/utils"

/**
 * A Qali-adapted implementation of EvilCharts' composable area-chart pattern.
 * EvilCharts is MIT licensed: https://github.com/legions-developer/evilcharts
 */

type EvilAreaSeries = Readonly<{
  dataKey: string
  label: string
  color: string
  valueFormatter?: (value: number) => React.ReactNode
}>

type EvilAreaChartProps = Readonly<{
  ariaLabel: string
  className?: string
  data: readonly Record<string, unknown>[]
  height?: number
  initialWidth?: number
  series: readonly EvilAreaSeries[]
  tickInterval?: number
  xKey: string
}>

function EvilAreaChart({
  ariaLabel,
  className,
  data,
  height = 310,
  initialWidth = 760,
  series,
  tickInterval = 6,
  xKey,
}: EvilAreaChartProps) {
  const reduceMotion = useReducedMotion()
  const instanceId = React.useId().replaceAll(":", "")
  const config = React.useMemo<ChartConfig>(
    () =>
      Object.fromEntries(
        series.map((item) => [
          item.dataKey,
          { label: item.label, color: item.color },
        ]),
      ),
    [series],
  )

  return (
    <div
      className={cn("relative min-w-0 overflow-hidden rounded-xl", className)}
      role="img"
      aria-label={ariaLabel}
    >
      <motion.div
        initial={
          reduceMotion
            ? false
            : { clipPath: "inset(0 100% 0 0)", opacity: 0.7 }
        }
        animate={{ clipPath: "inset(0 0% 0 0)", opacity: 1 }}
        transition={{
          duration: reduceMotion ? 0 : 0.72,
          ease: [0.22, 1, 0.36, 1],
        }}
      >
        <ChartContainer
          config={config}
          className="w-full aspect-auto"
          initialDimension={{ width: initialWidth, height }}
          style={{ height }}
        >
          <AreaChart
            accessibilityLayer
            data={[...data]}
            margin={{ left: 2, right: 8, top: 12, bottom: 0 }}
          >
            <defs>
              {series.map((item) => (
                <linearGradient
                  key={item.dataKey}
                  id={`${instanceId}-${item.dataKey}-gradient`}
                  x1="0"
                  y1="0"
                  x2="0"
                  y2="1"
                >
                  <stop
                    offset="0%"
                    stopColor={`var(--color-${item.dataKey})`}
                    stopOpacity={0.28}
                  />
                  <stop
                    offset="42%"
                    stopColor={`var(--color-${item.dataKey})`}
                    stopOpacity={0.1}
                  />
                  <stop
                    offset="100%"
                    stopColor={`var(--color-${item.dataKey})`}
                    stopOpacity={0}
                  />
                </linearGradient>
              ))}
              <pattern
                id={`${instanceId}-grid-dots`}
                width="8"
                height="8"
                patternUnits="userSpaceOnUse"
              >
                <circle
                  cx="1"
                  cy="1"
                  r="0.65"
                  fill="var(--border)"
                  opacity="0.24"
                />
              </pattern>
            </defs>
            <rect
              width="100%"
              height="100%"
              fill={`url(#${instanceId}-grid-dots)`}
            />
            <CartesianGrid
              vertical={false}
              strokeDasharray="2 8"
              opacity={0.34}
            />
            <XAxis
              dataKey={xKey}
              tickLine={false}
              axisLine={false}
              interval={tickInterval}
              tickMargin={10}
            />
            <YAxis hide domain={[0, "auto"]} />
            <ChartTooltip
              cursor={{
                stroke: "var(--muted-foreground)",
                strokeDasharray: "3 5",
                strokeOpacity: 0.45,
                strokeWidth: 1,
              }}
              content={
                <ChartTooltipContent
                  indicator="line"
                  labelFormatter={(_, payload) => payload[0]?.payload?.[xKey]}
                  formatter={(value, name) => {
                    const item = series.find(
                      (candidate) => candidate.dataKey === String(name),
                    )

                    return (
                      <div className="flex min-w-40 items-center justify-between gap-5">
                        <span className="text-muted-foreground">
                          {item?.label ?? String(name)}
                        </span>
                        <span className="font-mono font-medium tabular-nums text-foreground">
                          {item?.valueFormatter?.(Number(value)) ?? String(value)}
                        </span>
                      </div>
                    )
                  }}
                />
              }
            />
            {series.map((item) => (
              <Area
                key={item.dataKey}
                dataKey={item.dataKey}
                name={item.dataKey}
                type="monotone"
                stroke={`var(--color-${item.dataKey})`}
                strokeWidth={2}
                fill={`url(#${instanceId}-${item.dataKey}-gradient)`}
                activeDot={{ r: 3.5, strokeWidth: 2 }}
                isAnimationActive={false}
              />
            ))}
          </AreaChart>
        </ChartContainer>
      </motion.div>
    </div>
  )
}

export { EvilAreaChart, type EvilAreaChartProps, type EvilAreaSeries }
