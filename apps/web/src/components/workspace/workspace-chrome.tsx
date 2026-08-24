import {
  createContext,
  useCallback,
  useContext,
  useState,
  type CSSProperties,
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
  headerHeight: 56,
  railWidth: 84,
  railContentStart: 56,
  // Gives the native traffic-light zone (about 78px) plus breathing room for
  // date controls. The platform CSS applies this to the draggable toolbar.
  trafficLightSafeInset: 96,
  chromeSurface: "calendar-background",
  singleSurface: true,
  geometricLinework: true,
} as const;

/**
 * The connected L-shaped shell uses the same opaque background token as the
 * calendar canvas. Separator lines carry the structure without introducing a
 * second material or color plane.
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
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-0 bg-background"
          style={{
            clipPath: `polygon(0 0, 100% 0, 100% ${headerHeight}px, ${railWidth}px ${headerHeight}px, ${railWidth}px 100%, 0 100%)`,
          }}
        />
        <div
          aria-hidden="true"
          className="qali-shell-linework pointer-events-none absolute inset-0 z-[1]"
          style={
            {
              "--qali-shell-header": `${headerHeight}px`,
              "--qali-shell-rail": `${railWidth}px`,
            } as CSSProperties
          }
        />

        <div className="relative z-10 col-start-1 row-start-2 min-h-0">
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
          className="relative z-10 col-start-2 row-start-2 min-h-0 min-w-0 overflow-hidden focus-visible:outline-2 focus-visible:outline-inset focus-visible:outline-ring"
        >
          {children}
        </main>
      </div>
    </WorkspaceHeaderTargetContext>
  );
}
