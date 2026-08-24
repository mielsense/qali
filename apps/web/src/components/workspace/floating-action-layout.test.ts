// @ts-expect-error Bun supplies its test module at runtime.
import { describe, expect, test } from "bun:test";

import { FLOATING_ACTION_CONTRACT } from "./floating-action-layout";

describe("calendar panel layout", () => {
  test("keeps only contextual event panels floating over the calendar", () => {
    expect(FLOATING_ACTION_CONTRACT).toMatchObject({
      panel: {
        bottomPx: 12,
        alignment: "calendar-content-center",
        contextualOnly: true,
      },
      assistant: {
        placement: "layout-pane",
        pushesContent: true,
      },
    });
    expect(FLOATING_ACTION_CONTRACT).not.toHaveProperty("actions");
  });

  test("uses opacity-only floating transitions for reduced motion", () => {
    const reduced = FLOATING_ACTION_CONTRACT.motion.reduced;
    expect(reduced.initial).toEqual({ opacity: 0 });
    expect(reduced.animate).not.toHaveProperty("transform");
    expect(reduced.exit).not.toHaveProperty("transform");
  });
});
