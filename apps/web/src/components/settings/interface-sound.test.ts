// @ts-expect-error Bun supplies its test module at runtime; the web app's
// TypeScript config intentionally includes browser globals only.
import { describe, expect, test } from "bun:test";

import { shouldPlayInterfaceSound } from "./interface-sound";

function target(options: {
  interactive?: boolean;
  disabled?: boolean;
  muted?: boolean;
}) {
  const interactive = {
    matches(selector: string) {
      return (
        (options.disabled && selector.includes(":disabled")) ||
        (options.muted && selector.includes("data-interface-sound='off'"))
      );
    },
    closest(selector: string) {
      return options.muted && selector.includes("data-interface-sound='off'")
        ? interactive
        : null;
    },
  };
  return {
    closest() {
      return options.interactive ? interactive : null;
    },
  };
}

describe("interface click sounds", () => {
  test("plays once for enabled semantic controls", () => {
    expect(shouldPlayInterfaceSound(target({ interactive: true }))).toBe(true);
  });

  test("stays silent for non-controls, disabled controls, and opt-outs", () => {
    expect(shouldPlayInterfaceSound(target({}))).toBe(false);
    expect(
      shouldPlayInterfaceSound(target({ interactive: true, disabled: true })),
    ).toBe(false);
    expect(
      shouldPlayInterfaceSound(target({ interactive: true, muted: true })),
    ).toBe(false);
  });
});
