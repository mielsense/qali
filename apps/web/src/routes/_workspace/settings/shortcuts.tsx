import type { CommandId, Keybinding } from "@qali/desktop-contracts";
import { Alert02Icon, Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@qali/ui/components/button";
import { Input } from "@qali/ui/components/input";
import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState, type KeyboardEvent } from "react";

import {
  findKeybindingConflicts,
  keybindingSearchQueryFromEvent,
  keybindingsEqual,
  matchesKeybindingSearch,
} from "@/commands/keybinding";
import { COMMANDS, effectiveKeybinding } from "@/commands/registry";
import { SettingsSection } from "@/components/settings/settings-section";
import { ShortcutRecorder } from "@/components/settings/shortcut-recorder";
import { useQaliSettings } from "@/components/settings/settings-provider";

export const Route = createFileRoute("/_workspace/settings/shortcuts")({
  component: ShortcutsSettingsPage,
});

const GROUPS = [
  {
    id: "workspace",
    label: "Workspace navigation",
    matches: (commandId: CommandId) =>
      commandId.startsWith("workspace.section."),
  },
  {
    id: "calendar",
    label: "Calendar",
    matches: (commandId: CommandId) => commandId.startsWith("calendar."),
  },
  {
    id: "general",
    label: "General",
    matches: (commandId: CommandId) =>
      !commandId.startsWith("workspace.section.") &&
      !commandId.startsWith("calendar."),
  },
] as const;

