import {
  defaultCommandKeybindings,
  type CommandId,
  type Keybinding,
} from "@qali/desktop-contracts";

export interface CommandDefinition {
  id: CommandId;
  context: "global" | "calendar";
  defaultBinding: Keybinding | null;
  label: string;
}

export interface CommandDispatcher {
  dispatch(command: CommandId): boolean;
}

export type CommandHandler = () => boolean | void;
export type CommandHandlers = Readonly<Partial<Record<CommandId, CommandHandler>>>;
export type KeybindingOverrides = Readonly<
  Partial<Record<CommandId, Keybinding | null>>
>;

function defaultBinding(command: CommandId): Keybinding | null {
  return defaultCommandKeybindings[
    command as keyof typeof defaultCommandKeybindings
  ] ?? null;
}

function command(
  id: CommandId,
  context: CommandDefinition["context"],
  label: string,
): CommandDefinition {
  return { id, context, label, defaultBinding: defaultBinding(id) };
}

export const COMMANDS = [
  command("calendar.view.day", "calendar", "Day view"),
  command("calendar.view.week", "calendar", "Week view"),
  command("calendar.view.month", "calendar", "Month view"),
  command("calendar.today", "calendar", "Go to today"),
  command("calendar.navigate.previous", "calendar", "Previous period"),
  command("calendar.navigate.next", "calendar", "Next period"),
  command("calendar.event.create", "calendar", "New event"),
  command("command-palette.open", "global", "Open command menu"),
  command("assistant.toggle", "global", "Toggle assistant"),
  command("settings.open", "global", "Open settings"),
  command("workspace.section.1", "global", "Open section 1"),
  command("workspace.section.2", "global", "Open section 2"),
  command("workspace.section.3", "global", "Open section 3"),
  command("workspace.section.4", "global", "Open section 4"),
  command("workspace.section.5", "global", "Open section 5"),
  command("workspace.section.6", "global", "Open section 6"),
  command("workspace.section.7", "global", "Open section 7"),
  command("workspace.section.8", "global", "Open section 8"),
  command("workspace.section.9", "global", "Open section 9"),
] as const satisfies readonly CommandDefinition[];

export const COMMAND_BY_ID = Object.fromEntries(
  COMMANDS.map((definition) => [definition.id, definition]),
) as Readonly<Record<CommandId, CommandDefinition>>;

export function effectiveKeybinding(
  commandId: CommandId,
  overrides: KeybindingOverrides,
): Keybinding | null {
  if (Object.prototype.hasOwnProperty.call(overrides, commandId)) {
    return overrides[commandId] ?? null;
  }
  return COMMAND_BY_ID[commandId].defaultBinding;
}

export function createCommandDispatcher(
  handlers: CommandHandlers,
): CommandDispatcher {
  return {
    dispatch(commandId) {
      const handler = handlers[commandId];
      if (!handler) return false;
      return handler() !== false;
    },
  };
}
