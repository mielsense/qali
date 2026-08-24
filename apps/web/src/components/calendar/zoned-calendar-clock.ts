import type { CalendarDay } from "./calendar-day";

export type { CalendarDay } from "./calendar-day";

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MINUTES_PER_DAY = 24 * 60;
const MAX_TIME_ZONE_LENGTH = 128;

export type CivilDate = string & { readonly __civilDate: unique symbol };

export type ZonedWallTime = Readonly<{
  date: CivilDate;
  minute: number;
  instantMs: number;
  offsetMinutes: number;
  fold: 0 | 1;
}>;

export type WallTimeResolution =
  | Readonly<{
      kind: "exact" | "gap-shifted" | "ambiguous";
      instantMs: number;
      offsetMinutes: number;
      requestedMinute: number;
      resolvedMinute: number;
      fold: 0 | 1;
    }>
  | Readonly<{
      kind: "rejected";
      reason: "gap" | "ambiguous";
      requestedMinute: number;
      candidates: readonly Readonly<{
        instantMs: number;
        offsetMinutes: number;
        fold: 0 | 1;
      }>[];
    }>;

export type SecondaryLabel = Readonly<{
  zone: string;
  instantMs: number;
  minute: number;
  offsetMinutes: number;
  fold: 0 | 1;
  label: string;
}>;

export interface ZonedCalendarClock {
  readonly primaryTimeZone: string;
  today(nowMs: number): CivilDate;
  day(date: CivilDate): CalendarDay;
  addDays(date: CivilDate, amount: number): CivilDate;
  instantToWallTime(instantMs: number): ZonedWallTime;
  wallTimeToInstant(
    date: CivilDate,
    minute: number,
    disambiguation: "compatible" | "earlier" | "later" | "reject",
  ): WallTimeResolution;
  secondaryLabelsForTick(
    date: CivilDate,
    minute: number,
    zones: readonly string[],
  ): readonly SecondaryLabel[];
}

export type TimeZoneNormalization =
  | Readonly<{ ok: true; timeZone: string }>
  | Readonly<{
      ok: false;
      error: Readonly<{
        code: "UNSUPPORTED_TIME_ZONE";
        timeZone: string;
      }>;
    }>;

export class UnsupportedTimeZoneError extends RangeError {
  readonly code = "UNSUPPORTED_TIME_ZONE" as const;
  readonly timeZone: string;

  constructor(timeZone: string) {
    super(`Unsupported IANA time zone: ${timeZone}`);
    this.name = "UnsupportedTimeZoneError";
    this.timeZone = timeZone;
  }
}

const timeZoneAliases: ReadonlyMap<string, string> = new Map([
  ["US/Eastern", "America/New_York"],
  ["US/Central", "America/Chicago"],
  ["US/Mountain", "America/Denver"],
  ["US/Pacific", "America/Los_Angeles"],
  ["GMT", "UTC"],
  ["Etc/GMT", "UTC"],
  ["Etc/UTC", "UTC"],
]);

const supportedTimeZones =
  typeof Intl.supportedValuesOf === "function"
    ? new Set(Intl.supportedValuesOf("timeZone"))
    : undefined;

/** Validate a zone and normalize known IANA links before it reaches rendering. */
export function normalizeTimeZone(timeZone: string): TimeZoneNormalization {
  const failure = (): TimeZoneNormalization => ({
    ok: false,
    error: { code: "UNSUPPORTED_TIME_ZONE", timeZone },
  });
  if (
    typeof timeZone !== "string" ||
    timeZone.length === 0 ||
    timeZone.length > MAX_TIME_ZONE_LENGTH
  ) {
    return failure();
  }

  try {
    const resolved = new Intl.DateTimeFormat("en-US", { timeZone })
      .resolvedOptions().timeZone;
    const canonical = timeZoneAliases.get(resolved) ?? resolved;
    if (supportedTimeZones && !supportedTimeZones.has(canonical)) {
      return failure();
    }
    // Construction remains the final runtime capability check, including on
    // engines where supportedValuesOf is unavailable.
    new Intl.DateTimeFormat("en-US", { timeZone: canonical });
    return { ok: true, timeZone: canonical };
  } catch {
    return failure();
  }
}

