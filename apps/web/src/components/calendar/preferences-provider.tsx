import { createContext, type ReactNode, useContext, useMemo } from "react";

import { useQaliSettings } from "@/components/settings/settings-provider";

import type { CalendarPreferences } from "./preferences";

type CalendarPreferencesContextValue = Readonly<{
  preferences: CalendarPreferences;
  updatePreferences: (patch: Partial<CalendarPreferences>) => void;
  resetPreferences: () => void;
}>;

const CalendarPreferencesContext =
  createContext<CalendarPreferencesContextValue | null>(null);

export function CalendarPreferencesProvider({
  children,
}: {
  children: ReactNode;
}) {
  const { snapshot, patch: patchSettings } = useQaliSettings();
  const preferences = snapshot.settings
    .calendar as unknown as CalendarPreferences;
  const value = useMemo<CalendarPreferencesContextValue>(
    () => ({
      preferences,
      updatePreferences(preferencesPatch) {
        const { hourHeight, ...calendar } = preferencesPatch;
        void patchSettings({
          calendar: {
            ...calendar,
            ...(hourHeight === undefined
              ? {}
              : {
                  hourHeight:
                    hourHeight === 64 ? 72 : hourHeight === 80 ? 96 : 96,
                }),
          },
        }).catch(() => {});
      },
      resetPreferences() {
        void patchSettings({
          calendar: {
            dayStartHour: 0,
            dayEndHour: 24,
            hourHeight: 120,
            defaultView: "week",
          },
        }).catch(() => {});
      },
    }),
    [preferences, patchSettings],
  );
  return (
    <CalendarPreferencesContext.Provider value={value}>
      {children}
    </CalendarPreferencesContext.Provider>
  );
}

export function useCalendarPreferences(): CalendarPreferencesContextValue {
  const context = useContext(CalendarPreferencesContext);
  if (!context) {
    throw new Error("Calendar preferences require CalendarPreferencesProvider");
  }
  return context;
}
