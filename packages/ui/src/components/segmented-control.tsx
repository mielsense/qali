"use client"

import { motion, useReducedMotion } from "motion/react"
import * as React from "react"

import { cn } from "@qali/ui/lib/utils"

type SegmentedValue = string | number

type SegmentedOption<T extends SegmentedValue> = Readonly<{
  value: T
  label: React.ReactNode
  disabled?: boolean
}>

function SegmentedControl<T extends SegmentedValue>({
  ariaLabel,
  className,
  onValueChange,
  options,
  value,
}: {
  ariaLabel: string
  className?: string
  onValueChange(value: T): void
  options: readonly SegmentedOption<T>[]
  value: T
}) {
  const id = React.useId()
  const reducedMotion = useReducedMotion()

  const select = (option: SegmentedOption<T>) => {
    if (option.disabled || option.value === value) return
    onValueChange(option.value)
  }

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn("qali-segmented inline-flex rounded-xl p-0.5", className)}
    >
      {options.map((option, index) => {
        const active = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={option.disabled}
            onClick={() => select(option)}
            onKeyDown={(event) => {
              const direction =
                event.key === "ArrowLeft" || event.key === "ArrowUp"
                  ? -1
                  : event.key === "ArrowRight" || event.key === "ArrowDown"
                    ? 1
                    : 0
              if (!direction) return
              event.preventDefault()
              let next = index
              do {
                next = (next + direction + options.length) % options.length
              } while (options[next]?.disabled && next !== index)
              const optionAtIndex = options[next]
              if (optionAtIndex) select(optionAtIndex)
              event.currentTarget.parentElement
                ?.querySelectorAll<HTMLButtonElement>("[role='radio']")
                .item(next)
                .focus()
            }}
            className="relative isolate flex h-7 min-w-12 items-center justify-center rounded-[10px] px-2.5 text-xs font-medium text-muted-foreground outline-none disabled:opacity-40 aria-checked:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
          >
            {active ? (
              <motion.span
                layoutId={`segment-${id}`}
                className="absolute inset-0 -z-10 rounded-[10px] border border-[var(--qali-edge-subtle)] bg-[var(--qali-surface-flat)] shadow-[var(--qali-shadow-control)]"
                transition={
                  reducedMotion
                    ? { duration: 0 }
                    : { type: "spring", stiffness: 520, damping: 38, mass: 0.7 }
                }
              />
            ) : null}
            <span className="relative truncate">{option.label}</span>
          </button>
        )
      })}
    </div>
  )
}

export { SegmentedControl }
export type { SegmentedOption }
