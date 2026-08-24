import type { ReactNode } from "react";

export function SettingsGroup({
  children,
  description,
  title,
}: {
  children: ReactNode;
  description: string;
  title: string;
}) {
  const id = `settings-${title.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}`;
  return (
    <section aria-labelledby={id} className="first:pt-0 [&+&]:mt-10">
      <header className="pb-3.5 px-1">
        <h2 id={id} className="text-sm font-medium text-foreground">
          {title}
        </h2>
        <p className="mt-0.5 text-xs leading-5 text-muted-foreground [text-wrap:pretty]">
          {description}
        </p>
      </header>
      <div className="rounded-2xl bg-[var(--qali-surface-flat)] p-1">{children}</div>
    </section>
  );
}
