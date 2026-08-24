// @ts-expect-error Bun supplies its test module at runtime; the web app's
// TypeScript config intentionally includes browser globals only.
import { describe, expect, test } from "bun:test";

import type { Keybinding } from "@qali/desktop-contracts";

import {
  captureKeybinding,
  clearKeybindingOverrides,
  findKeybindingConflicts,
  formatKeybindingLabel,
  keybindingKeyLabels,
  keybindingSearchQueryFromEvent,
  keybindingsEqual,
  matchesKeybindingSearch,
  normalizeKeybinding,
  resetKeybindingOverride,
  resolveCommand,
  setKeybindingOverride,
} from "./keybinding";

const calendarContext = { calendar: true } as const;
const globalContext = { calendar: false } as const;

function keyEvent(
  key: string,
  options: Partial<{
    altKey: boolean;
    ctrlKey: boolean;
    defaultPrevented: boolean;
    isComposing: boolean;
    keyCode: number;
    metaKey: boolean;
    repeat: boolean;
    shiftKey: boolean;
    target: EventTarget | null;
  }> = {},
) {
  return {
    key,
    altKey: false,
    ctrlKey: false,
    defaultPrevented: false,
    isComposing: false,
    keyCode: 0,
    metaKey: false,
    repeat: false,
    shiftKey: false,
    target: null,
    ...options,
  };
}

function ownedTarget(
  kind: "input" | "contenteditable" | "menu" | "dialog" | "recorder",
) {
  return {
    closest(selector: string) {
      const selectors = {
        input: "input",
        contenteditable: "[contenteditable]",
        menu: "[role='menu']",
        dialog: "[role='dialog']",
        recorder: "[data-keybinding-recorder]",
      } as const;
      return selector.includes(selectors[kind]) ? this : null;
    },
  } as unknown as EventTarget;
}

describe("keybinding normalization", () => {
  test("normalizes key case, aliases, and modifier order", () => {
    expect(
      normalizeKeybinding({ key: "K", modifiers: ["shift", "meta"] }),
    ).toEqual({ key: "k", modifiers: ["meta", "shift"] });
    expect(normalizeKeybinding({ key: "Left", modifiers: ["meta"] })).toEqual({
      key: "arrowleft",
      modifiers: ["meta"],
    });
  });

  test("formats normalized macOS labels", () => {
    expect(formatKeybindingLabel({ key: "k", modifiers: ["meta"] })).toBe("⌘K");
    expect(
      formatKeybindingLabel({ key: "arrowleft", modifiers: ["meta", "shift"] }),
    ).toBe("⌘⇧←");
  });
});

describe("command resolution", () => {
  test("resolves single-letter views only in calendar context", () => {
    expect(resolveCommand(keyEvent("d"), calendarContext)).toBe(
      "calendar.view.day",
    );
    expect(resolveCommand(keyEvent("D"), calendarContext)).toBe(
      "calendar.view.day",
    );
    expect(resolveCommand(keyEvent("d"), globalContext)).toBeNull();
  });

  test("keeps unmodified single-letter overrides calendar-only", () => {
    const overrides = {
      "settings.open": { key: "s", modifiers: [] },
    } as const;
    expect(resolveCommand(keyEvent("s"), globalContext, overrides)).toBeNull();
    expect(resolveCommand(keyEvent("s"), calendarContext, overrides)).toBe(
      "settings.open",
    );
  });

  test("does not steal bare keys from editable, menu, dialog, or recorder owners", () => {
    for (const kind of [
      "input",
      "contenteditable",
      "menu",
      "dialog",
      "recorder",
    ] as const) {
      expect(
        resolveCommand(
          keyEvent("d", { target: ownedTarget(kind) }),
          calendarContext,
        ),
      ).toBeNull();
    }
  });

  test("ignores consumed, repeated, recording, and IME events", () => {
    expect(
      resolveCommand(
        keyEvent("d", { defaultPrevented: true }),
        calendarContext,
      ),
    ).toBeNull();
    expect(
      resolveCommand(keyEvent("d", { repeat: true }), calendarContext),
    ).toBeNull();
    expect(
      resolveCommand(keyEvent("d"), { calendar: true, recording: true }),
    ).toBeNull();
    expect(
      resolveCommand(
        keyEvent("k", { metaKey: true, isComposing: true }),
        calendarContext,
      ),
    ).toBeNull();
    expect(
      resolveCommand(
        keyEvent("k", { metaKey: true, keyCode: 229 }),
        calendarContext,
      ),
    ).toBeNull();
  });

  test("uses overrides and treats null as disabled", () => {
    expect(
      resolveCommand(keyEvent("j", { metaKey: true }), globalContext, {
        "assistant.toggle": { key: "j", modifiers: ["meta"] },
      }),
    ).toBe("assistant.toggle");
    expect(
      resolveCommand(keyEvent("k", { metaKey: true }), globalContext, {
        "command-palette.open": null,
      }),
    ).toBeNull();
  });
});

