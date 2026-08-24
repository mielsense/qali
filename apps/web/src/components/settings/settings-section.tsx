import type { ReactNode } from "react";

export function SettingsSection({
  children,
  description,
  title,
}: {
  children: ReactNode;
  description: string;
  title: string;
}) {
  return (
    <section aria-labelledby={`${title.toLowerCase().replaceAll(" ", "-")}-heading`}>
      <header className="pb-7">
        <h1
          id={`${title.toLowerCase().replaceAll(" ", "-")}-heading`}
          className="text-xl font-medium leading-tight tracking-[-0.02em] text-foreground"
        >
          {title}
        </h1>
        <p className="mt-1.5 max-w-2xl text-sm leading-6 text-muted-foreground [text-wrap:pretty]">
          {description}
        </p>
      </header>
      <div>{children}</div>
    </section>
  );
}
