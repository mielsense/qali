import type { ReactNode } from "react";

import { cn } from "@qali/ui/lib/utils";

/**
 * Quiet analytics frame inspired by Open Analytics: labels stay in the outer
 * frame while values and charts sit on one recessed inner plate. This keeps
 * dense data readable without turning every block into a floating card.
 */
function DataFrame({
  title,
  description,
  icon,
  action,
  children,
  className,
  bodyClassName,
}: {
  title: string
  description?: string
  icon?: ReactNode
  action?: ReactNode
  children: ReactNode
  className?: string
  bodyClassName?: string
}) {
  return (
    <section
      className={cn(
        "rounded-[22px] border border-[var(--qali-edge-subtle)] bg-[var(--qali-surface-flat)] p-1",
        className,
      )}
    >
      <header className="flex min-h-11 items-start justify-between gap-4 px-3.5 py-2.5">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs font-medium text-foreground">
            <span className="truncate">{title}</span>
            {icon ? (
              <span className="shrink-0 text-muted-foreground">{icon}</span>
            ) : null}
          </div>
          {description ? (
            <p className="mt-0.5 truncate text-[11px] leading-4 text-muted-foreground">
              {description}
            </p>
          ) : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </header>
      <div
        className={cn(
          "rounded-[17px] border border-[var(--qali-edge-subtle)] bg-[var(--qali-surface-inset)] shadow-[inset_0_1px_3px_rgb(0_0_0/0.12)]",
          bodyClassName,
        )}
      >
        {children}
      </div>
    </section>
  );
}

export { DataFrame };
