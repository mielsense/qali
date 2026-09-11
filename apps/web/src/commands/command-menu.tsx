import {
  Analytics01Icon,
  ArrowRight01Icon,
  Cancel01Icon,
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
import { useCallback, useRef, useState, type CSSProperties } from "react";
import { motion, useReducedMotion } from "motion/react";

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
  if (
    item.id.startsWith("navigate.settings") ||
    item.id.startsWith("navigate.google") ||
    item.id.startsWith("navigate.preferences") ||
    item.id.startsWith("navigate.shortcuts")
  )
    return ComputerSettingsIcon;
  if (item.id === "calendar.event.create") return PlusSignIcon;
  if (item.id === "assistant.toggle") return SparklesIcon;
  return Calendar03Icon;
}

/** Portal's compact input unfolds into a browsable command center. */
export function CommandMenu() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [browsing, setBrowsing] = useState(false);
  const [category, setCategory] = useState<string>("All");
  const [recent, setRecent] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const reduceMotion = useReducedMotion();
  const navigate = useNavigate();
  const dispatch = useCommandDispatcher();
  const expanded = browsing || query.length > 0;
  const changeOpen = useCallback((next: boolean) => {
    setOpen(next);
    if (!next) {
      setQuery("");
      setBrowsing(false);
      setCategory("All");
    }
  }, []);
  useCommand(
    "command-palette.open",
    useCallback(() => changeOpen(!open), [open, changeOpen]),
  );
  const select = useCallback(
    (item: CommandMenuItem) => {
      setRecent((current) =>
        [item.id, ...current.filter((id) => id !== item.id)].slice(0, 5),
      );
      changeOpen(false);
      void runCommandMenuItem(item, { dispatch, navigate });
    },
    [dispatch, navigate, changeOpen],
  );
  const items = COMMAND_MENU_ITEMS.filter(
    (item) => category === "All" || item.group === category,
  );
  const recentItems =
    !query && category === "All"
      ? recent.flatMap((id) => items.filter((item) => item.id === id))
      : [];
  return (
    <MotionDialog
      open={open}
      onOpenChange={changeOpen}
      label="Qali command center"
      className="qali-command-center qali-frosted-panel max-w-[704px] rounded-2xl"
    >
      <Command
        loop
        className="bg-transparent text-foreground"
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") setBrowsing(true);
          if (event.key === "Escape" && expanded) {
            event.preventDefault();
            event.stopPropagation();
            setQuery("");
            setBrowsing(false);
            setCategory("All");
            inputRef.current?.focus();
          }
        }}
      >
        <div className="flex h-14 items-center gap-3 px-3.5">
          <span className="qali-command-tile flex size-8 shrink-0 items-center justify-center rounded-[10px] [--command-tile-color:var(--primary)]">
            <HugeiconsIcon
              icon={Search01Icon}
              strokeWidth={1.8}
              className="size-4"
            />
          </span>
          <Command.Input
            ref={inputRef}
            autoFocus
            value={query}
            onValueChange={setQuery}
            aria-label="Search Qali commands"
            placeholder="Search commands, pages, and settings…"
            className="h-full min-w-0 flex-1 bg-transparent text-[15px] caret-primary outline-none placeholder:text-muted-foreground"
          />
          {query ? (
            <motion.button
              type="button"
              aria-label="Clear search"
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              onClick={() => {
                setQuery("");
                inputRef.current?.focus();
              }}
              className="flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-foreground/5 active:scale-95 motion-reduce:transform-none"
            >
              <HugeiconsIcon icon={Cancel01Icon} className="size-3.5" />
            </motion.button>
          ) : !expanded ? (
            <button
              type="button"
              onClick={() => {
                setBrowsing(true);
                inputRef.current?.focus();
              }}
              className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
            >
              <kbd>↓</kbd> Browse
            </button>
          ) : (
            <kbd className="text-[11px] text-muted-foreground">esc</kbd>
          )}
        </div>
        <motion.div
          initial={false}
          animate={{ height: expanded ? "auto" : 0, opacity: expanded ? 1 : 0 }}
          transition={
            reduceMotion
              ? { duration: 0 }
              : { duration: 0.2, ease: [0.16, 1, 0.3, 1] }
          }
          className="overflow-hidden"
        >
          <div hidden={!expanded}>
            <div
              className="flex gap-1 border-t border-foreground/10 px-3 py-2"
              role="group"
              aria-label="Command categories"
            >
              {["All", ...GROUPS].map((group) => (
                <button
                  key={group}
                  type="button"
                  aria-pressed={category === group}
                  onClick={() => {
                    setCategory(group);
                    inputRef.current?.focus();
                  }}
                  className={cn(
                    "rounded-md px-2.5 py-1 text-xs transition-colors hover:bg-foreground/5",
                    category === group
                      ? "bg-foreground/10 text-foreground"
                      : "text-muted-foreground",
                  )}
                >
                  {group}
                </button>
              ))}
            </div>
            <Command.List className="max-h-[min(48dvh,384px)] overflow-y-auto overscroll-contain px-2 pb-2 [scrollbar-width:thin]">
              <Command.Empty className="px-4 py-10 text-center text-sm text-muted-foreground">
                No matching commands. Try “calendar” or “settings”.
              </Command.Empty>
              {recentItems.length > 0 ? (
                <Command.Group heading="Recent" className="qali-command-group">
                  {recentItems.map((item) => (
                    <CommandMenuRow
                      key={item.id}
                      item={item}
                      onSelect={() => select(item)}
                    />
                  ))}
                </Command.Group>
              ) : null}
              {GROUPS.map((group) => (
                <Command.Group
                  key={group}
                  heading={group}
                  className="qali-command-group"
                >
                  {items
                    .filter(
                      (item) =>
                        item.group === group &&
                        !recentItems.some((recent) => recent.id === item.id),
                    )
                    .map((item) => (
                      <CommandMenuRow
                        key={item.id}
                        item={item}
                        onSelect={() => select(item)}
                      />
                    ))}
                </Command.Group>
              ))}
            </Command.List>
            <div className="flex items-center justify-between border-t border-foreground/10 px-4 py-2.5 text-[11px] text-muted-foreground">
              <span>↑ ↓ to navigate</span>
              <span>
                ↵ Open <span className="ml-3">esc Back</span>
              </span>
            </div>
          </div>
        </motion.div>
      </Command>
    </MotionDialog>
  );
}

