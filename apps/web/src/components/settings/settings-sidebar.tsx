import {
  Calendar03Icon,
  ComputerSettingsIcon,
  GlobalIcon,
  KeyboardIcon,
  Search01Icon,
  TimeScheduleIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { useMemo, useRef, useState, type KeyboardEvent } from "react";

import { cn } from "@qali/ui/lib/utils";

import {
  findSettingsNavigation,
  findSettingsSearchResults,
  moveSettingsNavigation,
  type SettingsNavigationItem,
  type SettingsPath,
  type SettingsSearchItem,
} from "./settings-navigation";

const icons: Readonly<Record<SettingsPath, IconSvgElement>> = {
  "/settings/calendar": TimeScheduleIcon,
  "/settings/calendars-google": Calendar03Icon,
  "/settings/shortcuts": KeyboardIcon,
  "/settings/assistant": GlobalIcon,
  "/settings/data-recovery": ComputerSettingsIcon,
};

function isSettingsSearchItem(
  item: SettingsNavigationItem | SettingsSearchItem,
): item is SettingsSearchItem {
  return "anchor" in item;
}

export function SettingsSidebar() {
  const location = useLocation();
  const pathname = location.pathname;
  const activeAnchor = location.hash.replace(/^#/, "");
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const searching = query.trim().length > 0;
  const items = useMemo<
    readonly (SettingsNavigationItem | SettingsSearchItem)[]
  >(
    () =>
      searching ? findSettingsSearchResults(query) : findSettingsNavigation(""),
    [query, searching],
  );
  const itemRefs = useRef<Array<HTMLAnchorElement | null>>([]);

  const onNavigationKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (
      !items.length ||
      !["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)
    ) {
      return;
    }
    event.preventDefault();
    const focusedIndex = itemRefs.current.findIndex(
      (node) =>
        node === event.target ||
        (event.target instanceof Node && node?.contains(event.target)),
    );
    const routeIndex = items.findIndex((item) => item.to === pathname);
    const currentIndex = Math.max(
      0,
      focusedIndex >= 0 ? focusedIndex : routeIndex,
    );
    const next = moveSettingsNavigation(currentIndex, event.key, items.length);
    const item = items[next];
    if (!item) return;
    void navigate({
      to: item.to,
      ...(isSettingsSearchItem(item) ? { hash: item.anchor } : {}),
    });
    requestAnimationFrame(() => itemRefs.current[next]?.focus());
  };

  return (
    <aside
      className="qali-settings-sidebar flex h-full min-h-0 w-64 shrink-0 flex-col border-e border-border bg-background"
      aria-label="Settings navigation"
    >
      <div className="px-5 pt-5 pb-4">
        <h2 className="text-lg font-medium text-foreground">Settings</h2>
        <p className="mt-1 text-sm leading-5 text-muted-foreground">
          Calendar and workspace preferences
        </p>
      </div>
      <div className="shrink-0 px-4 pb-4">
        <label className="qali-control flex h-9 w-full items-center gap-2 rounded-lg border border-border bg-card px-2.5 text-muted-foreground shadow-[var(--qali-shadow-control)] focus-within:border-ring">
          <HugeiconsIcon
            icon={Search01Icon}
            strokeWidth={2}
            className="size-4"
            aria-hidden="true"
          />
          <span className="sr-only">Search settings</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Search settings"
            className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
        </label>
      </div>
      <nav
        className="min-h-0 flex-1 overflow-y-auto px-4 pb-4"
        aria-label="Settings categories"
        onKeyDown={onNavigationKeyDown}
      >
        {searching ? (
          <p className="px-2 py-2 text-xs text-muted-foreground">
            Matching settings
          </p>
        ) : null}
        <ul className="flex flex-col gap-1 py-1">
          {items.map((item, index) => {
            const Icon = icons[item.to];
            const searchItem = isSettingsSearchItem(item);
            const active =
              pathname === item.to &&
              (!searchItem || activeAnchor === item.anchor);
            return (
              <li key={`${item.to}:${searchItem ? item.anchor : "category"}`}>
                <Link
                  ref={(node) => {
                    itemRefs.current[index] = node;
                  }}
                  to={item.to as SettingsPath}
                  {...(searchItem ? { hash: item.anchor } : {})}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "relative flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-sidebar-foreground outline-none transition-colors duration-150 hover:bg-foreground/5 focus-visible:outline-2 focus-visible:outline-ring",
                    active && "font-medium text-foreground dark:text-white",
                  )}
                >
                  <span
                    className={cn(
                      "flex size-4 shrink-0 items-center justify-center",
                      active && "text-foreground dark:text-white",
                    )}
                  >
                    <HugeiconsIcon
                      icon={Icon}
                      strokeWidth={1.8}
                      className="size-4"
                      aria-hidden="true"
                    />
                  </span>
                  <span className="min-w-0 flex-1 truncate">
                    <span className="block truncate">{item.label}</span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
        {items.length === 0 ? (
          <p
            role="status"
            className="px-2 py-6 text-center text-xs text-muted-foreground"
          >
            No matching settings
          </p>
        ) : null}
      </nav>
    </aside>
  );
}
