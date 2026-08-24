// @ts-expect-error Bun supplies its test module at runtime; the web app's
// TypeScript config intentionally includes browser globals only.
import { describe, expect, test } from "bun:test";

import { calendarPickerPanelMetrics } from "./calendar-control-layout";

describe("calendar control layout", () => {
  test("fits short calendar lists to content and caps only overflowing lists", () => {
    expect(
      calendarPickerPanelMetrics({
        calendarCount: 2,
        colorPaletteOpen: false,
      }),
    ).toEqual({
      contentHeight: 88,
      maxHeight: 260,
      headingHeight: 24,
      panelRadius: 14,
    });
    expect(
      calendarPickerPanelMetrics({
        calendarCount: 10,
        colorPaletteOpen: true,
      }),
    ).toEqual({
      contentHeight: 376,
      maxHeight: 260,
      headingHeight: 24,
      panelRadius: 14,
    });
  });
});
