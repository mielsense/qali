// @ts-expect-error Bun supplies its test module at runtime.
import { expect, test } from "bun:test";
import { allDayPreviewDates } from "./all-day-overflow";

test("all-day previews use civil dates and the exclusive end", () => {
  expect(allDayPreviewDates(Date.UTC(2026, 8, 9), Date.UTC(2026, 8, 10))).toBe(
    "Sep 9",
  );
  expect(allDayPreviewDates(Date.UTC(2026, 8, 9), Date.UTC(2026, 8, 12))).toBe(
    "Sep 9 – Sep 11",
  );
  expect(allDayPreviewDates(Date.UTC(2026, 9, 31), Date.UTC(2026, 10, 3))).toBe(
    "Oct 31 – Nov 2",
  );
});
