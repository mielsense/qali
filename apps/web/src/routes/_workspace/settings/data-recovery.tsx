import type {
  DesktopUpdateState,
  RecoveryBackupSummary,
} from "@qali/desktop-contracts";
import { Button } from "@qali/ui/components/button";
import { ConfirmationDialog } from "@qali/ui/components/confirmation-dialog";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { SettingsSection } from "@/components/settings/settings-section";
import { SettingsGroup } from "@/components/settings/settings-group";
import { SettingsRow } from "@/components/settings/settings-row";
import { UpdateInstallDialog } from "@/components/settings/update-install-dialog";

export const Route = createFileRoute("/_workspace/settings/data-recovery")({
  component: DataRecoverySettingsPage,
});

function DataRecoverySettingsPage() {
  const [backups, setBackups] = useState<
    readonly RecoveryBackupSummary[] | null
  >(null);
  const [notice, setNotice] = useState("");
  const [updateState, setUpdateState] = useState<DesktopUpdateState | null>(
    null,
  );
  const [confirmUpdateOpen, setConfirmUpdateOpen] = useState(false);
  const [installingUpdate, setInstallingUpdate] = useState(false);
  const [recoveryConfirmation, setRecoveryConfirmation] = useState<
    | { kind: "restore"; backup: RecoveryBackupSummary }
    | { kind: "reset" }
    | null
  >(null);
  const [confirmingRecovery, setConfirmingRecovery] = useState(false);
  const recovery = window.qali?.recovery;
  const updates = window.qali?.updates;

  useEffect(() => {
    if (!recovery) return;
    void recovery
      .listBackups()
      .then(setBackups)
      .catch(() => setNotice("Backups could not be read."));
  }, [recovery]);

  useEffect(() => {
    if (!updates) return;
    void updates
      .status()
      .then(setUpdateState)
      .catch(() => undefined);
    return window.qali?.events.subscribe((event) => {
      if (event.type === "update-status") setUpdateState(event.status);
    });
  }, [updates]);

  const exportData = async () => {
    if (!recovery) return;
    const result = await recovery.exportData();
    setNotice(
      result.kind === "exported"
        ? `Exported ${result.calendarCount} calendars and ${result.eventCount} events.`
        : "Export cancelled.",
    );
  };
  const confirmRecoveryAction = async () => {
    if (!recovery || !recoveryConfirmation) return;
    setConfirmingRecovery(true);
    try {
      if (recoveryConfirmation.kind === "restore") {
        const result = await recovery.restore(recoveryConfirmation.backup.id);
        setNotice(
          result.restartRequired
            ? "Backup restored. Restart Qali to use it."
            : "Backup restored.",
        );
      } else {
        const result = await recovery.reset();
        setNotice(
          result.restartRequired
            ? "Local data reset. Restart Qali to continue."
            : "Local data reset.",
        );
      }
      setRecoveryConfirmation(null);
    } catch {
      setNotice(
        recoveryConfirmation.kind === "restore"
          ? "Qali could not restore this backup."
          : "Qali could not reset local data.",
      );
    } finally {
      setConfirmingRecovery(false);
    }
  };

  const checkForUpdates = async () => {
    if (!updates) return;
    setUpdateState(await updates.check());
  };

  const installUpdate = async () => {
    if (!updates || updateState?.kind !== "ready") return;
    setInstallingUpdate(true);
    try {
      await updates.install();
    } catch {
      setInstallingUpdate(false);
      setConfirmUpdateOpen(false);
      setNotice("Qali could not start the update. Try again.");
    }
  };

  const updateDescription = (() => {
    if (!updateState) {
      return updates
        ? "Reading update status…"
        : "Available in the desktop app";
    }
    switch (updateState.kind) {
      case "disabled":
        return updateState.reason === "development"
          ? `Version ${updateState.currentVersion} · Updates are disabled in development builds.`
          : `Version ${updateState.currentVersion} · Updates activate in signed Qali releases.`;
      case "idle":
        return `Version ${updateState.currentVersion} · Ready to check.`;
      case "checking":
        return `Version ${updateState.currentVersion} · Checking for updates…`;
      case "current":
        return `Version ${updateState.currentVersion} is current.`;
      case "downloading":
        return `Downloading ${updateState.version} · ${Math.round(updateState.percent)}%`;
      case "ready":
        return `Version ${updateState.version} is ready to install.`;
      case "error":
        return updateState.message;
    }
  })();

  return (
    <>
      <SettingsSection
        title="System & recovery"
        description="Keep Qali current and manage its local calendar data. Provider credentials are never included in exports or backups."
      >
        <SettingsGroup
          title="Updates & local data"
          description="Install verified releases and manage recoverable copies of your local calendar database."
        >
        <SettingsRow
          id="settings-row-software-updates"
          label="Software updates"
          description={updateDescription}
        >
          {updateState?.kind === "ready" ? (
            <Button
              type="button"
              variant="elevated"
              size="sm"
              onClick={() => setConfirmUpdateOpen(true)}
              className="rounded-lg text-xs"
            >
              Restart to update
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={
                !updates ||
                updateState?.kind === "disabled" ||
                updateState?.kind === "checking" ||
                updateState?.kind === "downloading"
              }
              onClick={() => void checkForUpdates()}
              className="rounded-lg text-xs"
            >
              {updateState?.kind === "checking" ? "Checking…" : "Check now"}
            </Button>
          )}
        </SettingsRow>
        <SettingsRow
          label="Export local data"
          description="Create an export of the calendar data Qali is authorized to manage."
        >
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!recovery}
            onClick={() => void exportData()}
            className="rounded-lg text-xs"
          >
            Export data
          </Button>
        </SettingsRow>
        <SettingsRow
          label="Restore a backup"
          description="A restored backup replaces local calendar data and requires a restart."
        >
          <span className="text-xs text-muted-foreground">
            {backups
              ? `${backups.length} verified backup${backups.length === 1 ? "" : "s"}`
              : recovery
                ? "Loading backups…"
                : "Available in the desktop app"}
          </span>
        </SettingsRow>
        {backups?.map((backup) => (
          <div
            key={backup.id}
            className="flex items-center justify-between gap-4 border-b border-border/80 py-3"
          >
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">
                {new Date(backup.createdAt).toLocaleString()}
              </p>
              <p className="text-xs text-muted-foreground">
                {backup.buildMarker}
              </p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() =>
                setRecoveryConfirmation({ kind: "restore", backup })
              }
              className="rounded-lg text-xs text-muted-foreground"
            >
              Restore
            </Button>
          </div>
        ))}
        <SettingsRow
          label="Reset local data"
          description="Quarantines and clears the existing local Qali data, then requires a restart."
        >
          <Button
            type="button"
            variant="destructive"
            size="sm"
            disabled={!recovery}
            onClick={() => setRecoveryConfirmation({ kind: "reset" })}
            className="rounded-lg text-xs"
          >
            Reset local data
          </Button>
        </SettingsRow>
        {notice ? (
          <p role="status" className="px-3 pb-3 text-xs text-muted-foreground">
            {notice}
          </p>
        ) : null}
        </SettingsGroup>
      </SettingsSection>
      <UpdateInstallDialog
        open={confirmUpdateOpen}
        onOpenChange={setConfirmUpdateOpen}
        version={updateState?.kind === "ready" ? updateState.version : "update"}
        installing={installingUpdate}
        onConfirm={() => void installUpdate()}
      />
      <ConfirmationDialog
        open={recoveryConfirmation !== null}
        onOpenChange={(open) => {
          if (!open) setRecoveryConfirmation(null);
        }}
        eyebrow="Local data"
        title={
          recoveryConfirmation?.kind === "restore"
            ? "Restore this backup and restart Qali?"
            : "Reset Qali’s local data?"
        }
        description={
          recoveryConfirmation?.kind === "restore"
            ? `The backup from ${new Date(recoveryConfirmation.backup.createdAt).toLocaleString()} will replace the current local calendar data. Provider credentials stay in Keychain.`
            : "Qali will quarantine the current local database and start with a clean workspace. This cannot be undone from inside the app."
        }
        confirmLabel={
          recoveryConfirmation?.kind === "restore"
            ? "Restore backup"
            : "Reset local data"
        }
        confirmTone={
          recoveryConfirmation?.kind === "reset" ? "destructive" : "default"
        }
        pending={confirmingRecovery}
        pendingLabel={
          recoveryConfirmation?.kind === "restore" ? "Restoring…" : "Resetting…"
        }
        onConfirm={() => void confirmRecoveryAction()}
      />
    </>
  );
}
