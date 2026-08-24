import { Outlet, useRouterState } from "@tanstack/react-router";

import { isSettingsPath } from "./app-rail";
import { AssistantDock } from "./assistant-dock";
import { AssistantDockProvider } from "./assistant-dock-context";
import { DockProvider } from "./dock-context";
import { FloatingActionCluster } from "./floating-action-cluster";
import { WorkspaceChrome } from "./workspace-chrome";
import { CalendarPreferencesProvider } from "@/components/calendar/preferences-provider";
import { CommandMenu } from "@/commands/command-menu";

export const isWorkspaceSettingsRoute = isSettingsPath;

export function WorkspaceContent() {
  const settingsOpen = useRouterState({
    select: (state) => isWorkspaceSettingsRoute(state.location.pathname),
  });
  return (
    <CalendarPreferencesProvider>
      <DockProvider>
        <AssistantDockProvider>
          <div className="flex h-full min-h-0 min-w-0 overflow-hidden bg-background">
            <div className="relative min-w-0 flex-1">
              <WorkspaceChrome>
                <Outlet />
              </WorkspaceChrome>
              {!settingsOpen && <FloatingActionCluster />}
            </div>
            <AssistantDock />
            <CommandMenu />
          </div>
        </AssistantDockProvider>
      </DockProvider>
    </CalendarPreferencesProvider>
  );
}
