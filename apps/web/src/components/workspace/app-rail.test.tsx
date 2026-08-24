// @ts-expect-error Bun supplies its test module at runtime.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  APP_RAIL_DESTINATIONS,
  isAppRailDestinationActive,
  isSettingsPath,
} from "./app-rail";
import {
  DEFAULT_WORKSPACE_SECTION_ORDER,
  normalizeWorkspaceSectionOrder,
  sectionCommandId,
} from "./workspace-sections";

describe("app rail navigation", () => {
  test("provides the persistent workspace destinations", () => {
    expect(APP_RAIL_DESTINATIONS).toEqual([
      expect.objectContaining({ label: "Calendar", to: "/" }),
      expect.objectContaining({ label: "Insights", to: "/insights" }),
      expect.objectContaining({ label: "Settings", to: "/settings" }),
    ]);
  });

  test("normalizes persisted ordering and adds newly shipped sections", () => {
    expect(
      normalizeWorkspaceSectionOrder(["settings", "calendar", "unknown"]),
    ).toEqual(["settings", "calendar", "insights"]);
    expect(normalizeWorkspaceSectionOrder(null)).toEqual(
      DEFAULT_WORKSPACE_SECTION_ORDER,
    );
  });

  test("binds shortcuts to positions rather than destination names", () => {
    expect(sectionCommandId(0)).toBe("workspace.section.1");
    expect(sectionCommandId(1)).toBe("workspace.section.2");
    expect(sectionCommandId(8)).toBe("workspace.section.9");
  });

  test("derives the selected destination from the current route", () => {
    expect(isAppRailDestinationActive("/", "/")).toBe(true);
    expect(isAppRailDestinationActive("/settings", "/")).toBe(false);
    expect(isAppRailDestinationActive("/settings", "/settings")).toBe(true);
  });

  test("keeps Settings selected throughout its nested workspace routes", () => {
    expect(isSettingsPath("/settings")).toBe(true);
    expect(isSettingsPath("/settings/appearance")).toBe(true);
    expect(
      isAppRailDestinationActive("/settings/appearance", "/settings"),
    ).toBe(true);

    const workspaceLayout = readFileSync(
      new URL("./workspace-layout.tsx", import.meta.url),
      "utf8",
    );
    expect(workspaceLayout).toContain(
      "isWorkspaceSettingsRoute(state.location.pathname)",
    );
  });

  test("keeps Settings out of the bottom account panel", () => {
    const accountPanel = readFileSync(
      new URL("./account-panel.tsx", import.meta.url),
      "utf8",
    );

    expect(accountPanel).not.toContain('to="/settings"');
  });

  test("keeps rail feedback click-only", () => {
    const source = readFileSync(
      new URL("./app-rail.tsx", import.meta.url),
      "utf8",
    );

    expect(source).not.toContain("playClickSound");
    expect(source).not.toContain("playHoverSound");
    expect(source).toContain("onClick");
    expect(source).toContain("Reorder.Group");
    expect(source).toContain("Reorder.Item");
    expect(source).toContain("useDragControls");
    expect(source).toContain("openCreate");
    expect(source).toContain("WorkspaceUtilityMenu");
    expect(source).not.toContain("useAssistantDock");
    expect(source).not.toContain("rail-expanded");
    expect(source).not.toContain("Collapse sidebar");
    expect(source).not.toContain("playHoverSound");
  });

  test("keeps the utility menu label inside a Base UI menu group", () => {
    const source = readFileSync(
      new URL("./workspace-utility-menu.tsx", import.meta.url),
      "utf8",
    );

    const groupStart = source.indexOf("<DropdownMenuGroup>");
    const label = source.indexOf("<DropdownMenuLabel>Workspace</DropdownMenuLabel>");
    const groupEnd = source.indexOf("</DropdownMenuGroup>");

    expect(groupStart).toBeGreaterThan(-1);
    expect(label).toBeGreaterThan(groupStart);
    expect(groupEnd).toBeGreaterThan(label);
  });
});
