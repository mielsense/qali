import { useState } from "react";

import { useDesktopStatus } from "@/lib/desktop/status";
import { googleAccountFailureReason, notify } from "@/lib/notices";

export function useWorkspaceSyncAction() {
  const desktop = useDesktopStatus();
  const [requesting, setRequesting] = useState(false);
  const accounts = desktop?.google.kind === "ready" ? desktop.google.accounts : [];
  const reconnect = accounts.find(
    (account) => account.state === "reconnect-required",
  );
  const syncing =
    requesting ||
    accounts.some(
      (account) =>
        account.state === "connected" && account.syncState === "syncing",
    );
  const label = syncing
    ? "Syncing calendars"
    : accounts.length === 0
      ? "Add Google account"
      : reconnect
        ? `Reconnect ${reconnect.accountEmail}`
        : accounts.length > 1
          ? "Sync all calendars"
          : "Sync calendar";

  const sync = async () => {
    if (requesting) return;
    setRequesting(true);
    let addingAccount = false;
    try {
      if (!desktop) throw new Error("Desktop calendar unavailable");
      if (desktop.google.kind !== "ready") {
        throw new Error("Google Calendar unavailable");
      }
      if (desktop.google.accounts.length === 0) {
        addingAccount = true;
        await desktop.addGoogleAccount();
      } else if (reconnect) {
        await desktop.reconnectGoogleAccount(reconnect.accountId);
      } else {
        await desktop.syncAllGoogleAccounts();
      }
    } catch (error) {
      notify(
        addingAccount
          ? {
              kind: "google-account-add-failed",
              reason: googleAccountFailureReason(error),
            }
          : {
              kind: "calendar-sync-failed",
              reason: desktop ? "connection" : "desktop-required",
            },
      );
    } finally {
      setRequesting(false);
    }
  };

  return { label, syncing, run: sync } as const;
}