function ShortcutsSettingsPage() {
  const { patch, reset, snapshot } = useQaliSettings();
  const [query, setQuery] = useState("");
  const [recordingConflict, setRecordingConflict] = useState<{
    command: CommandId;
    conflicts: readonly CommandId[];
  } | null>(null);
  const overrides = snapshot.settings.keybindings.overrides;
  const commandGroups = useMemo(
    () =>
      GROUPS.map((group) => ({
        ...group,
        commands: COMMANDS.filter((command) => {
          const binding = effectiveKeybinding(command.id, overrides);
          return (
            group.matches(command.id) &&
            matchesKeybindingSearch(command, binding, query)
          );
        }),
      })).filter((group) => group.commands.length > 0),
    [overrides, query],
  );
  const resultCount = commandGroups.reduce(
    (count, group) => count + group.commands.length,
    0,
  );

  const saveBinding = (commandId: CommandId, binding: Keybinding | null) =>
    void patch({ keybindings: { overrides: { [commandId]: binding } } });

  const searchByPressedKeys = (event: KeyboardEvent<HTMLInputElement>) => {
    const pressedQuery = keybindingSearchQueryFromEvent(event.nativeEvent);
    if (!pressedQuery) return;
    event.preventDefault();
    event.stopPropagation();
    setQuery(pressedQuery);
  };

  return (
    <SettingsSection
      title="Keybindings"
      description="Search by command or press a shortcut in the search field. Select a keybinding to record a replacement; Escape cancels and Delete disables it."
    >
      <div className="qali-surface qali-surface--flat overflow-hidden rounded-2xl">
        <div className="flex min-h-14 flex-col gap-3 border-b border-[var(--qali-edge-subtle)] px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">Commands</p>
            <p aria-live="polite" className="text-xs text-muted-foreground">
              {resultCount} {resultCount === 1 ? "keybinding" : "keybindings"}
            </p>
          </div>
          <label className="relative block w-full sm:w-64">
            <HugeiconsIcon
              icon={Search01Icon}
              strokeWidth={1.8}
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              onKeyDown={searchByPressedKeys}
              placeholder="Search commands or press keys"
              aria-label="Search keybindings by command or shortcut"
              className="qali-control--raised h-9 rounded-xl border-input pl-9 text-xs"
            />
          </label>
        </div>

        {resultCount > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[680px] table-fixed border-collapse text-left">
              <thead>
                <tr className="border-b border-[var(--qali-edge-subtle)] text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                  <th scope="col" className="w-[38%] px-4 py-2.5">
                    Command
                  </th>
                  <th scope="col" className="w-[27%] px-4 py-2.5 text-right">
                    Keybinding
                  </th>
                  <th scope="col" className="w-[20%] px-4 py-2.5">
                    Scope
                  </th>
                  <th scope="col" className="w-[15%] px-4 py-2.5">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody>
                {commandGroups.map((group) => (
                  <KeybindingGroupRows
                    key={group.id}
                    group={group}
                    overrides={overrides}
                    recordingConflict={recordingConflict}
                    onConflict={setRecordingConflict}
                    onSave={saveBinding}
                  />
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="px-4 py-12 text-center">
            <p className="text-sm font-medium text-foreground">
              No matching keybindings
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Try a command name, a key such as K, or a chord such as ⌘K.
            </p>
          </div>
        )}
      </div>

      <div className="flex justify-end pt-4">
        <Button
          type="button"
          variant="quiet"
          size="sm"
          onClick={() => void reset("keybindings")}
          className="text-xs text-muted-foreground"
        >
          Reset all keybindings
        </Button>
      </div>
    </SettingsSection>
  );
}

function KeybindingGroupRows({
  group,
  onConflict,
  onSave,
  overrides,
  recordingConflict,
}: {
  group: (typeof GROUPS)[number] & {
    commands: readonly (typeof COMMANDS)[number][];
  };
  onConflict(
    value: { command: CommandId; conflicts: readonly CommandId[] } | null,
  ): void;
  onSave(command: CommandId, binding: Keybinding | null): void;
  overrides: Readonly<Partial<Record<CommandId, Keybinding | null>>>;
  recordingConflict: {
    command: CommandId;
    conflicts: readonly CommandId[];
  } | null;
}) {
  return (
    <>
      <tr>
        <th
          scope="rowgroup"
          colSpan={4}
          className="border-b border-[var(--qali-edge-subtle)] bg-[var(--qali-surface-inset)] px-4 py-2 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground"
        >
          {group.label}
        </th>
      </tr>
      {group.commands.map((command) => {
        const binding = effectiveKeybinding(command.id, overrides);
        const conflicts =
          recordingConflict?.command === command.id
            ? recordingConflict.conflicts
            : binding
              ? findKeybindingConflicts(command.id, binding, overrides)
              : [];
        const usesDefault = keybindingsEqual(binding, command.defaultBinding);
        const conflictLabels = conflicts.map(
          (id) =>
            COMMANDS.find((candidate) => candidate.id === id)?.label ?? id,
        );
        const status = conflicts.length
          ? "Conflict"
          : binding === null
            ? "Disabled"
            : usesDefault
              ? "Default"
              : "Custom";

        return (
          <tr
            key={command.id}
            className="group border-b border-[var(--qali-edge-subtle)] last:border-b-0 hover:bg-accent/35"
          >
            <th scope="row" className="px-4 py-3 font-normal">
              <p className="truncate text-sm font-medium text-foreground">
                {command.label}
              </p>
              <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground/70">
                {command.id}
              </p>
            </th>
            <td className="px-4 py-3">
              <ShortcutRecorder
                commandLabel={command.label}
                value={binding}
                conflicts={conflictLabels}
                onChange={(nextBinding) => {
                  if (nextBinding === null) {
                    onConflict(null);
                    onSave(command.id, null);
                    return;
                  }
                  const nextConflicts = findKeybindingConflicts(
                    command.id,
                    nextBinding,
                    overrides,
                  );
                  if (nextConflicts.length > 0) {
                    onConflict({
                      command: command.id,
                      conflicts: nextConflicts,
                    });
                    return;
                  }
                  onConflict(null);
                  onSave(command.id, nextBinding);
                }}
                onReset={
                  usesDefault
                    ? undefined
                    : () => {
                        onConflict(null);
                        onSave(command.id, command.defaultBinding);
                      }
                }
              />
            </td>
            <td className="px-4 py-3 text-xs text-muted-foreground">
              {command.id.startsWith("workspace.section.")
                ? "Sidebar order"
                : command.context === "calendar"
                  ? "Calendar"
                  : "Anywhere"}
            </td>
            <td className="px-4 py-3">
              <span
                title={
                  conflicts.length
                    ? `Conflicts with ${conflictLabels.join(", ")}`
                    : undefined
                }
                className={
                  conflicts.length
                    ? "inline-flex items-center gap-1.5 text-xs font-medium text-destructive"
                    : "text-xs text-muted-foreground"
                }
              >
                {conflicts.length ? (
                  <HugeiconsIcon
                    icon={Alert02Icon}
                    strokeWidth={1.8}
                    className="size-3.5"
                    aria-hidden
                  />
                ) : null}
                {status}
              </span>
            </td>
          </tr>
        );
      })}
    </>
  );
}
