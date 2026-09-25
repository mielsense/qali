import { Component, useEffect, useRef, type ReactNode } from "react";

/** Keep recovery independent of the router, settings and desktop providers. */
export function AppErrorScreen() {
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    heading.current?.focus();
  }, []);

  return (
    <main className="flex min-h-svh items-center justify-center bg-background px-6 py-20 text-foreground">
      <div
        aria-hidden="true"
        className="fixed inset-x-0 top-0 h-12 [-webkit-app-region:drag]"
      />
      <section className="w-full max-w-sm [-webkit-app-region:no-drag]">
        <div
          aria-hidden="true"
          className="mb-8 flex size-12 items-center justify-center rounded-2xl border border-border bg-muted text-xl font-semibold shadow-sm"
        >
          Q
        </div>
        <p className="mb-2 text-sm font-medium text-muted-foreground">
          Something went wrong
        </p>
        <h1
          ref={heading}
          tabIndex={-1}
          className="text-2xl font-semibold tracking-tight outline-none"
        >
          Qali couldn’t open this view.
        </h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          Reload the app to return to your calendar. Changes you haven’t saved
          may be lost.
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="mt-6 inline-flex min-h-10 items-center justify-center rounded-xl bg-primary px-4 text-sm font-medium text-primary-foreground shadow-sm hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
        >
          Reload app
        </button>
        <p className="mt-4 text-xs leading-5 text-muted-foreground">
          If this keeps happening, quit Qali and open it again.
        </p>
      </section>
    </main>
  );
}

export class AppErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? <AppErrorScreen /> : this.props.children;
  }
}
