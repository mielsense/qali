"use client";

import { cn } from "@qali/ui/lib/utils";
import { motion, useReducedMotion } from "motion/react";

/** Compact Luma-style switch with the Qali accent as its sole active signal. */
function Switch({
  checked,
  onCheckedChange,
  disabled,
  className,
  "aria-label": ariaLabel,
}: {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
  className?: string
  "aria-label"?: string
}) {
  const reduceMotion = useReducedMotion();

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "relative h-5 w-9 shrink-0 rounded-full border outline-none shadow-[inset_0_1px_2px_rgb(0_0_0/0.16)] focus-visible:ring-3 focus-visible:ring-[var(--qali-accent-focus)] disabled:cursor-not-allowed disabled:opacity-50",
        checked
          ? "border-[var(--qali-accent-border)] bg-[var(--qali-accent)]"
          : "border-[var(--qali-edge-subtle)] bg-foreground/10",
        className,
      )}
    >
      <motion.span
        aria-hidden
        animate={{ x: checked ? 16 : 0 }}
        className="absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow-[0_1px_2px_rgb(0_0_0/0.28)]"
        transition={
          reduceMotion
            ? { duration: 0 }
            : { type: "spring", stiffness: 400, damping: 26 }
        }
      />
    </button>
  );
}

export { Switch };