/** Strict CivilDate constructor. It rejects normalization such as 2026-02-29. */
export function parseCivilDate(value: string): CivilDate {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new RangeError(`Invalid civil date: ${value}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const instant = new Date(Date.UTC(year, month - 1, day));
  if (
    instant.getUTCFullYear() !== year ||
    instant.getUTCMonth() !== month - 1 ||
    instant.getUTCDate() !== day
  ) {
    throw new RangeError(`Invalid civil date: ${value}`);
  }
  return value as CivilDate;
}

type WallParts = Readonly<{
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}>;

type InstantCandidate = Readonly<{
  instantMs: number;
  offsetMinutes: number;
  fold: 0 | 1;
}>;

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    calendar: "gregory",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  formatterCache.set(timeZone, formatter);
  return formatter;
}

function wallPartsAt(timeZone: string, instantMs: number): WallParts {
  const values: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  for (const part of formatterFor(timeZone).formatToParts(instantMs)) {
    if (part.type !== "literal") values[part.type] = part.value;
  }
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
  };
}

function civilParts(date: CivilDate): Readonly<{
  year: number;
  month: number;
  day: number;
}> {
  return {
    year: Number(date.slice(0, 4)),
    month: Number(date.slice(5, 7)),
    day: Number(date.slice(8, 10)),
  };
}

function civilDateFromParts(
  parts: Pick<WallParts, "year" | "month" | "day">,
): CivilDate {
  return parseCivilDate(
    `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`,
  );
}

function localEpochMs(parts: WallParts): number {
  return Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
}

function offsetAt(timeZone: string, instantMs: number): number {
  const truncatedInstantMs = Math.floor(instantMs / 1_000) * 1_000;
  return Math.round(
    (localEpochMs(wallPartsAt(timeZone, truncatedInstantMs)) -
      truncatedInstantMs) /
      MS_PER_MINUTE,
  );
}

function targetLocalEpochMs(date: CivilDate, minute: number): number {
  const parts = civilParts(date);
  return Date.UTC(parts.year, parts.month - 1, parts.day) + minute * MS_PER_MINUTE;
}

function assertMinute(minute: number): void {
  if (!Number.isInteger(minute) || minute < 0 || minute >= MINUTES_PER_DAY) {
    throw new RangeError(
      "Wall-clock minute must be an integer from 0 through 1439",
    );
  }
}

function candidateOffsets(timeZone: string, targetMs: number): readonly number[] {
  const offsets = new Set<number>();
  // Sampling around the requested wall time discovers both sides of nearby
  // transitions without assuming that every shift is exactly one hour.
  for (
    let delta = -48 * MS_PER_HOUR;
    delta <= 48 * MS_PER_HOUR;
    delta += 6 * MS_PER_HOUR
  ) {
    offsets.add(offsetAt(timeZone, targetMs + delta));
  }
  return [...offsets];
}

function exactCandidates(
  timeZone: string,
  date: CivilDate,
  minute: number,
): readonly InstantCandidate[] {
  const targetMs = targetLocalEpochMs(date, minute);
  const candidates = candidateOffsets(timeZone, targetMs)
    .map((offsetMinutes) => ({
      instantMs: targetMs - offsetMinutes * MS_PER_MINUTE,
      offsetMinutes,
    }))
    .filter(({ instantMs }) => {
      const parts = wallPartsAt(timeZone, instantMs);
      return localEpochMs(parts) === targetMs;
    })
    .sort((left, right) => left.instantMs - right.instantMs);

  return candidates.map((candidate, index) => ({
    ...candidate,
    fold: index === 0 ? 0 : 1,
  }));
}

function foldAt(timeZone: string, instantMs: number, parts: WallParts): 0 | 1 {
  const date = civilDateFromParts(parts);
  const minute = parts.hour * 60 + parts.minute;
  const minuteInstantMs = Math.floor(instantMs / MS_PER_MINUTE) * MS_PER_MINUTE;
  const candidates = exactCandidates(timeZone, date, minute);
  return candidates.findIndex(
    (candidate) => candidate.instantMs === minuteInstantMs,
  ) === 1
    ? 1
    : 0;
}

function resolveWallTime(
  timeZone: string,
  date: CivilDate,
  minute: number,
  disambiguation: "compatible" | "earlier" | "later" | "reject",
): WallTimeResolution {
  assertMinute(minute);
  const candidates = exactCandidates(timeZone, date, minute);
  if (candidates.length > 0) {
    if (candidates.length > 1 && disambiguation === "reject") {
      return Object.freeze({
        kind: "rejected" as const,
        reason: "ambiguous" as const,
        requestedMinute: minute,
        candidates: Object.freeze(candidates),
      });
    }
    const selected =
      disambiguation === "later"
        ? candidates[candidates.length - 1]
        : candidates[0];
    return Object.freeze({
      kind: candidates.length > 1 ? "ambiguous" as const : "exact" as const,
      ...selected,
      requestedMinute: minute,
      resolvedMinute: minute,
    });
  }

  if (disambiguation === "reject") {
    return Object.freeze({
      kind: "rejected" as const,
      reason: "gap" as const,
      requestedMinute: minute,
      candidates: Object.freeze([]),
    });
  }

  const targetMs = targetLocalEpochMs(date, minute);
  const projections = candidateOffsets(timeZone, targetMs)
    .map((offsetMinutes) => targetMs - offsetMinutes * MS_PER_MINUTE)
    .map((instantMs) => ({
      instantMs,
      parts: wallPartsAt(timeZone, instantMs),
    }))
    .filter(
      (projection, index, all) =>
        all.findIndex((item) => item.instantMs === projection.instantMs) === index,
    );
  const earlier = projections
    .filter(({ parts }) => localEpochMs(parts) < targetMs)
    .sort(
      (left, right) => localEpochMs(right.parts) - localEpochMs(left.parts),
    )[0];
  const later = projections
    .filter(({ parts }) => localEpochMs(parts) > targetMs)
    .sort(
      (left, right) => localEpochMs(left.parts) - localEpochMs(right.parts),
    )[0];
  const selected = disambiguation === "earlier" ? earlier : later;
  if (!selected) {
    throw new RangeError(
      `Unable to resolve wall time ${date} ${minute} in ${timeZone}`,
    );
  }
  return Object.freeze({
    kind: "gap-shifted" as const,
    instantMs: selected.instantMs,
    offsetMinutes: offsetAt(timeZone, selected.instantMs),
    requestedMinute: minute,
    resolvedMinute: selected.parts.hour * 60 + selected.parts.minute,
    fold: foldAt(timeZone, selected.instantMs, selected.parts),
  });
}

function selectedInstant(resolution: WallTimeResolution): number {
  if (resolution.kind === "rejected") {
    throw new RangeError(`Rejected ${resolution.reason} wall time`);
  }
  return resolution.instantMs;
}

function offsetLabel(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? "-" : "+";
  const absolute = Math.abs(offsetMinutes);
  return `UTC${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(
    absolute % 60,
  ).padStart(2, "0")}`;
}

function clockFor(primaryTimeZone: string): ZonedCalendarClock {
  const instantToWallTime = (instantMs: number): ZonedWallTime => {
    if (!Number.isFinite(instantMs)) {
      throw new RangeError("Instant must be finite");
    }
    const parts = wallPartsAt(primaryTimeZone, instantMs);
    return Object.freeze({
      date: civilDateFromParts(parts),
      minute: parts.hour * 60 + parts.minute,
      instantMs,
      offsetMinutes: offsetAt(primaryTimeZone, instantMs),
      fold: foldAt(primaryTimeZone, instantMs, parts),
    });
  };

  const addDays = (date: CivilDate, amount: number): CivilDate => {
    if (!Number.isInteger(amount)) {
      throw new RangeError("Day amount must be an integer");
    }
    const parts = civilParts(date);
    const shifted = new Date(
      Date.UTC(parts.year, parts.month - 1, parts.day + amount),
    );
    return civilDateFromParts({
      year: shifted.getUTCFullYear(),
      month: shifted.getUTCMonth() + 1,
      day: shifted.getUTCDate(),
    });
  };

  const wallTimeToInstant = (
    date: CivilDate,
    minute: number,
    disambiguation: "compatible" | "earlier" | "later" | "reject",
  ): WallTimeResolution =>
    resolveWallTime(primaryTimeZone, date, minute, disambiguation);

  return Object.freeze({
    primaryTimeZone,
    today(nowMs: number): CivilDate {
      return instantToWallTime(nowMs).date;
    },
    day(date: CivilDate): CalendarDay {
      const nextDate = addDays(date, 1);
      return Object.freeze({
        key: date,
        startMs: selectedInstant(wallTimeToInstant(date, 0, "compatible")),
        endMs: selectedInstant(wallTimeToInstant(nextDate, 0, "compatible")),
      });
    },
    addDays,
    instantToWallTime,
    wallTimeToInstant,
    secondaryLabelsForTick(
      date: CivilDate,
      minute: number,
      zones: readonly string[],
    ): readonly SecondaryLabel[] {
      assertMinute(minute);
      const primaryCandidates = exactCandidates(primaryTimeZone, date, minute);
      const instants =
        primaryCandidates.length > 0
          ? primaryCandidates.map(({ instantMs }) => instantMs)
          : [selectedInstant(wallTimeToInstant(date, minute, "compatible"))];
      const normalizedZones = zones.map((zone) => {
        const normalized = normalizeTimeZone(zone);
        if (!normalized.ok) throw new UnsupportedTimeZoneError(zone);
        return normalized.timeZone;
      });
      const labels: SecondaryLabel[] = [];
      for (const zone of normalizedZones) {
        for (const instantMs of instants) {
          const parts = wallPartsAt(zone, instantMs);
          const offsetMinutes = offsetAt(zone, instantMs);
          const projectedMinute = parts.hour * 60 + parts.minute;
          labels.push(
            Object.freeze({
              zone,
              instantMs,
              minute: projectedMinute,
              offsetMinutes,
              fold: foldAt(zone, instantMs, parts),
              label: `${String(parts.hour).padStart(2, "0")}:${String(
                parts.minute,
              ).padStart(2, "0")} ${offsetLabel(offsetMinutes)}`,
            }),
          );
        }
      }
      return Object.freeze(labels);
    },
  });
}

export function createZonedCalendarClock(timeZone: string): ZonedCalendarClock {
  const normalized = normalizeTimeZone(timeZone);
  if (!normalized.ok) throw new UnsupportedTimeZoneError(timeZone);
  return clockFor(normalized.timeZone);
}
