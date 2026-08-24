export type SettingsPath =
  | "/settings/calendar"
  | "/settings/calendars-google"
  | "/settings/shortcuts"
  | "/settings/assistant"
  | "/settings/data-recovery";

export type SettingsNavigationItem = Readonly<{
  label: string;
  keywords: readonly string[];
  to: SettingsPath;
}>;

export type SettingsSearchItem = Readonly<{
  label: string;
  description: string;
  keywords: readonly string[];
  to: SettingsPath;
  anchor: string;
}>;

export const SETTINGS_NAVIGATION = [
  {
    label: "Preferences",
    keywords: [
      "view",
      "hours",
      "timeline",
      "timezone",
      "time zone",
      "primary",
      "secondary",
      "theme",
      "appearance",
      "sound",
      "transparency",
    ],
    to: "/settings/calendar",
  },
  {
    label: "Calendars & Google",
    keywords: ["calendar", "sync", "account"],
    to: "/settings/calendars-google",
  },
  {
    label: "Shortcuts",
    keywords: ["keybindings", "keyboard", "commands"],
    to: "/settings/shortcuts",
  },
  {
    label: "Assistant",
    keywords: ["codex", "provider", "authentication"],
    to: "/settings/assistant",
  },
  {
    label: "System & recovery",
    keywords: ["backup", "restore", "export", "update", "version", "system"],
    to: "/settings/data-recovery",
  },
] as const satisfies readonly SettingsNavigationItem[];

export const SETTINGS_SEARCH_INDEX = [
  {
    label: "Visible hours",
    description: "First and final hour shown in day and week views",
    keywords: ["working hours", "start", "end", "timeline"],
    to: "/settings/calendar",
    anchor: "settings-row-visible-hours",
  },
  {
    label: "Timeline density",
    description: "Compact, comfortable, or spacious calendar rows",
    keywords: ["height", "zoom", "event space"],
    to: "/settings/calendar",
    anchor: "settings-row-timeline-density",
  },
  {
    label: "Default view",
    description: "Choose day, week, or month when Qali opens",
    keywords: ["startup", "open"],
    to: "/settings/calendar",
    anchor: "settings-row-default-view",
  },
  {
    label: "New events",
    description: "Choose the calendar preselected when creating an event",
    keywords: ["default calendar", "create", "primary"],
    to: "/settings/calendar",
    anchor: "settings-row-new-events",
  },
  {
    label: "Primary time zone",
    description: "Defines today, grid boundaries, and new-event defaults",
    keywords: ["timezone", "planning zone"],
    to: "/settings/calendar",
    anchor: "settings-row-primary-time-zone",
  },
  {
    label: "Reference time zones",
    description: "Show up to two secondary clocks",
    keywords: ["timezone", "secondary", "Tokyo", "Paris"],
    to: "/settings/calendar",
    anchor: "settings-row-reference-time-zones",
  },
  {
    label: "Theme",
    description: "Use device, light, or dark appearance",
    keywords: ["appearance", "color scheme"],
    to: "/settings/calendar",
    anchor: "settings-row-theme",
  },
  {
    label: "Reduce transparency",
    description: "Use opaque floating surfaces",
    keywords: ["glass", "accessibility", "appearance"],
    to: "/settings/calendar",
    anchor: "settings-row-reduce-transparency",
  },
  {
    label: "Interface sounds",
    description: "Enable subtle click feedback",
    keywords: ["audio", "mute", "sound effects"],
    to: "/settings/calendar",
    anchor: "settings-row-interface-sounds",
  },
  {
    label: "Google accounts",
    description: "Add, reconnect, disconnect, or sync accounts",
    keywords: ["oauth", "multiple accounts", "calendar"],
    to: "/settings/calendars-google",
    anchor: "settings-row-google-accounts",
  },
  {
    label: "Calendar visibility and colors",
    description: "Choose visible calendars and their event colors",
    keywords: ["checkbox", "palette", "Google"],
    to: "/settings/calendars-google",
    anchor: "google-calendar-accounts",
  },
  {
    label: "Keyboard shortcuts",
    description: "Record or disable commands and section shortcuts",
    keywords: ["keybindings", "hotkeys", "cmd", "command menu"],
    to: "/settings/shortcuts",
    anchor: "keybindings-heading",
  },
  {
    label: "Provider status",
    description: "Check the installed Codex runtime and authentication",
    keywords: ["assistant", "AI", "login", "model"],
    to: "/settings/assistant",
    anchor: "settings-row-provider-status",
  },
  {
    label: "Software updates",
    description:
      "Check the installed Qali version and restart into a downloaded update",
    keywords: ["version", "release", "upgrade", "system"],
    to: "/settings/data-recovery",
    anchor: "settings-row-software-updates",
  },
  {
    label: "Export local data",
    description: "Create a portable calendar data export",
    keywords: ["backup", "download", "recovery"],
    to: "/settings/data-recovery",
    anchor: "settings-row-export-local-data",
  },
  {
    label: "Restore a backup",
    description: "Replace local calendar data from a verified backup",
    keywords: ["recovery", "import"],
    to: "/settings/data-recovery",
    anchor: "settings-row-restore-a-backup",
  },
  {
    label: "Reset local data",
    description: "Quarantine and clear the local Qali database",
    keywords: ["database", "clean", "recovery"],
    to: "/settings/data-recovery",
    anchor: "settings-row-reset-local-data",
  },
] as const satisfies readonly SettingsSearchItem[];

export function findSettingsNavigation(
  query: string,
): readonly SettingsNavigationItem[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return SETTINGS_NAVIGATION;
  return SETTINGS_NAVIGATION.filter((item) =>
    [item.label, ...item.keywords].some((value) =>
      value.toLocaleLowerCase().includes(normalized),
    ),
  );
}

export function findSettingsSearchResults(
  query: string,
): readonly SettingsSearchItem[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  return SETTINGS_SEARCH_INDEX.filter((item) => {
    const haystack = [item.label, item.description, ...item.keywords]
      .join(" ")
      .toLocaleLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

export function moveSettingsNavigation(
  index: number,
  key: string,
  itemCount: number,
): number {
  if (itemCount <= 0) return -1;
  if (key === "Home") return 0;
  if (key === "End") return itemCount - 1;
  if (key === "ArrowUp") return (index - 1 + itemCount) % itemCount;
  if (key === "ArrowDown") return (index + 1) % itemCount;
  return index;
}
