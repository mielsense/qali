import type { CivilDate } from "./zoned-calendar-clock";

/** A primary-zone civil day and its real, half-open instant interval. */
export type CalendarDay = Readonly<{
  key: CivilDate;
  startMs: number;
  endMs: number;
}>;
