// @ts-expect-error Bun supplies its test module at runtime.
import { describe, expect, it } from "bun:test";
import { layoutPosition } from "./floating-positioner";

describe("frosted menu positioning", () => {
  it("preserves fractional and negative collision coordinates without a translated layer", () => {
    expect(layoutPosition({position: "fixed", left: 0, top: 0, transform: "translate(-12.5px, 84.25px)", willChange: "transform", width: 240})).toEqual({position: "fixed", left: -12.5, top: 84.25, transform: "none", willChange: "auto", width: 240});
  });
  it("leaves native layout positioning and unknown transforms intact", () => {
    for (const style of [undefined, {left: 30, top: 40}, {left: 0, top: 0, transform: "scale(1)"}, {left: 20, top: 0, transform: "translate(5px, 8px)"}]) {
      expect(layoutPosition(style)).toBe(style);
    }
  });
});
