import type { ReactNode } from "react";
import { useLocation } from "@tanstack/react-router";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

export function SettingsRow({
  action,
  children,
  description,
  id,
  label,
}: {
  action?: ReactNode;
  children?: ReactNode;
  description: string;
  id?: string;
  label: string;
}) {
  const rowId =
    id ??
    `settings-row-${label.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}`;
  const hash = useLocation({ select: (location) => location.hash });
  const highlighted = hash.replace(/^#/, "") === rowId;
  const reduceMotion = useReducedMotion();
  return (
    <motion.div
      id={rowId}
      layout="position"
      className="relative scroll-mt-8 grid min-h-[68px] gap-3 overflow-hidden rounded-xl px-3 py-3.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-7"
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
      <div className="relative z-10 min-w-0">
        <p className="text-sm font-medium leading-5 text-foreground">{label}</p>
        <p className="mt-0.5 max-w-xl text-xs leading-5 text-muted-foreground [text-wrap:pretty]">
          {description}
        </p>
      </div>
      {children ? (
        <div className="relative z-10 justify-self-start sm:justify-self-end">{children}</div>
      ) : null}
      {action ? <div className="relative z-10 sm:col-span-2">{action}</div> : null}
    </motion.div>
  );
}