function CommandMenuRow({
  item,
  onSelect,
}: {
  item: CommandMenuItem;
  onSelect(): void;
}) {
  const shortcut = useCommandLabel(
    item.action.kind === "command"
      ? item.action.command
      : "command-palette.open",
  );
  const Icon = itemIcon(item);
  return (
    <Command.Item
      value={item.label}
      keywords={[item.detail, ...item.keywords]}
      onSelect={onSelect}
      className="group relative flex min-h-11 cursor-default items-center gap-2.5 rounded-xl px-2.5 py-1.5 outline-none transition-colors duration-100 data-[selected=true]:bg-foreground/[0.055]"
    >
      <span
        className="qali-command-tile flex size-7 shrink-0 items-center justify-center rounded-[0.55rem]"
        style={
          {
            "--command-tile-color":
              item.group === "Navigate"
                ? "var(--primary)"
                : item.group === "Calendar"
                  ? "#f9e2af"
                  : "#89b4fa",
          } as CSSProperties
        }
      >
        <HugeiconsIcon
          icon={Icon}
          strokeWidth={2}
          className="relative size-4"
        />
      </span>
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="truncate text-sm font-semibold">{item.label}</span>
        <span className="hidden min-w-0 truncate text-xs text-muted-foreground sm:block">
          {item.detail}
        </span>
      </span>
      {item.action.kind === "command" && shortcut ? (
        <kbd className="rounded-md border border-foreground/10 px-1.5 py-0.5 text-[10px] text-muted-foreground transition-transform duration-150 group-data-[selected=true]:-translate-x-4 motion-reduce:transform-none">
          {shortcut}
        </kbd>
      ) : null}
      <HugeiconsIcon
        icon={ArrowRight01Icon}
        className="pointer-events-none absolute right-2.5 size-3.5 text-muted-foreground opacity-0 transition-all duration-150 group-data-[selected=true]:opacity-100"
      />
    </Command.Item>
  );
}
