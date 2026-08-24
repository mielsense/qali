import {
  qaliSettingsDocumentSchema,
  type QaliSettingsDocument,
  type SettingsPatchRequest,
} from "@qali/desktop-contracts/schemas";

import { canonicalizeTimeZone, canonicalizeTimeZones } from "./time-zones";

type SettingsChanges = SettingsPatchRequest["changes"];

function freezeSettings(settings: QaliSettingsDocument): QaliSettingsDocument {
  Object.freeze(settings.calendar.secondaryTimeZones);
  Object.freeze(settings.calendar);
  for (const binding of Object.values(settings.keybindings.overrides)) {
    if (binding) {
      Object.freeze(binding.modifiers);
      Object.freeze(binding);
    }
  }
  Object.freeze(settings.keybindings.overrides);
  Object.freeze(settings.keybindings);
  Object.freeze(settings.appearance);
  return Object.freeze(settings);
}

function canonicalizeDocumentTimeZones(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const document = value as Record<string, unknown>;
  const calendarValue = document.calendar;
  if (
    !calendarValue ||
    typeof calendarValue !== "object" ||
    Array.isArray(calendarValue)
  )
    return value;
  const calendar = calendarValue as Record<string, unknown>;

  return {
    ...document,
    calendar: {
      ...calendar,
      primaryTimeZone:
        typeof calendar.primaryTimeZone === "string"
          ? canonicalizeTimeZone(calendar.primaryTimeZone)
          : calendar.primaryTimeZone,
      secondaryTimeZones:
        Array.isArray(calendar.secondaryTimeZones) &&
        calendar.secondaryTimeZones.every((zone) => typeof zone === "string")
          ? canonicalizeTimeZones(calendar.secondaryTimeZones as string[])
          : calendar.secondaryTimeZones,
    },
  };
}

export function parseSettingsDocument(value: unknown): QaliSettingsDocument {
  const parsed = qaliSettingsDocumentSchema.parse(
    canonicalizeDocumentTimeZones(value),
  );
  return freezeSettings(parsed as QaliSettingsDocument);
}

export function createDefaultSettings(
  systemTimeZone: string,
): QaliSettingsDocument {
  return parseSettingsDocument({
    schemaVersion: 2,
    revision: 0,
    calendar: {
      dayStartHour: 0,
      dayEndHour: 24,
      hourHeight: 120,
      defaultView: "week",
      primaryTimeZone: canonicalizeTimeZone(systemTimeZone),
      secondaryTimeZones: [],
      defaultCalendarId: null,
    },
    appearance: {
      theme: "system",
      glassOpacity: 0.78,
      transparency: "follow-system",
      interfaceSounds: true,
    },
    keybindings: { overrides: {} },
  });
}

export function mergeSettingsChanges(
  current: QaliSettingsDocument,
  changes: SettingsChanges,
): QaliSettingsDocument {
  const calendarChanges = changes.calendar;
  const nextCalendar = calendarChanges
    ? {
        ...current.calendar,
        ...calendarChanges,
        ...(calendarChanges.primaryTimeZone === undefined
          ? {}
          : {
              primaryTimeZone: canonicalizeTimeZone(
                calendarChanges.primaryTimeZone,
              ),
            }),
        ...(calendarChanges.secondaryTimeZones === undefined
          ? {}
          : {
              secondaryTimeZones: canonicalizeTimeZones(
                calendarChanges.secondaryTimeZones,
              ),
            }),
      }
    : current.calendar;

  return parseSettingsDocument({
    ...current,
    calendar: nextCalendar,
    appearance: changes.appearance
      ? { ...current.appearance, ...changes.appearance }
      : current.appearance,
    keybindings: changes.keybindings
      ? {
          overrides: {
            ...current.keybindings.overrides,
            ...changes.keybindings.overrides,
          },
        }
      : current.keybindings,
  });
}

export function withSettingsRevision(
  settings: QaliSettingsDocument,
  revision: number,
): QaliSettingsDocument {
  return parseSettingsDocument({ ...settings, revision });
}
