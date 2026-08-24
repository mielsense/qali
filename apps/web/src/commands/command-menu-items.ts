import type { CommandId } from "@qali/desktop-contracts";

export type CommandMenuItem = Readonly<{
  id: string;
  label: string;
  detail: string;
  group: "Navigate" | "Calendar" | "Workspace";
  keywords: readonly string[];
  action:
    | Readonly<{ kind: "route"; to: "/" | "/insights" | "/settings" | "/settings/calendars-google" | "/settings/calendar" | "/settings/shortcuts" }>
    | Readonly<{ kind: "command"; command: CommandId }>;
}>;

export const COMMAND_MENU_ITEMS = [
  { id: "navigate.calendar", label: "Calendar", detail: "Open the calendar", group: "Navigate", keywords: ["schedule", "week", "day", "month"], action: { kind: "route", to: "/" } },
  { id: "navigate.insights", label: "Insights", detail: "Review calendar patterns", group: "Navigate", keywords: ["analytics", "stats", "charts", "time"], action: { kind: "route", to: "/insights" } },
  { id: "navigate.settings", label: "Settings", detail: "Customize Qali", group: "Navigate", keywords: ["preferences", "configuration"], action: { kind: "route", to: "/settings" } },
  { id: "navigate.google", label: "Calendars & Google", detail: "Accounts, visibility, and colors", group: "Navigate", keywords: ["sync", "account", "google", "color"], action: { kind: "route", to: "/settings/calendars-google" } },
  { id: "navigate.preferences", label: "Calendar preferences", detail: "Time zones, hours, and appearance", group: "Navigate", keywords: ["timezone", "theme", "sound", "default calendar"], action: { kind: "route", to: "/settings/calendar" } },
  { id: "navigate.shortcuts", label: "Keyboard shortcuts", detail: "Review or record keybindings", group: "Navigate", keywords: ["keys", "commands", "hotkeys"], action: { kind: "route", to: "/settings/shortcuts" } },
  { id: "calendar.event.create", label: "New event", detail: "Create a calendar event", group: "Calendar", keywords: ["add", "meeting", "appointment"], action: { kind: "command", command: "calendar.event.create" } },
  { id: "calendar.today", label: "Go to today", detail: "Center the current day", group: "Calendar", keywords: ["now", "current date"], action: { kind: "command", command: "calendar.today" } },
  { id: "calendar.view.day", label: "Day view", detail: "Show one day", group: "Calendar", keywords: ["single day"], action: { kind: "command", command: "calendar.view.day" } },
  { id: "calendar.view.week", label: "Week view", detail: "Show the week", group: "Calendar", keywords: ["seven days"], action: { kind: "command", command: "calendar.view.week" } },
  { id: "calendar.view.month", label: "Month view", detail: "Show the month", group: "Calendar", keywords: ["overview"], action: { kind: "command", command: "calendar.view.month" } },
  { id: "assistant.toggle", label: "Toggle assistant", detail: "Open or close the calendar assistant", group: "Workspace", keywords: ["ai", "codex", "chat"], action: { kind: "command", command: "assistant.toggle" } },
] as const satisfies readonly CommandMenuItem[];
