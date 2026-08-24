import {
  Add01Icon,
  Calendar03Icon,
  RefreshIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { api } from "@qali/backend/convex/_generated/api";
import type { Doc } from "@qali/backend/convex/_generated/dataModel";
import {
  MAX_GOOGLE_ACCOUNTS,
  type GoogleAccountId,
  type GoogleAccountStatus,
  type GoogleAccountsSnapshot,
} from "@qali/desktop-contracts";
import { Button } from "@qali/ui/components/button";
import { Checkbox } from "@qali/ui/components/checkbox";
import { ConfirmationDialog } from "@qali/ui/components/confirmation-dialog";
import { cn } from "@qali/ui/lib/utils";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import { useState } from "react";

import {
  CALENDAR_COLOR_CHOICES,
  calendarColorVar,
} from "@/components/calendar/colors";
import { calendarDisplayName } from "@/components/calendar/lib";
import { SettingsSection } from "@/components/settings/settings-section";
import { SettingsGroup } from "@/components/settings/settings-group";
import { SettingsRow } from "@/components/settings/settings-row";
import { SettingsTarget } from "@/components/settings/settings-target";
import { useDesktopStatus } from "@/lib/desktop/status";
import { googleAccountFailureReason, notify } from "@/lib/notices";

export const Route = createFileRoute("/_workspace/settings/calendars-google")({
  component: GoogleCalendarsSettingsPage,
});

type CalendarDoc = Doc<"calendars">;
type CalendarLabelInput = Pick<
  CalendarDoc,
  "googleCalendarId" | "summary" | "summaryOverride"
>;

export const LEGACY_CREDENTIAL_RECOVERY_BUTTON_LABEL =
  "Clear old Google authorization";
export const LEGACY_CREDENTIAL_RECOVERY_CONFIRMATION =
  "Clear the old Google authorization from this Mac? Your local calendar data remains.";

export function legacyCredentialRecoveryAvailable(
  snapshot: GoogleAccountsSnapshot | undefined,
): boolean {
  return (
    snapshot?.kind === "unavailable" &&
    "recoveryRequired" in snapshot &&
    snapshot.recoveryRequired === "legacy-credentials" &&
    snapshot.recoveryAction === "clear-legacy-credentials"
  );
}

export function calendarLabelForAccount(
  calendar: CalendarLabelInput,
  allCalendars: readonly CalendarLabelInput[],
  accountEmail?: string,
): string {
  const baseName = calendarDisplayName(calendar);
  const normalizedName = baseName.trim().toLocaleLowerCase();
  const duplicate =
    allCalendars.filter(
      (candidate) =>
        calendarDisplayName(candidate).trim().toLocaleLowerCase() ===
        normalizedName,
    ).length > 1;
  return duplicate && accountEmail ? `${baseName} — ${accountEmail}` : baseName;
}

function reconnectDescription(account: GoogleAccountStatus): string {
  if (account.state !== "reconnect-required") {
    if (account.syncState === "syncing") return "Syncing calendars now.";
    if (account.syncState === "offline")
      return "Offline. Qali will keep the local copy available.";
    if (account.syncState === "error")
      return "The last sync did not complete. Try again.";
    return "Connected and ready to sync.";
  }
  if (account.reason === "client-mismatch") {
    return "Reconnect this account for the current Qali release.";
  }
  if (account.reason === "credentials-unsafe") {
    return "This authorization is incomplete. Disconnect it, then add the account again.";
  }
  if (account.reason === "credentials-incomplete") {
    return "Finish reconnecting this account to restore calendar access.";
  }
  return "Google authorization expired. Reconnect this account.";
}

function GoogleCalendarsSettingsPage() {
  const desktop = useDesktopStatus();
  const calendars = useQuery(api.calendar.listCalendars) ?? [];
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [legacyConfirmationOpen, setLegacyConfirmationOpen] = useState(false);
  const snapshot = desktop?.google;
  const accounts = snapshot?.kind === "ready" ? snapshot.accounts : [];
  const oauthBusy = snapshot?.kind === "ready" && snapshot.oauthBusy;
  const atAccountLimit = accounts.length >= MAX_GOOGLE_ACCOUNTS;
  const canClearLegacyCredentials = legacyCredentialRecoveryAvailable(snapshot);

  const run = async (key: string, action: () => Promise<void>) => {
    if (busyAction !== null) return;
    setBusyAction(key);
    try {
      await action();
    } finally {
      setBusyAction(null);
    }
  };

  const addAccount = () =>
    run("add", async () => {
      if (!desktop) return;
      try {
        const result = await desktop.addGoogleAccount();
        if (result.kind === "limit-reached") {
          notify({ kind: "google-account-limit" });
        }
      } catch (error) {
        notify({
          kind: "google-account-add-failed",
          reason: googleAccountFailureReason(error),
        });
      }
    });

  const syncAll = () =>
    run("sync-all", async () => {
      if (!desktop) return;
      try {
        await desktop.syncAllGoogleAccounts();
      } catch {
        notify({ kind: "account-action-failed", action: "sync" });
      }
    });

  const clearLegacyCredentials = () =>
    run("clear-legacy", async () => {
      if (!desktop) return;
      try {
        await desktop.clearLegacyGoogleCredentials();
        setLegacyConfirmationOpen(false);
      } catch {
        notify({ kind: "account-action-failed", action: "clear-legacy" });
      }
    });

  return (
    <>
      <SettingsSection
        title="Calendars & Google"
        description="Connect up to eight Google accounts. Each authorization, sync state, calendar visibility, and color stays isolated to its account."
      >
        <SettingsGroup
          title="Connected accounts"
          description="Manage authorizations, sync state, visibility, and color per account."
        >
          <SettingsRow
            label="Google accounts"
            description={
              snapshot?.kind === "unavailable"
                ? (snapshot.message ??
                  "Google Calendar is unavailable in this session.")
                : accounts.length === 0
                  ? "Add an account to start syncing calendars into this local Qali workspace."
                  : `${accounts.length} of ${MAX_GOOGLE_ACCOUNTS} accounts connected.`
            }
          >
            <div className="flex flex-wrap items-center gap-2">
              {accounts.length > 1 ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busyAction !== null || oauthBusy}
                  aria-busy={busyAction === "sync-all"}
                  onClick={() => void syncAll()}
                >
                  <HugeiconsIcon
                    icon={RefreshIcon}
                    strokeWidth={2}
                    className="size-3.5"
                    aria-hidden="true"
                  />
                  {busyAction === "sync-all" ? "Syncing…" : "Sync all"}
                </Button>
              ) : null}
              {desktop ? (
                canClearLegacyCredentials ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busyAction !== null}
                    aria-busy={busyAction === "clear-legacy"}
                    onClick={() => setLegacyConfirmationOpen(true)}
                  >
                    {busyAction === "clear-legacy"
                      ? "Clearing…"
                      : LEGACY_CREDENTIAL_RECOVERY_BUTTON_LABEL}
                  </Button>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    disabled={
                      busyAction !== null ||
                      oauthBusy ||
                      atAccountLimit ||
                      snapshot?.kind === "unavailable"
                    }
                    aria-busy={busyAction === "add" || oauthBusy}
                    onClick={() => void addAccount()}
                  >
                    <HugeiconsIcon
                      icon={Add01Icon}
                      strokeWidth={2}
                      className="size-3.5"
                      aria-hidden="true"
                    />
                    {busyAction === "add" || oauthBusy
                      ? "Opening Google…"
                      : atAccountLimit
                        ? "Account limit reached"
                        : "Add account"}
                  </Button>
                )
              ) : (
                <span className="text-xs text-muted-foreground">
                  Available in the desktop app
                </span>
              )}
            </div>
          </SettingsRow>

          <SettingsTarget
            id="google-calendar-accounts"
            className="px-3 pb-3 pt-1"
          >
            <div className="space-y-7">
              {accounts.map((account) => (
                <GoogleAccountSection
                  key={account.accountId}
                  account={account}
                  calendars={calendars.filter(
                    (calendar) => calendar.accountId === account.accountId,
                  )}
                  allCalendars={calendars}
                  busyAction={busyAction}
                  run={run}
                />
              ))}

              {accounts.length === 0 && calendars.length === 0 ? (
                <div className="flex items-center gap-2 py-5 text-sm text-muted-foreground">
                  <HugeiconsIcon
                    icon={Calendar03Icon}
                    strokeWidth={1.8}
                    className="size-4"
                    aria-hidden="true"
                  />
                  No Google calendars have synced yet.
                </div>
              ) : null}

              <UnassignedCalendars
                calendars={calendars.filter(
                  (calendar) =>
                    !calendar.accountId ||
                    !accounts.some(
                      (account) => account.accountId === calendar.accountId,
                    ),
                )}
                allCalendars={calendars}
                accounts={accounts}
              />
            </div>
          </SettingsTarget>
        </SettingsGroup>
      </SettingsSection>
      <ConfirmationDialog
        open={legacyConfirmationOpen}
        onOpenChange={setLegacyConfirmationOpen}
        eyebrow="Google authorization"
        title="Clear the old Google authorization?"
        description={LEGACY_CREDENTIAL_RECOVERY_CONFIRMATION}
        confirmLabel="Clear authorization"
        confirmTone="destructive"
        pending={busyAction === "clear-legacy"}
        pendingLabel="Clearing…"
        onConfirm={() => void clearLegacyCredentials()}
      />
    </>
  );
}

