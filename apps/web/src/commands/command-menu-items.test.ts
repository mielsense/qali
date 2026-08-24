// @ts-expect-error Bun supplies its test module at runtime; the web app's
// TypeScript config intentionally includes browser globals only.
import { describe, expect, test } from "bun:test";

import { COMMAND_MENU_ITEMS } from "./command-menu-items";

describe("command menu catalog", () => {
  test("covers core navigation and calendar actions without listing itself", () => {
    expect(COMMAND_MENU_ITEMS.map((item) => item.id)).toEqual(
      expect.arrayContaining([
        "navigate.calendar",
        "navigate.insights",
        "navigate.settings",
        "calendar.event.create",
        "assistant.toggle",
      ]),
    );
    expect(
      COMMAND_MENU_ITEMS.some(
        (item) => (item.id as string) === "command-palette.open",
      ),
    )
      .toBe(false);
  });

  test("provides search language and groups for every item", () => {
    for (const item of COMMAND_MENU_ITEMS) {
      expect(item.group.length).toBeGreaterThan(0);
      expect(item.label.length).toBeGreaterThan(0);
      expect(item.keywords.length).toBeGreaterThan(0);
    }
  });
});
