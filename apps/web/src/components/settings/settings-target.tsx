import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";
import { useLocation } from "@tanstack/react-router";

import { cn } from "@qali/ui/lib/utils";

/** Gives non-row settings content the same routed search highlight as a row. */
export function SettingsTarget({
  children,
  className,
  id,
}: {
  children: ReactNode;
  className?: string;
  id: string;
}) {
  const hash = useLocation({ select: (location) => location.hash });
  const highlighted = hash.replace(/^#/, "") === id;
  const reduceMotion = useReducedMotion();

  return (
    <motion.div
      id={id}
      layout="position"
      className={cn(
        "relative scroll-mt-8 overflow-hidden rounded-xl",
        className,
      )}
    >
      <AnimatePresence initial={false}>
        {highlighted ? (
          <motion.span
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 rounded-xl bg-[color-mix(in_oklch,var(--qali-accent)_8%,transparent)] ring-1 ring-inset ring-[color-mix(in_oklch,var(--qali-accent)_24%,transparent)]"
            initial={reduceMotion ? false : { opacity: 0, scale: 0.985 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={
              reduceMotion
                ? { duration: 0 }
                : { type: "spring", stiffness: 400, damping: 26 }
            }
          />
        ) : null}
      </AnimatePresence>
      <div className="relative z-10">{children}</div>
    </motion.div>
  );
}
