// @ts-expect-error Bun supplies its test module at runtime.
import { describe, expect, test } from "bun:test";

import {
  allDaySurfacePosition,
  eventSurfaceActivationKey,
  eventSurfacePresentation,
  eventSurfaceState,
  EVENT_SURFACE_GUTTERS,
} from "./event-surface";

describe("event surface presentation", () => {
  test("keeps timed and all-day cards in one color, edge, highlight, and text family", () => {
    const timed = eventSurfacePresentation({
      colorVar: "--event-4",
      variant: "timed",
    });
    const allDay = eventSurfacePresentation({
      colorVar: "--event-4",
      variant: "all-day",
    });

    expect(timed.backgroundColor).toBe(allDay.backgroundColor);
    expect(timed.borderColor).toBe(allDay.borderColor);
    expect(timed.boxShadow).toBe(allDay.boxShadow);
    expect(timed.color).toBe(allDay.color);
    expect(timed.radiusPx).toBe(10);
    expect(allDay.radiusPx).toBe(8);
  });

  test("uses an opaque calendar-color mixed fill, tinted hairline, and inset-only top highlight", () => {
    const surface = eventSurfacePresentation({
      colorVar: "--event-6",
      variant: "timed",
    });

    expect(surface.backgroundColor).toBe(
      "color-mix(in oklab, var(--event-6) 30%, var(--card))",
    );
    expect(surface.backgroundColor).not.toContain("transparent");
    expect(surface.borderColor).toBe(
      "color-mix(in oklab, var(--event-6) 50%, var(--border))",
    );
    expect(surface.boxShadow).toBe(
      "inset 0 1px 0 color-mix(in oklab, white 42%, transparent)",
    );
  });

  test("gives timed and all-day surfaces a quiet five-by-four pixel inset", () => {
    expect(EVENT_SURFACE_GUTTERS).toEqual({ horizontalPx: 5, verticalPx: 4 });
  });

  test("raises surface contrast for hover, focus, drag, conflict, and read-only states without changing the text role", () => {
    const idle = eventSurfacePresentation({ colorVar: "--event-2", variant: "timed" });

    for (const state of ["hover", "focus", "dragging", "conflict", "read-only"] as const) {
      const surface = eventSurfacePresentation({
        colorVar: "--event-2",
        variant: "timed",
        state,
      });
      expect(surface.fillPercent).toBeGreaterThanOrEqual(idle.fillPercent);
      expect(surface.edgePercent).toBeGreaterThan(idle.edgePercent);
      expect(surface.color).toBe(idle.color);
    }
  });

  test("keeps disabled cards readable while reducing their surface emphasis", () => {
    const idle = eventSurfacePresentation({ colorVar: "--event-2", variant: "timed" });
    const disabled = eventSurfacePresentation({
      colorVar: "--event-2",
      variant: "timed",
      state: "disabled",
    });

    expect(disabled.fillPercent).toBeLessThan(idle.fillPercent);
    expect(disabled.edgePercent).toBeLessThan(idle.edgePercent);
    expect(disabled.color).toBe(idle.color);
  });

  test("forbids exterior shadows, translation, left stripes, and hover movement", () => {
    const surface = eventSurfacePresentation({
      colorVar: "--event-5",
      variant: "all-day",
      state: "hover",
    });

    expect(surface.boxShadow).toMatch(/^inset /);
    expect(surface.className).not.toMatch(/shadow|translate|border-l|stripe/);
    expect(surface.hoverTransform).toBe("none");
  });

  test("keeps all-day lane positions stable while applying the shared vertical gutter", () => {
    expect(allDaySurfacePosition(0)).toEqual({ topPx: 4, heightPx: 28 });
    expect(allDaySurfacePosition(2)).toEqual({ topPx: 68, heightPx: 28 });
  });

  test("selects conflict contrast from the real overlap signal before ordinary states", () => {
    expect(eventSurfaceState({ canEdit: true, hasConflict: true })).toBe("conflict");
    expect(eventSurfaceState({ canEdit: false, hasConflict: true })).toBe("conflict");
    expect(
      eventSurfaceState({
        canEdit: true,
        hasConflict: true,
        isDragging: true,
      }),
    ).toBe("dragging");
  });

  test("allows keyboard event activation with Enter or Space only", () => {
    expect(eventSurfaceActivationKey("Enter")).toBe(true);
    expect(eventSurfaceActivationKey(" ")).toBe(true);
    expect(eventSurfaceActivationKey("Escape")).toBe(false);
  });
});
