// @ts-expect-error Bun supplies its test module at runtime; the web app's
// TypeScript config intentionally includes browser globals only.
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import {
  SETTINGS_NAVIGATION,
  findSettingsNavigation,
  findSettingsSearchResults,
  moveSettingsNavigation,
} from "./settings-navigation";

describe("settings navigation", () => {
  test("keeps every settings destination reachable in the desktop route tree", async () => {
    const source = await readFile(
      new URL("../../routeTree.desktop.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain('from "./routes/_workspace/settings/route"');
    for (const item of SETTINGS_NAVIGATION) {
      expect(source).toContain(
        `./routes/_workspace/settings/${item.to.split("/").at(-1)}`,
      );
    }
  });

  test("uses the workspace landmark and consolidates appearance into preferences", async () => {
    const layout = await readFile(
      new URL("./settings-layout.tsx", import.meta.url),
      "utf8",
    );
    const appearance = await readFile(
      new URL(
        "../../routes/_workspace/settings/appearance.tsx",
        import.meta.url,
      ),
      "utf8",
    );
    const sidebar = await readFile(
      new URL("./settings-sidebar.tsx", import.meta.url),
      "utf8",
    );

    expect(layout).not.toContain("<main");
    expect(layout).toContain('aria-label="Settings"');
    expect(layout).toContain("qali-settings-layout");
    expect(layout).toContain("bg-background");
    expect(sidebar).toContain("qali-settings-sidebar");
    expect(sidebar).not.toContain("bg-card");
    expect(appearance).toContain(
      '<Navigate to="/settings/calendar" replace />',
    );
  });

  test("maps every settings category to its own route", () => {
    expect(SETTINGS_NAVIGATION.map((item) => [item.label, item.to])).toEqual([
      ["Preferences", "/settings/calendar"],
      ["Calendars & Google", "/settings/calendars-google"],
      ["Shortcuts", "/settings/shortcuts"],
      ["Assistant", "/settings/assistant"],
      ["System & recovery", "/settings/data-recovery"],
    ]);
  });

  test("searches category labels and keywords without hiding route identity", () => {
    expect(findSettingsNavigation("google")).toEqual([
      expect.objectContaining({
        label: "Calendars & Google",
        to: "/settings/calendars-google",
      }),
    ]);
    expect(findSettingsNavigation("timezone")).toEqual([
      expect.objectContaining({
        label: "Preferences",
        to: "/settings/calendar",
      }),
    ]);
  });

  test("finds individual controls and their destination anchors", () => {
    expect(findSettingsSearchResults("interface sounds")[0]).toMatchObject({
      label: "Interface sounds",
      to: "/settings/calendar",
      anchor: "settings-row-interface-sounds",
    });
    expect(findSettingsSearchResults("calendar preselected")[0]).toMatchObject({
      label: "New events",
      to: "/settings/calendar",
      anchor: "settings-row-new-events",
    });
    expect(findSettingsSearchResults("codex runtime")[0]).toMatchObject({
      label: "Provider status",
      to: "/settings/assistant",
    });
    expect(findSettingsSearchResults("keybindings")[0]).toMatchObject({
      label: "Keyboard shortcuts",
      to: "/settings/shortcuts",
      anchor: "keybindings-heading",
    });
  });

  test("moves a roving navigation index with arrows and Home/End", () => {
    expect(moveSettingsNavigation(0, "ArrowUp", 5)).toBe(4);
    expect(moveSettingsNavigation(4, "ArrowDown", 5)).toBe(0);
    expect(moveSettingsNavigation(3, "Home", 5)).toBe(0);
    expect(moveSettingsNavigation(3, "End", 5)).toBe(4);
    expect(moveSettingsNavigation(3, "Enter", 5)).toBe(3);
  });
});
