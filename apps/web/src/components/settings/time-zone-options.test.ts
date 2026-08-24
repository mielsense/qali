// @ts-expect-error Bun supplies its test module at runtime.
import { describe, expect, test } from "bun:test";

import {
  resolveTimeZoneSelection,
  searchTimeZones,
  updateReferenceTimeZones,
} from "./time-zone-options";

describe("time-zone combobox options", () => {
  test("searches canonical zones by their readable label", () => {
    expect(
      searchTimeZones(
        ["America/Los_Angeles", "America/New_York", "Europe/Paris"],
        "new york",
      ),
    ).toEqual(["America/New_York"]);
  });

  test("keeps at most two unique reference zones outside the primary zone", () => {
    expect(
      updateReferenceTimeZones(
        ["Europe/London"],
        1,
        "Asia/Tokyo",
        "Europe/Paris",
      ),
    ).toEqual(["Europe/London", "Asia/Tokyo"]);
    expect(
      updateReferenceTimeZones(
        ["Europe/London", "Asia/Tokyo"],
        1,
        "Europe/London",
        "Europe/Paris",
      ),
    ).toEqual(["Europe/London"]);
    expect(
      updateReferenceTimeZones(
        ["Europe/London", "Asia/Tokyo"],
        0,
        "Europe/Paris",
        "Europe/Paris",
      ),
    ).toEqual(["Asia/Tokyo"]);
  });

  test("ignores keyboard clear for the required primary and clears an optional reference", () => {
    expect(resolveTimeZoneSelection(null, false)).toBeUndefined();
    expect(resolveTimeZoneSelection(null, true)).toBe("");
    expect(resolveTimeZoneSelection("Asia/Tokyo", false)).toBe("Asia/Tokyo");
  });
});
