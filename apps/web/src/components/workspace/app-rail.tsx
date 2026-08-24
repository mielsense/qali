import {
  Analytics01Icon,
  Calendar03Icon,
  ComputerSettingsIcon,
  DragDropVerticalIcon,
  PlusSignIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@qali/ui/components/tooltip";
import { buttonVariants } from "@qali/ui/components/button";
import { cn } from "@qali/ui/lib/utils";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { Reorder, useDragControls, useReducedMotion } from "motion/react";
import { useCallback, useState, type ReactNode } from "react";

import { useCommand, useCommandLabel } from "@/commands/command-provider";

import { useDock } from "./dock-context";
import { WorkspaceUtilityMenu } from "./workspace-utility-menu";
import {
  DEFAULT_WORKSPACE_SECTION_ORDER,
  normalizeWorkspaceSectionOrder,
  readWorkspaceSectionOrder,
  sectionCommandId,
  type WorkspaceSectionId,
  writeWorkspaceSectionOrder,
} from "./workspace-sections";

type AppRailDestination = {
  id: WorkspaceSectionId;
  label: string;
  to: "/" | "/insights" | "/settings";
  icon: IconSvgElement;
};

export const APP_RAIL_DESTINATIONS = [
  { id: "calendar", label: "Calendar", to: "/", icon: Calendar03Icon },
  {
    id: "insights",
    label: "Insights",
    to: "/insights",
    icon: Analytics01Icon,
  },
  {
    id: "settings",
    label: "Settings",
    to: "/settings",
    icon: ComputerSettingsIcon,
  },
] as const satisfies readonly AppRailDestination[];

const APP_RAIL_DESTINATION_BY_ID = Object.fromEntries(
  APP_RAIL_DESTINATIONS.map((destination) => [destination.id, destination]),
) as Readonly<Record<WorkspaceSectionId, AppRailDestination>>;

export function isSettingsPath(pathname: string) {
  return pathname === "/settings" || pathname.startsWith("/settings/");
}

export function isAppRailDestinationActive(pathname: string, to: string) {
  if (to === "/settings") return isSettingsPath(pathname);
  return pathname === to || (to !== "/" && pathname.startsWith(`${to}/`));
}

/** Persistent route navigation. The rail stays deliberately quiet: material is
 * owned by WorkspaceChrome, while only the active destination gets emphasis. */
export function AppRail() {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const [order, setOrder] = useState<WorkspaceSectionId[]>(() =>
    typeof window === "undefined"
      ? [...DEFAULT_WORKSPACE_SECTION_ORDER]
      : readWorkspaceSectionOrder(window.localStorage),
  );
  const { openCreate } = useDock();
  const createLabel = useCommandLabel("calendar.event.create");

  const persistOrder = useCallback((next: WorkspaceSectionId[]) => {
    const normalized = normalizeWorkspaceSectionOrder(next);
    setOrder(normalized);
    try {
      writeWorkspaceSectionOrder(window.localStorage, normalized);
    } catch {
      // The rail remains usable when browser storage is unavailable.
    }
  }, []);

  const moveSection = useCallback(
    (id: WorkspaceSectionId, direction: -1 | 1) => {
      const index = order.indexOf(id);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= order.length) return;
      const next = [...order];
      [next[index], next[target]] = [next[target]!, next[index]!];
      persistOrder(next);
    },
    [order, persistOrder],
  );

  return (
    <nav
      aria-label="Workspace"
      className="flex h-full min-w-0 flex-col items-center px-2 pb-6 pt-3"
    >
      <RailAction
        label={createLabel ? `New event · ${createLabel}` : "New event"}
        variant="accent"
        onClick={openCreate}
        icon={PlusSignIcon}
      />

      <div className="my-3 h-px w-full bg-border" />

      <Reorder.Group
        as="ol"
        axis="y"
        values={order}
        onReorder={persistOrder}
        className="flex w-full flex-col gap-1"
      >
        {order.map((id, index) => {
          const destination = APP_RAIL_DESTINATION_BY_ID[id];
          return (
            <AppRailItem
              key={id}
              id={id}
              index={index}
              destination={destination}
              active={isAppRailDestinationActive(pathname, destination.to)}
              onMove={moveSection}
            />
          );
        })}
      </Reorder.Group>

      <div className="mt-auto flex w-full flex-col items-center gap-1">
        <WorkspaceUtilityMenu />
      </div>
    </nav>
  );
}

