// @ts-expect-error Bun supplies its test module at runtime; the web app's
// TypeScript config intentionally includes browser globals only.
import { describe, expect, test } from "bun:test";

import { defaultCommandKeybindings } from "@qali/desktop-contracts";

import {
  COMMANDS,
  createCommandDispatcher,
  effectiveKeybinding,
} from "./registry";

describe("command registry", () => {
  test("uses the contract defaults as its sole binding source", () => {
    for (const command of COMMANDS) {
      expect(command.defaultBinding).toEqual(
        defaultCommandKeybindings[
          command.id as keyof typeof defaultCommandKeybindings
        ] ?? null,
      );
    }
    expect(
      COMMANDS.find((command) => command.id === "calendar.today")
        ?.defaultBinding,
    ).toEqual({ key: "t", modifiers: [] });
  });

  test("keeps every essential action available to semantic pointer dispatch", () => {
    const calls: string[] = [];
    const dispatcher = createCommandDispatcher(
      Object.fromEntries(
        COMMANDS.map((command) => [
          command.id,
          () => {
            calls.push(command.id);
          },
        ]),
      ),
    );

    for (const command of COMMANDS) {
      expect(dispatcher.dispatch(command.id)).toBe(true);
    }
    expect(calls).toEqual(COMMANDS.map((command) => command.id));
  });

  test("dispatch reports disabled commands and resolves reset defaults", () => {
    const dispatcher = createCommandDispatcher({});
    expect(dispatcher.dispatch("calendar.today")).toBe(false);
    expect(effectiveKeybinding("command-palette.open", {})).toEqual({
      key: "k",
      modifiers: ["meta"],
    });
    expect(
      effectiveKeybinding("assistant.toggle", { "assistant.toggle": null }),
    ).toBeNull();
  });
});
