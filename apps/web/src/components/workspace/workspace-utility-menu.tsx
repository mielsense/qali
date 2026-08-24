import {
  HelpCircleIcon,
  KeyboardIcon,
  MoreHorizontalIcon,
  RefreshIcon,
  UserCircleIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@qali/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@qali/ui/components/dropdown-menu";
import { Spinner } from "@qali/ui/components/spinner";
import { Link } from "@tanstack/react-router";

import { useCommandLabel } from "@/commands/command-provider";

import { useWorkspaceSyncAction } from "./workspace-sync-action";

export function WorkspaceUtilityMenu() {
  const sync = useWorkspaceSyncAction();
  const settingsShortcut = useCommandLabel("settings.open");

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="quiet"
            size="icon-lg"
            aria-label="Workspace menu"
            title="Workspace menu"
          />
        }
      >
        <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={1.9} className="size-5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="right" align="end" sideOffset={10} className="w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Workspace</DropdownMenuLabel>
          <DropdownMenuItem
            disabled={sync.syncing}
            onClick={() => void sync.run()}
          >
            {sync.syncing ? (
              <Spinner className="size-4" />
            ) : (
              <HugeiconsIcon icon={RefreshIcon} strokeWidth={1.9} />
            )}
            <span>{sync.label}</span>
          </DropdownMenuItem>
          <DropdownMenuItem
            render={<Link to="/settings/calendars-google" />}
          >
            <HugeiconsIcon icon={UserCircleIcon} strokeWidth={1.9} />
            <span>Google accounts</span>
          </DropdownMenuItem>
          <DropdownMenuItem render={<Link to="/settings/shortcuts" />}>
            <HugeiconsIcon icon={KeyboardIcon} strokeWidth={1.9} />
            <span>Keyboard shortcuts</span>
            {settingsShortcut ? (
              <DropdownMenuShortcut>{settingsShortcut}</DropdownMenuShortcut>
            ) : null}
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem render={<Link to="/settings/data-recovery" />}>
          <HugeiconsIcon icon={HelpCircleIcon} strokeWidth={1.9} />
          <span>Help & recovery</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
