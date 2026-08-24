import { LoadingScreen } from "@qali/ui/components/loading-screen";
import { Toaster } from "@qali/ui/components/sonner";
import { TooltipProvider } from "@qali/ui/components/tooltip";
import {
  HeadContent,
  Outlet,
  createRootRouteWithContext,
} from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";
import { MotionConfig } from "motion/react";
import { useEffect } from "react";

import { ThemeProvider, useTheme } from "@/components/theme-provider";
import { SettingsProvider } from "@/components/settings/settings-provider";
import { InterfaceSoundBoundary } from "@/components/settings/interface-sound";
import { renderDateFavicon } from "@/lib/date-favicon";

import "../index.css";

export interface RouterAppContext {}

export const Route = createRootRouteWithContext<RouterAppContext>()({
  component: RootComponent,
  head: () => ({
    meta: [
      {
        title: "qali",
      },
      {
        name: "description",
        content: "qali is a web application",
      },
    ],
  }),
});

function DateFavicon() {
  // `resolvedTheme` maps "system" to an actual "light" | "dark" value; the
  // favicon util reads theme colors from CSS vars, so re-render when it flips.
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    renderDateFavicon();

    // Re-render at the next local midnight so the day number stays current.
    const now = new Date();
    const nextMidnight = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + 1,
    );
    const timer = window.setTimeout(
      () => renderDateFavicon(),
      nextMidnight.getTime() - now.getTime(),
    );
    return () => window.clearTimeout(timer);
  }, [resolvedTheme]);

  return null;
}

function RootComponent() {
  return (
    <>
      <HeadContent />
      <SettingsProvider>
        <ThemeProvider>
          <MotionConfig reducedMotion="user">
            <InterfaceSoundBoundary>
              <DateFavicon />
              <TooltipProvider>
                <div className="grid h-svh grid-rows-[1fr]">
                  <Outlet />
                </div>
              </TooltipProvider>
              <LoadingScreen />
              <Toaster position="top-right" />
            </InterfaceSoundBoundary>
          </MotionConfig>
        </ThemeProvider>
      </SettingsProvider>
      {import.meta.env.DEV && <TanStackRouterDevtools position="top-left" />}
    </>
  );
}
