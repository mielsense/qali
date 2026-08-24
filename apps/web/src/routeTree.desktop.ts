/* eslint-disable */
// @ts-nocheck

import { createRoute } from "@tanstack/react-router";
import { WorkspaceContent } from "./components/workspace/workspace-layout";
import { Route as rootRouteImport } from "./routes/__root";
import { Route as WorkspaceIndexRouteImport } from "./routes/_workspace/index";
import { Route as WorkspaceInsightsRouteImport } from "./routes/_workspace/insights";
import { Route as WorkspaceSettingsRouteImport } from "./routes/_workspace/settings/route";
import { Route as WorkspaceSettingsIndexRouteImport } from "./routes/_workspace/settings/index";
import { Route as WorkspaceSettingsCalendarRouteImport } from "./routes/_workspace/settings/calendar";
import { Route as WorkspaceSettingsTimeZonesRouteImport } from "./routes/_workspace/settings/time-zones";
import { Route as WorkspaceSettingsCalendarsGoogleRouteImport } from "./routes/_workspace/settings/calendars-google";
import { Route as WorkspaceSettingsAppearanceRouteImport } from "./routes/_workspace/settings/appearance";
import { Route as WorkspaceSettingsShortcutsRouteImport } from "./routes/_workspace/settings/shortcuts";
import { Route as WorkspaceSettingsAssistantRouteImport } from "./routes/_workspace/settings/assistant";
import { Route as WorkspaceSettingsDataRecoveryRouteImport } from "./routes/_workspace/settings/data-recovery";

const WorkspaceRoute = createRoute({
  id: "/_workspace",
  getParentRoute: () => rootRouteImport,
  component: WorkspaceContent,
});
const WorkspaceIndexRoute = WorkspaceIndexRouteImport.update({
  id: "/",
  path: "/",
  getParentRoute: () => WorkspaceRoute,
} as any);
const WorkspaceInsightsRoute = WorkspaceInsightsRouteImport.update({
  id: "/insights",
  path: "/insights",
  getParentRoute: () => WorkspaceRoute,
} as any);
const WorkspaceSettingsRoute = WorkspaceSettingsRouteImport.update({
  id: "/settings",
  path: "/settings",
  getParentRoute: () => WorkspaceRoute,
} as any);
const WorkspaceSettingsIndexRoute = WorkspaceSettingsIndexRouteImport.update({
  id: "/",
  path: "/",
  getParentRoute: () => WorkspaceSettingsRoute,
} as any);
const WorkspaceSettingsCalendarRoute = WorkspaceSettingsCalendarRouteImport.update({
  id: "/calendar",
  path: "/calendar",
  getParentRoute: () => WorkspaceSettingsRoute,
} as any);
const WorkspaceSettingsTimeZonesRoute = WorkspaceSettingsTimeZonesRouteImport.update({
  id: "/time-zones",
  path: "/time-zones",
  getParentRoute: () => WorkspaceSettingsRoute,
} as any);
const WorkspaceSettingsCalendarsGoogleRoute = WorkspaceSettingsCalendarsGoogleRouteImport.update({
  id: "/calendars-google",
  path: "/calendars-google",
  getParentRoute: () => WorkspaceSettingsRoute,
} as any);
const WorkspaceSettingsAppearanceRoute = WorkspaceSettingsAppearanceRouteImport.update({
  id: "/appearance",
  path: "/appearance",
  getParentRoute: () => WorkspaceSettingsRoute,
} as any);
const WorkspaceSettingsShortcutsRoute = WorkspaceSettingsShortcutsRouteImport.update({
  id: "/shortcuts",
  path: "/shortcuts",
  getParentRoute: () => WorkspaceSettingsRoute,
} as any);
const WorkspaceSettingsAssistantRoute = WorkspaceSettingsAssistantRouteImport.update({
  id: "/assistant",
  path: "/assistant",
  getParentRoute: () => WorkspaceSettingsRoute,
} as any);
const WorkspaceSettingsDataRecoveryRoute = WorkspaceSettingsDataRecoveryRouteImport.update({
  id: "/data-recovery",
  path: "/data-recovery",
  getParentRoute: () => WorkspaceSettingsRoute,
} as any);

export const desktopRouteTree = rootRouteImport._addFileChildren({
  WorkspaceRoute: WorkspaceRoute._addFileChildren({
    WorkspaceIndexRoute,
    WorkspaceInsightsRoute,
    WorkspaceSettingsRoute: WorkspaceSettingsRoute._addFileChildren({
      WorkspaceSettingsIndexRoute,
      WorkspaceSettingsCalendarRoute,
      WorkspaceSettingsTimeZonesRoute,
      WorkspaceSettingsCalendarsGoogleRoute,
      WorkspaceSettingsAppearanceRoute,
      WorkspaceSettingsShortcutsRoute,
      WorkspaceSettingsAssistantRoute,
      WorkspaceSettingsDataRecoveryRoute,
    }),
  }),
});
