import { v } from "convex/values";

export const CALENDAR_COLOR_KEYS = [
  "event-1",
  "event-2",
  "event-3",
  "event-4",
  "event-5",
  "event-6",
  "event-7",
  "event-8",
  "event-neutral",
] as const;

export type CalendarColorKey = (typeof CALENDAR_COLOR_KEYS)[number];

export const calendarColorKeyValidator = v.union(
  v.literal("event-1"),
  v.literal("event-2"),
  v.literal("event-3"),
  v.literal("event-4"),
  v.literal("event-5"),
  v.literal("event-6"),
  v.literal("event-7"),
  v.literal("event-8"),
  v.literal("event-neutral"),
);
