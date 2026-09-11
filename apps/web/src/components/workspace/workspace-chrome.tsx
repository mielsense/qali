import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from "react";

import { AppRail } from "./app-rail";

const WorkspaceHeaderTargetContext = createContext<HTMLElement | null>(null);

/**
 * Keep the toolbar inline until its host exists (SSR and standalone calendar),
 * then switch to the committed chrome target on the ref callback's rerender.
 */
export function useWorkspaceHeaderTarget() {
  return useContext(WorkspaceHeaderTargetContext);
}

export function commitWorkspaceHeaderTarget(
  current: HTMLElement | null,
  next: HTMLElement | null,
) {
  return current === next ? current : next;
}

export const WORKSPACE_CHROME_GEOMETRY = {
  headerHeight: 48,
  railWidth: 64,
  railContentStart: 48,
  // Gives the native traffic-light zone (about 78px) plus breathing room for
  // date controls. The platform CSS applies this to the draggable toolbar.
  trafficLightSafeInset: 96,
  chromeSurface: "frosted-glass",
  singleSurface: false,
  geometricLinework: false,
  contentInset: 8,
  contentRadius: 20,
} as const;

/**
 * One frosted material connects the navigation rail and toolbar. The calendar
 * owns its opaque canvas; reduced transparency resolves the shell to opaque.
 */
export function WorkspaceChrome({ children }: { children: ReactNode }) {
  const { headerHeight, railWidth } = WORKSPACE_CHROME_GEOMETRY;
  const [headerTarget, setHeaderTarget] = useState<HTMLElement | null>(null);
  const setHeaderTargetRef = useCallback((node: HTMLDivElement | null) => {
    setHeaderTarget((current) => commitWorkspaceHeaderTarget(current, node));
  }, []);

  return (
    <WorkspaceHeaderTargetContext value={headerTarget}>
      <div
        className="relative grid h-full min-h-0 min-w-0 overflow-hidden"
        style={{
          gridTemplateColumns: `${railWidth}px minmax(0, 1fr)`,
          gridTemplateRows: `${headerHeight}px minmax(0, 1fr)`,
        }}
      >
        <a
          href="#workspace-main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-lg focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:outline-2 focus:outline-offset-2 focus:outline-ring"
        >
          Skip to content
        </a>
        <div aria-hidden="true" className="qali-shell-material pointer-events-none absolute inset-0 z-0" />

        <div className="relative z-10 col-start-1 row-start-1 row-span-2 min-h-0">
          <AppRail />
        </div>

        <div
          ref={setHeaderTargetRef}
          id="workspace-header"
          className="relative z-10 col-start-2 row-start-1 min-w-0"
        />

        <main
          id="workspace-main"
          tabIndex={-1}
          className="qali-workspace-inset relative z-10 col-start-2 row-start-2 min-h-0 min-w-0 overflow-hidden outline-none"
        >
          {children}
        </main>
      </div>
    </WorkspaceHeaderTargetContext>
  );
}
