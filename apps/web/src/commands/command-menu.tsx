import {
  Analytics01Icon,
  Calendar03Icon,
  ComputerSettingsIcon,
  PlusSignIcon,
  Search01Icon,
  SparklesIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { MotionDialog } from "@qali/ui/components/motion-dialog";
import { cn } from "@qali/ui/lib/utils";
import { useNavigate } from "@tanstack/react-router";
import { Command } from "cmdk";
import { useCallback, useState } from "react";

import {
  useCommand,
  useCommandDispatcher,
  useCommandLabel,
} from "./command-provider";
import { runCommandMenuItem } from "./command-menu-action";
import { COMMAND_MENU_ITEMS, type CommandMenuItem } from "./command-menu-items";

const GROUPS = ["Navigate", "Calendar", "Workspace"] as const;

function itemIcon(item: CommandMenuItem): IconSvgElement {
  if (item.id === "navigate.insights") return Analytics01Icon;
  if (item.id.startsWith("navigate.settings") || item.id.startsWith("navigate.google") || item.id.startsWith("navigate.preferences") || item.id.startsWith("navigate.shortcuts")) return ComputerSettingsIcon;
  if (item.id === "calendar.event.create") return PlusSignIcon;
  if (item.id === "assistant.toggle") return SparklesIcon;
  return Calendar03Icon;
}

export function CommandMenu() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const dispatch = useCommandDispatcher();
  const menuShortcut = useCommandLabel("command-palette.open");

  const toggle = useCallback(() => setOpen((current) => !current), []);
  useCommand("command-palette.open", toggle);

  const select = useCallback(
    (item: CommandMenuItem) => {
      setOpen(false);
      void runCommandMenuItem(item, { dispatch, navigate });
    },
    [dispatch, navigate],
  );

  return (
    <MotionDialog open={open} onOpenChange={setOpen} label="Qali command menu">
      <Command loop className="bg-transparent text-foreground">
        <div className="flex h-14 items-center gap-3 border-b border-[var(--qali-edge-subtle)] px-4">
          <HugeiconsIcon icon={Search01Icon} strokeWidth={1.8} className="size-5 text-muted-foreground" />
          <Command.Input
            autoFocus
            aria-label="Search Qali commands"
            placeholder="Search commands, pages, and settings…"
            className="h-full min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-muted-foreground"
          />
          {menuShortcut ? <kbd className="rounded-lg border border-[var(--qali-edge-subtle)] bg-muted/60 px-2 py-1 font-mono text-[11px] text-muted-foreground">{menuShortcut}</kbd> : null}
        </div>
        <Command.List className="max-h-[min(52vh,440px)] overflow-y-auto p-2 [scrollbar-width:thin]">
          <Command.Empty className="px-4 py-10 text-center text-sm text-muted-foreground">
            No matching command
          </Command.Empty>
          {GROUPS.map((group) => (
            <Command.Group
              key={group}
              heading={group}
              className="[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:py-2 [&_[cmdk-group-heading]]:font-display [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.12em] [&_[cmdk-group-heading]]:text-muted-foreground"
            >
              {COMMAND_MENU_ITEMS.filter((item) => item.group === group).map((item) => (
                <CommandMenuRow key={item.id} item={item} onSelect={() => select(item)} />
              ))}
            </Command.Group>
          ))}
        </Command.List>
        <div className="flex items-center justify-between border-t border-[var(--qali-edge-subtle)] px-4 py-2 text-[11px] text-muted-foreground">
          <span>Type to search</span>
          <span>↑↓ navigate · ↩ run · Esc close</span>
        </div>
      </Command>
    </MotionDialog>
  );
}

function CommandMenuRow({ item, onSelect }: { item: CommandMenuItem; onSelect(): void }) {
  const commandShortcut = useCommandLabel(
    item.action.kind === "command" ? item.action.command : "command-palette.open",
  );
  const Icon = itemIcon(item);
  return (
    <Command.Item
      value={`${item.label} ${item.detail}`}
      keywords={[...item.keywords]}
      onSelect={onSelect}
      className={cn(
        "group flex cursor-default items-center gap-3 rounded-xl px-2.5 py-2.5 outline-none",
        "data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground",
      )}
    >
      <span className="qali-control qali-control--quiet flex size-9 shrink-0 items-center justify-center rounded-xl text-muted-foreground group-data-[selected=true]:text-foreground">
        <HugeiconsIcon icon={Icon} strokeWidth={1.8} className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{item.label}</span>
        <span className="block truncate text-xs text-muted-foreground">{item.detail}</span>
      </span>
      {item.action.kind === "command" && commandShortcut ? (
        <kbd className="rounded-md bg-muted/70 px-1.5 py-1 font-mono text-[10px] text-muted-foreground">{commandShortcut}</kbd>
      ) : null}
    </Command.Item>
  );
}