describe("shortcut editing", () => {
  test("searches shortcuts by command copy, textual modifiers, and macOS glyphs", () => {
    const command = {
      id: "command-palette.open",
      context: "global",
      label: "Open command menu",
      defaultBinding: { key: "k", modifiers: ["meta"] },
    } as const;

    expect(
      matchesKeybindingSearch(command, command.defaultBinding, "command menu"),
    ).toBe(true);
    expect(
      matchesKeybindingSearch(command, command.defaultBinding, "cmd k"),
    ).toBe(true);
    expect(
      matchesKeybindingSearch(command, command.defaultBinding, "command k"),
    ).toBe(true);
    expect(matchesKeybindingSearch(command, command.defaultBinding, "⌘K")).toBe(
      true,
    );
    expect(
      matchesKeybindingSearch(command, command.defaultBinding, "option k"),
    ).toBe(false);
  });

  test("returns one key-cap label per modifier and key", () => {
    expect(
      keybindingKeyLabels({
        key: "arrowleft",
        modifiers: ["shift", "meta"],
      }),
    ).toEqual(["⌘", "⇧", "←"]);
    expect(keybindingKeyLabels(null)).toEqual([]);
  });

  test("turns a pressed modifier chord into a searchable glyph query", () => {
    expect(
      keybindingSearchQueryFromEvent(
        keyEvent("K", { metaKey: true, shiftKey: true }),
      ),
    ).toBe("⌘⇧K");
    expect(keybindingSearchQueryFromEvent(keyEvent("k"))).toBeNull();
    expect(
      keybindingSearchQueryFromEvent(keyEvent("Meta", { metaKey: true })),
    ).toBeNull();
  });

  test("compares normalized bindings and preserves disabled equality", () => {
    expect(
      keybindingsEqual(
        { key: "K", modifiers: ["shift", "meta"] },
        { key: "k", modifiers: ["meta", "shift"] },
      ),
    ).toBe(true);
    expect(keybindingsEqual(null, null)).toBe(true);
    expect(
      keybindingsEqual(null, { key: "k", modifiers: ["meta"] }),
    ).toBe(false);
  });

  test("reports conflicts only when command contexts overlap", () => {
    const binding: Keybinding = { key: "d", modifiers: [] };
    expect(findKeybindingConflicts("settings.open", binding, {})).toEqual([
      "calendar.view.day",
    ]);
    expect(
      findKeybindingConflicts("calendar.view.week", binding, {
        "settings.open": { key: "d", modifiers: [] },
      }),
    ).toEqual(["calendar.view.day", "settings.open"]);
  });

  test("sets, resets one, and resets all overrides without mutating input", () => {
    const initial = { "assistant.toggle": null } as const;
    const changed = setKeybindingOverride(initial, "calendar.view.day", {
      key: "1",
      modifiers: ["meta"],
    });
    expect(changed).toEqual({
      "assistant.toggle": null,
      "calendar.view.day": { key: "1", modifiers: ["meta"] },
    });
    expect(initial).toEqual({ "assistant.toggle": null });
    expect(resetKeybindingOverride(changed, "assistant.toggle")).toEqual({
      "calendar.view.day": { key: "1", modifiers: ["meta"] },
    });
    expect(clearKeybindingOverrides(changed)).toEqual({});
  });

  test("recorder captures a normalized shortcut and swallows invalid events", () => {
    expect(
      captureKeybinding(keyEvent("K", { metaKey: true, shiftKey: true })),
    ).toEqual({ key: "k", modifiers: ["meta", "shift"] });
    expect(captureKeybinding(keyEvent("Meta", { metaKey: true }))).toBeNull();
    expect(
      captureKeybinding(
        keyEvent("Process", { keyCode: 229, isComposing: true }),
      ),
    ).toBeNull();
  });
});
