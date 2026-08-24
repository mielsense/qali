import { createFileRoute } from "@tanstack/react-router";
import { api } from "@qali/backend/convex/_generated/api";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@qali/ui/components/combobox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectList,
  SelectTrigger,
  SelectValue,
} from "@qali/ui/components/select";
import { SegmentedControl } from "@qali/ui/components/segmented-control";
import { Switch } from "@qali/ui/components/switch";
import { useQuery } from "convex/react";

import { SettingsGroup } from "@/components/settings/settings-group";
import { SettingsSection } from "@/components/settings/settings-section";
import { SettingsRow } from "@/components/settings/settings-row";
import { useQaliSettings } from "@/components/settings/settings-provider";
import {
  resolveTimeZoneSelection,
  searchTimeZones,
  timeZoneLabel,
  updateReferenceTimeZones,
} from "@/components/settings/time-zone-options";
import { useTheme } from "@/components/theme-provider";
import { isWritableCalendar } from "@/components/calendar/create-calendar-selection";
import { calendarDisplayName } from "@/components/calendar/lib";

const hourHeights = [72, 96, 120] as const;
const views = ["day", "week", "month"] as const;
const FALLBACK_TIME_ZONES = [
  "America/Los_Angeles",
  "America/New_York",
  "Europe/London",
  "Europe/Paris",
  "Asia/Tokyo",
  "Australia/Sydney",
  "UTC",
];

function availableTimeZones(): readonly string[] {
  const supported = Intl.supportedValuesOf?.("timeZone");
  return supported?.length ? supported : FALLBACK_TIME_ZONES;
}

export const Route = createFileRoute("/_workspace/settings/calendar")({
  component: CalendarSettingsPage,
});

function CalendarSettingsPage() {
  const { patch, snapshot } = useQaliSettings();
  const { setTheme } = useTheme();
  const calendar = snapshot.settings.calendar;
  const calendars = useQuery(api.calendar.listCalendars) ?? [];
  const writableCalendars = calendars.filter(isWritableCalendar);
  const appearance = snapshot.settings.appearance;
  const { primaryTimeZone, secondaryTimeZones } = calendar;
  const zones = availableTimeZones();
  const selectableZones = zones.includes(primaryTimeZone)
    ? zones
    : [primaryTimeZone, ...zones];

  const updatePrimaryTimeZone = (next: string) =>
    void patch({
      calendar: {
        primaryTimeZone: next,
        secondaryTimeZones: secondaryTimeZones.filter((zone) => zone !== next),
      },
    });
  const updateSecondaryTimeZone = (index: number, next: string) => {
    void patch({
      calendar: {
        secondaryTimeZones: updateReferenceTimeZones(
          secondaryTimeZones,
          index,
          next,
          primaryTimeZone,
        ),
      },
    });
  };
  const setAppearanceTheme = (theme: "system" | "light" | "dark") => {
    setTheme(theme);
    void patch({ appearance: { theme } });
  };

  return (
    <SettingsSection
      title="Preferences"
      description="Tune Qali’s calendar, reference clocks, and interface feedback in one place."
    >
      <SettingsGroup
        title="Calendar layout"
        description="Choose the starting view and the amount of timeline detail you want to see."
      >
        <SettingsRow
          label="Visible hours"
          description="The first and final hour shown in day and week views."
        >
          <div className="flex items-center gap-2">
            <HourSelect
              ariaLabel="First visible hour"
              value={calendar.dayStartHour}
              values={Array.from(
                { length: calendar.dayEndHour },
                (_, hour) => hour,
              )}
              onChange={(dayStartHour) =>
                void patch({ calendar: { dayStartHour } })
              }
            />
            <span className="text-xs text-muted-foreground">to</span>
            <HourSelect
              ariaLabel="Last visible hour"
              value={calendar.dayEndHour}
              values={Array.from(
                { length: 24 - calendar.dayStartHour },
                (_, offset) => calendar.dayStartHour + offset + 1,
              )}
              onChange={(dayEndHour) =>
                void patch({ calendar: { dayEndHour } })
              }
              end
            />
          </div>
        </SettingsRow>
        <SettingsRow
          label="Timeline density"
          description="Spacious gives short events more room to read and place."
        >
          <SegmentedControl
            ariaLabel="Timeline density"
            options={hourHeights.map((value) => ({
              value,
              label:
                value === 72
                  ? "Compact"
                  : value === 96
                    ? "Comfortable"
                    : "Spacious",
            }))}
            value={calendar.hourHeight}
            onValueChange={(hourHeight) =>
              void patch({ calendar: { hourHeight } })
            }
          />
        </SettingsRow>
        <SettingsRow
          label="Default view"
          description="The view shown whenever Qali opens."
        >
          <SegmentedControl
            ariaLabel="Default calendar view"
            options={views.map((value) => ({
              value,
              label: value[0]!.toUpperCase() + value.slice(1),
            }))}
            value={calendar.defaultView}
            onValueChange={(defaultView) =>
              void patch({ calendar: { defaultView } })
            }
          />
        </SettingsRow>
        <SettingsRow
          label="New events"
          description="Choose the calendar preselected whenever you create an event."
        >
          <Select
            items={[
              { value: "__primary__", label: "Primary calendar" },
              ...writableCalendars.map((candidate) => ({
                value: candidate.googleCalendarId,
                label: calendarDisplayName(candidate),
              })),
            ]}
            value={calendar.defaultCalendarId ?? "__primary__"}
            onValueChange={(next) => {
              if (next !== null) {
                void patch({
                  calendar: {
                    defaultCalendarId:
                      next === "__primary__" ? null : next,
                  },
                });
              }
            }}
          >
            <SelectTrigger aria-label="Default calendar for new events">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectList>
                <SelectItem value="__primary__">Primary calendar</SelectItem>
                {writableCalendars.map((candidate) => (
                  <SelectItem
                    key={candidate._id}
                    value={candidate.googleCalendarId}
                  >
                    {calendarDisplayName(candidate)}
                  </SelectItem>
                ))}
              </SelectList>
            </SelectContent>
          </Select>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup
        title="Time zones"
        description="Set the planning zone and up to two compact reference clocks."
      >
        <SettingsRow
          label="Primary time zone"
          description="Defines today, grid boundaries, and defaults for new events."
        >
          <TimeZoneCombobox
            ariaLabel="Primary time zone"
            value={primaryTimeZone}
            zones={selectableZones}
            onChange={updatePrimaryTimeZone}
          />
        </SettingsRow>
        <SettingsRow
          label="Reference time zones"
          description="Optional labels only; they never change event times."
        >
          <div className="flex flex-col gap-2">
            {[0, 1].map((index) => (
              <TimeZoneCombobox
                key={index}
                ariaLabel={`Reference time zone ${index + 1}`}
                value={secondaryTimeZones[index] ?? ""}
                zones={selectableZones.filter(
                  (zone) =>
                    zone !== primaryTimeZone &&
                    !secondaryTimeZones.some(
                      (selected, selectedIndex) =>
                        selectedIndex !== index && selected === zone,
                    ),
                )}
                onChange={(value) => updateSecondaryTimeZone(index, value)}
                optional
              />
            ))}
          </div>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup
        title="Interface"
        description="Keep the visual treatment quiet and the feedback intentional."
      >
        <SettingsRow
          label="Theme"
          description="Updates every Qali window immediately."
        >
          <SegmentedControl
            ariaLabel="Theme"
            options={(["system", "light", "dark"] as const).map((value) => ({
              value,
              label:
                value === "system"
                  ? "Device"
                  : value[0]!.toUpperCase() + value.slice(1),
            }))}
            value={appearance.theme}
            onValueChange={setAppearanceTheme}
          />
        </SettingsRow>
        <SettingsRow
          label="Reduce transparency"
          description="Uses opaque floating surfaces when transparency is distracting."
        >
          <Switch
            aria-label="Reduce transparency"
            checked={appearance.transparency === "always-reduce"}
            onCheckedChange={(checked) =>
              void patch({
                appearance: {
                  transparency: checked ? "always-reduce" : "follow-system",
                },
              })
            }
          />
        </SettingsRow>
        <SettingsRow
          label="Interface sounds"
          description="Play subtle feedback for clicks and picker selections."
        >
          <Switch
            aria-label="Interface sounds"
            checked={appearance.interfaceSounds}
            onCheckedChange={(interfaceSounds) =>
              void patch({ appearance: { interfaceSounds } })
            }
          />
        </SettingsRow>
      </SettingsGroup>
    </SettingsSection>
  );
}

