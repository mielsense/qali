import type {
  LegacySettingsImportRequest,
  QaliSettingsDocument,
  SettingsSnapshot,
  SettingsWriteResult,
} from "@qali/desktop-contracts";

export const LEGACY_CALENDAR_PREFERENCES_KEY = "qali.calendar.preferences.v1";
export const LEGACY_THEME_KEY = "vite-ui-theme";

export type LegacySettingsStorageKey =
  typeof LEGACY_CALENDAR_PREFERENCES_KEY | typeof LEGACY_THEME_KEY;

export type LegacySettingsMigration = Readonly<{
  request: LegacySettingsImportRequest;
  submittedKeys: readonly LegacySettingsStorageKey[];
}>;

type TransparencyPreference =
  QaliSettingsDocument["appearance"]["transparency"];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseLegacyCalendar(serialized: string | null) {
  if (serialized === null) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    return undefined;
  }
  if (!isPlainObject(value)) return undefined;
  if (
    Object.keys(value).sort().join(",") !==
    "dayEndHour,dayStartHour,defaultView,hourHeight"
  ) {
    return undefined;
  }
  const { dayStartHour, dayEndHour, defaultView, hourHeight } = value;
  if (
    typeof dayStartHour !== "number" ||
    !Number.isInteger(dayStartHour) ||
    dayStartHour < 0 ||
    dayStartHour > 23 ||
    typeof dayEndHour !== "number" ||
    !Number.isInteger(dayEndHour) ||
    dayEndHour <= dayStartHour ||
    dayEndHour > 24 ||
    typeof hourHeight !== "number" ||
    ![64, 80, 96].includes(hourHeight) ||
    (defaultView !== "day" && defaultView !== "week" && defaultView !== "month")
  ) {
    return undefined;
  }
  return { dayStartHour, dayEndHour, hourHeight, defaultView } as const;
}

function parseLegacyTheme(
  value: string | null,
): QaliSettingsDocument["appearance"]["theme"] | undefined {
  return value === "system" || value === "light" || value === "dark"
    ? value
    : undefined;
}

export function buildLegacySettingsMigration(
  read: (key: LegacySettingsStorageKey) => string | null,
): LegacySettingsMigration | null {
  const calendarPreferencesV1 = parseLegacyCalendar(
    read(LEGACY_CALENDAR_PREFERENCES_KEY),
  );
  const theme = parseLegacyTheme(read(LEGACY_THEME_KEY));
  if (!calendarPreferencesV1 && !theme) return null;

  const submittedKeys: LegacySettingsStorageKey[] = [];
  if (calendarPreferencesV1)
    submittedKeys.push(LEGACY_CALENDAR_PREFERENCES_KEY);
  if (theme) submittedKeys.push(LEGACY_THEME_KEY);
  const calendarIdentity = calendarPreferencesV1
    ? `${calendarPreferencesV1.dayStartHour}:${calendarPreferencesV1.dayEndHour}:${calendarPreferencesV1.hourHeight}:${calendarPreferencesV1.defaultView}`
    : "none";
  return Object.freeze({
    request: Object.freeze({
      operationId: `legacy-settings-v1:${calendarIdentity}:${theme ?? "none"}`,
      ...(calendarPreferencesV1 ? { calendarPreferencesV1 } : {}),
      ...(theme ? { theme } : {}),
    }),
    submittedKeys: Object.freeze(submittedKeys),
  });
}

export function legacyRemovalKeys(
  receipt: Readonly<{
    migration: LegacySettingsMigration;
    result: SettingsWriteResult;
  }>,
): readonly LegacySettingsStorageKey[] {
  return receipt.result.kind === "committed" ||
    receipt.result.kind === "replayed"
    ? receipt.migration.submittedKeys
    : [];
}

export function reconcileSettingsSnapshot(
  current: SettingsSnapshot,
  incoming: SettingsSnapshot,
): SettingsSnapshot {
  return incoming.settings.revision > current.settings.revision
    ? incoming
    : current;
}

export function deriveReduceTransparency(
  systemReduced: boolean,
  preference: TransparencyPreference,
): boolean {
  return systemReduced || preference === "always-reduce";
}

export function createRendererDefaultSettings(
  primaryTimeZone: string,
): SettingsSnapshot {
  return Object.freeze({
    settings: Object.freeze({
      schemaVersion: 2 as const,
      revision: 0,
      calendar: Object.freeze({
        dayStartHour: 0,
        dayEndHour: 24,
        hourHeight: 120 as const,
        defaultView: "week" as const,
        primaryTimeZone,
        secondaryTimeZones: Object.freeze([]),
        defaultCalendarId: null,
      }),
      appearance: Object.freeze({
        theme: "system" as const,
        glassOpacity: 0.78,
        transparency: "follow-system" as const,
        interfaceSounds: true,
      }),
      keybindings: Object.freeze({ overrides: Object.freeze({}) }),
    }),
  });
}