function AppRailItem({
  id,
  index,
  destination,
  active,
  onMove,
}: {
  id: WorkspaceSectionId;
  index: number;
  destination: AppRailDestination;
  active: boolean;
  onMove: (id: WorkspaceSectionId, direction: -1 | 1) => void;
}) {
  const command = sectionCommandId(index);
  const shortcut = useCommandLabel(command);
  const navigate = useNavigate();
  const dragControls = useDragControls();
  const reducedMotion = useReducedMotion();
  useCommand(command, () => {
    void navigate({ to: destination.to });
    return true;
  });

  const tooltip = shortcut
    ? `${destination.label} · ${shortcut}`
    : destination.label;

  return (
    <Reorder.Item
      value={id}
      dragListener={false}
      dragControls={dragControls}
      whileDrag={reducedMotion ? undefined : { scale: 1.035 }}
      transition={reducedMotion ? { duration: 0 } : { duration: 0.18 }}
      className="group/rail-item relative flex h-12 w-full items-center justify-center"
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <Link
              to={destination.to}
              aria-current={active ? "page" : undefined}
              aria-label={tooltip}
              className={cn(
                buttonVariants({
                  variant: active ? "raised" : "quiet",
                  size: "icon-lg",
                }),
                "relative text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                active &&
                  "border-[var(--qali-glass-edge-firm)] text-foreground",
              )}
            />
          }
        >
          <HugeiconsIcon
            icon={destination.icon as IconSvgElement}
            strokeWidth={1.8}
            className="size-5"
            aria-hidden="true"
          />
        </TooltipTrigger>
        <TooltipContent side="right" align="center">
          <span>{destination.label}</span>
          {shortcut ? (
            <kbd className="rounded-sm bg-muted px-1 py-0.5 font-mono text-[10px] text-muted-foreground">
              {shortcut}
            </kbd>
          ) : null}
        </TooltipContent>
      </Tooltip>

      <button
        type="button"
        aria-label={`Reorder ${destination.label}. Use Up and Down arrows.`}
        onPointerDown={(event) => dragControls.start(event)}
        onKeyDown={(event) => {
          if (event.key === "ArrowUp") {
            event.preventDefault();
            onMove(id, -1);
          }
          if (event.key === "ArrowDown") {
            event.preventDefault();
            onMove(id, 1);
          }
        }}
        className="absolute right-0 flex size-5 touch-none items-center justify-center rounded-md text-muted-foreground/35 opacity-0 outline-none transition-opacity group-hover/rail-item:opacity-100 hover:text-muted-foreground focus-visible:opacity-100 focus-visible:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
      >
        <HugeiconsIcon
          icon={DragDropVerticalIcon}
          strokeWidth={1.7}
          className="size-3"
          aria-hidden="true"
        />
      </button>
    </Reorder.Item>
  );
}

function RailAction({
  label,
  active,
  variant = "quiet",
  icon,
  glyph,
  onClick,
}: {
  label: string;
  active?: boolean;
  variant?: "quiet" | "accent";
  icon?: IconSvgElement;
  glyph?: ReactNode;
  onClick: () => void;
}) {
  const button = (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active || undefined}
      onClick={onClick}
      className={cn(
        buttonVariants({
          variant:
            variant === "accent" ? "accent" : active ? "raised" : "quiet",
          size: "icon-lg",
        }),
      )}
    >
      {glyph ??
        (icon ? (
          <HugeiconsIcon icon={icon} strokeWidth={1.9} className="size-5" />
        ) : null)}
    </button>
  );

  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}
