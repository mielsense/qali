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
  SETTINGS_NAVIGATION,
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
      searching
        ? findSettingsSearchResults(query)
        : findSettingsNavigation(""),
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
      className="qali-settings-sidebar min-h-0 w-[252px] shrink-0 overflow-y-auto border-e border-border bg-background px-4 py-4"
      aria-label="Settings navigation"
    >
      <label className="qali-control flex h-9 items-center gap-2.5 rounded-xl border border-input bg-[var(--qali-surface-flat)] px-3 text-muted-foreground focus-within:border-[var(--qali-accent)] focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--qali-accent-focus)]">
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
      <nav
        className="mt-5"
        aria-label="Settings categories"
        onKeyDown={onNavigationKeyDown}
      >
        {searching ? (
          <p className="mb-2 px-1 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
            Matching settings
          </p>
        ) : null}
        <ul className={cn(searching ? "space-y-0.5" : "space-y-1.5")}>
          {items.map((item, index) => {
            const Icon = icons[item.to];
            const searchItem = isSettingsSearchItem(item);
            const category = SETTINGS_NAVIGATION.find(
              (entry) => entry.to === item.to,
            )?.label;
            const active =
              pathname === item.to &&
              (!searchItem || activeAnchor === item.anchor);
            return (
              <li
                key={`${item.to}:${searchItem ? item.anchor : "category"}`}
              >
                <Link
                  ref={(node) => {
                    itemRefs.current[index] = node;
                  }}
                  to={item.to as SettingsPath}
                  {...(searchItem
                    ? { hash: item.anchor }
                    : {})}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "group flex w-full items-center gap-2.5 rounded-lg px-1 text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--qali-accent-focus)]",
                    searchItem ? "min-h-12 py-1.5" : "min-h-10",
                    active && "font-medium text-[var(--qali-accent)]",
                  )}
                >
                  <span
                    className={cn(
                      "flex size-7 shrink-0 items-center justify-center",
                      active && "text-[var(--qali-accent)]",
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
                    {searchItem ? (
                      <span className="block truncate text-[10px] font-normal text-muted-foreground">
                        {category} · {item.description}
                      </span>
                    ) : null}
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
