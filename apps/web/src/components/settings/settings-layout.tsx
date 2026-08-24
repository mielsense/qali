import { Outlet, useLocation } from "@tanstack/react-router";
import { useEffect, type CSSProperties } from "react";
import { createPortal } from "react-dom";

import { useWorkspaceHeaderTarget } from "@/components/workspace/workspace-chrome";

import { SettingsSidebar } from "./settings-sidebar";

export function SettingsLayout() {
  const workspaceHeader = useWorkspaceHeaderTarget();
  const hash = useLocation({ select: (location) => location.hash });

  useEffect(() => {
    if (!hash) return;
    const frame = requestAnimationFrame(() => {
      document
        .getElementById(hash.replace(/^#/, ""))
        ?.scrollIntoView({ block: "center" });
    });
    return () => cancelAnimationFrame(frame);
  }, [hash]);
  const header = (
    <header
      className="flex h-full items-stretch bg-background"
      style={{ WebkitAppRegion: "drag" } as CSSProperties}
    >
      <div className="settings-sidebar-header flex w-[252px] shrink-0 items-center border-e border-border px-4">
        <div>
          <span className="font-display text-[13px] tracking-[0.04em] text-foreground">
            Settings
          </span>
          <span className="ms-2 text-[11px] text-muted-foreground">
            Auto-saved
          </span>
        </div>
      </div>
      <div aria-hidden="true" className="min-w-0 flex-1" />
    </header>
  );

  return (
    <>
      {workspaceHeader ? createPortal(header, workspaceHeader) : header}
      <section
        className="qali-settings-layout flex h-full min-h-0 overflow-hidden"
        aria-label="Settings"
      >
        <SettingsSidebar />
        <div className="flex min-w-0 flex-1 justify-center overflow-y-auto">
          <div className="w-full max-w-[900px] px-7 py-8 lg:px-12 lg:py-10">
            <Outlet />
          </div>
        </div>
      </section>
    </>
  );
}
