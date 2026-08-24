import { readFileSync } from "node:fs";

const MAX_TIME_ZONE_LENGTH = 128;

const fallbackAliases = new Map([
  ["US/Eastern", "America/New_York"],
  ["US/Central", "America/Chicago"],
  ["US/Mountain", "America/Denver"],
  ["US/Pacific", "America/Los_Angeles"],
]);

function loadTimeZoneAliases(): ReadonlyMap<string, string> {
  const aliases = new Map(fallbackAliases);
  try {
    const database = readFileSync("/usr/share/zoneinfo/tzdata.zi", "utf8");
    for (const line of database.split("\n")) {
      const match = /^(?:L|Link)\s+(\S+)\s+(\S+)$/.exec(line.trim());
      if (match) aliases.set(match[2]!, match[1]!);
    }
  } catch {
    // The Intl validation below remains authoritative on platforms without tzdata.zi.
  }
  return aliases;
}

const timeZoneAliases = loadTimeZoneAliases();
const supportedTimeZones =
  typeof Intl.supportedValuesOf === "function"
    ? new Set(Intl.supportedValuesOf("timeZone"))
    : undefined;

export function canonicalizeTimeZone(timeZone: string): string {
  if (
    typeof timeZone !== "string" ||
    timeZone.length === 0 ||
    timeZone.length > MAX_TIME_ZONE_LENGTH
  ) {
    throw new Error("Time zone must be a supported canonical IANA identifier");
  }

  try {
    const supported = new Intl.DateTimeFormat("en-US", {
      timeZone,
    }).resolvedOptions().timeZone;
    let canonical = timeZoneAliases.get(supported) ?? supported;
    const visited = new Set<string>();
    while (timeZoneAliases.has(canonical) && !visited.has(canonical)) {
      visited.add(canonical);
      canonical = timeZoneAliases.get(canonical)!;
    }
    return supportedTimeZones && !supportedTimeZones.has(canonical)
      ? supported
      : canonical;
  } catch {
    throw new Error("Time zone must be a supported canonical IANA identifier");
  }
}

export function canonicalizeTimeZones(timeZones: readonly string[]): string[] {
  return timeZones.map(canonicalizeTimeZone);
}