function GoogleAccountSection({
  account,
  calendars,
  allCalendars,
  busyAction,
  run,
}: {
  account: GoogleAccountStatus;
  calendars: readonly CalendarDoc[];
  allCalendars: readonly CalendarDoc[];
  busyAction: string | null;
  run(key: string, action: () => Promise<void>): Promise<void>;
}) {
  const desktop = useDesktopStatus();
  const reconnecting = busyAction === `reconnect:${account.accountId}`;
  const disconnecting = busyAction === `disconnect:${account.accountId}`;
  const syncing =
    busyAction === `sync:${account.accountId}` ||
    (account.state === "connected" && account.syncState === "syncing");
  const unavailable =
    busyAction !== null ||
    desktop?.google.kind !== "ready" ||
    desktop.google.oauthBusy;

  const reconnect = () =>
    run(`reconnect:${account.accountId}`, async () => {
      if (!desktop) return;
      try {
        await desktop.reconnectGoogleAccount(
          account.accountId as GoogleAccountId,
        );
      } catch {
        notify({ kind: "account-action-failed", action: "reconnect" });
      }
    });
  const disconnect = () =>
    run(`disconnect:${account.accountId}`, async () => {
      if (!desktop) return;
      try {
        await desktop.disconnectGoogleAccount(
          account.accountId as GoogleAccountId,
        );
      } catch {
        notify({ kind: "account-action-failed", action: "disconnect" });
      }
    });
  const sync = () =>
    run(`sync:${account.accountId}`, async () => {
      if (!desktop) return;
      try {
        await desktop.syncGoogleAccount(account.accountId as GoogleAccountId);
      } catch {
        notify({ kind: "account-action-failed", action: "sync" });
      }
    });

  return (
    <section
      aria-labelledby={`google-account-${account.accountId}`}
      className="py-1"
    >
      <header className="flex flex-col gap-3 px-1 py-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-xs font-medium text-foreground">
            {account.accountEmail.charAt(0).toUpperCase()}
          </span>
          <div className="min-w-0">
            <h2
              id={`google-account-${account.accountId}`}
              className="truncate text-sm font-medium text-foreground"
            >
              {account.accountEmail}
            </h2>
            <p
              className={cn(
                "mt-0.5 text-xs leading-5 text-muted-foreground",
                account.state === "reconnect-required" && "text-destructive",
              )}
            >
              {account.message ?? reconnectDescription(account)}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {account.state === "connected" ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={unavailable}
              aria-busy={syncing}
              onClick={() => void sync()}
            >
              <HugeiconsIcon
                icon={RefreshIcon}
                strokeWidth={2}
                className="size-3.5"
                aria-hidden="true"
              />
              {syncing ? "Syncing…" : "Sync"}
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              disabled={unavailable}
              aria-busy={reconnecting}
              onClick={() => void reconnect()}
            >
              <HugeiconsIcon
                icon={RefreshIcon}
                strokeWidth={2}
                className="size-3.5"
                aria-hidden="true"
              />
              {reconnecting ? "Reconnecting…" : "Reconnect"}
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-destructive"
            disabled={unavailable}
            aria-busy={disconnecting}
            onClick={() => void disconnect()}
          >
            {disconnecting ? "Disconnecting…" : "Disconnect"}
          </Button>
        </div>
      </header>
      {calendars.length > 0 ? (
        <CalendarList
          calendars={calendars}
          allCalendars={allCalendars}
          accountEmail={account.accountEmail}
        />
      ) : (
        <p className="px-1 py-3 text-xs leading-5 text-muted-foreground">
          No calendars from this account have synced yet.
        </p>
      )}
    </section>
  );
}

function UnassignedCalendars({
  calendars,
  allCalendars,
  accounts,
}: {
  calendars: readonly CalendarDoc[];
  allCalendars: readonly CalendarDoc[];
  accounts: readonly GoogleAccountStatus[];
}) {
  if (calendars.length === 0) return null;
  return (
    <section aria-labelledby="unassigned-calendars" className="py-1">
      <header className="px-1 py-2">
        <h2
          id="unassigned-calendars"
          className="text-sm font-medium text-foreground"
        >
          Calendars awaiting account assignment
        </h2>
        <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
          These locally available calendars will move into their Google account
          group after migration completes.
        </p>
      </header>
      <CalendarList
        calendars={calendars}
        allCalendars={allCalendars}
        accountEmail={
          accounts.length === 1 ? accounts[0]?.accountEmail : undefined
        }
      />
    </section>
  );
}

function CalendarList({
  calendars,
  allCalendars,
  accountEmail,
}: {
  calendars: readonly CalendarDoc[];
  allCalendars: readonly CalendarDoc[];
  accountEmail?: string;
}) {
  const setSelected = useMutation(api.calendar.setCalendarSelected);
  const setColor = useMutation(api.calendar.setCalendarColor);
  const sorted = [...calendars].sort((left, right) =>
    calendarDisplayName(left).localeCompare(calendarDisplayName(right)),
  );

  return (
    <div
      aria-label={
        accountEmail ? `${accountEmail} calendars` : "Synced calendars"
      }
      className="mt-1 px-1"
    >
      {sorted.map((calendar) => {
        const name = calendarLabelForAccount(
          calendar,
          allCalendars,
          accountEmail,
        );
        return (
          <div
            key={calendar._id}
            className="grid gap-3 border-b border-border/65 py-3.5 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
          >
            <label className="flex min-w-0 items-center gap-3">
              <Checkbox
                checked={calendar.selected}
                onCheckedChange={(checked) =>
                  void setSelected({
                    calendarId: calendar._id,
                    selected: checked === true,
                  })
                }
              />
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-foreground">
                  {name}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {calendar.primary
                    ? "Primary calendar"
                    : calendar.accessRole === "reader"
                      ? "Read only"
                      : "Can edit"}
                </span>
              </span>
            </label>
            <div
              role="group"
              aria-label={`${name} color`}
              className="flex flex-wrap items-center gap-1.5"
            >
              <button
                type="button"
                aria-label={`${name}: use Google color`}
                aria-pressed={calendar.colorOverride === undefined}
                onClick={() =>
                  void setColor({ calendarId: calendar._id, color: null })
                }
                className={cn(
                  "shadow-bevel flex size-6 items-center justify-center rounded-full border border-border bg-background focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--qali-accent-focus)]",
                  calendar.colorOverride === undefined &&
                    "ring-2 ring-foreground/70",
                )}
              >
                <span
                  className="block size-3.5 rounded-full"
                  style={{
                    backgroundColor: `var(${calendarColorVar({
                      googleCalendarId: calendar.googleCalendarId,
                      backgroundColor: calendar.backgroundColor,
                    })})`,
                  }}
                />
              </button>
              {CALENDAR_COLOR_CHOICES.map((choice) => (
                <button
                  key={choice.key}
                  type="button"
                  aria-label={`${name}: ${choice.key.replace("event-", "color ")}`}
                  aria-pressed={calendar.colorOverride === choice.key}
                  onClick={() =>
                    void setColor({
                      calendarId: calendar._id,
                      color: choice.key,
                    })
                  }
                  className={cn(
                    "size-6 rounded-full border-2 border-background ring-1 ring-border focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--qali-accent-focus)]",
                    calendar.colorOverride === choice.key &&
                      "ring-2 ring-foreground/70",
                  )}
                  style={{ backgroundColor: `var(${choice.colorVar})` }}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