function HourSelect({
  ariaLabel,
  end,
  onChange,
  value,
  values,
}: {
  ariaLabel: string;
  end?: boolean;
  onChange(value: number): void;
  value: number;
  values: readonly number[];
}) {
  const items = values.map((hour) => ({
    value: hour,
    label:
      hour === 24 && end
        ? "12 AM next day"
        : new Intl.DateTimeFormat("en-US", { hour: "numeric" }).format(
            new Date(2026, 0, 1, hour % 24),
          ),
  }));
  return (
    <Select
      items={items}
      value={value}
      onValueChange={(next) => {
        if (next !== null) onChange(next);
      }}
    >
      <SelectTrigger aria-label={ariaLabel}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectList>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectList>
      </SelectContent>
    </Select>
  );
}

function TimeZoneCombobox({
  ariaLabel,
  onChange,
  optional,
  value,
  zones,
}: {
  ariaLabel: string;
  onChange(value: string): void;
  optional?: boolean;
  value: string;
  zones: readonly string[];
}) {
  return (
    <Combobox
      items={zones}
      value={value}
      onValueChange={(next) => {
        const resolved = resolveTimeZoneSelection(next, Boolean(optional));
        if (resolved !== undefined) onChange(resolved);
      }}
      itemToStringLabel={timeZoneLabel}
      filter={(zone, query) => searchTimeZones([zone], query).length === 1}
      autoHighlight
    >
      <ComboboxInput
        aria-label={ariaLabel}
        placeholder={optional ? "None" : "Search time zones"}
        showClear={optional && Boolean(value)}
      />
      <ComboboxContent>
        <ComboboxEmpty>No time zones found.</ComboboxEmpty>
        <ComboboxList>
          {(zone: string) => (
            <ComboboxItem key={zone} value={zone}>
              {timeZoneLabel(zone)}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
