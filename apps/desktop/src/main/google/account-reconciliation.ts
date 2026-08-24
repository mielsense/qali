import type { GoogleAccountIdentity } from "./oauth-broker";

const GOOGLE_MIGRATION_PAGE_LIMIT = 10_000;

export type GoogleAccountReconciliationStage =
  | "google-detached-migration"
  | "google-account-attach"
  | "google-account-migration"
  | "google-account-audit";

type GoogleAccountMigrationDataStage =
  | "calendars"
  | "events"
  | "recurringSeries"
  | "calendarOperations";

type ReconciliationProgress = (
  stage: GoogleAccountReconciliationStage,
) => void;

export type GoogleAccountMigrationBroker = Readonly<{
  attachGoogleAccount(
    args: Readonly<{
      accountEmail?: string;
      accountId: string;
      providerAccountId: string;
    }>,
  ): Promise<Readonly<{ claimedLegacy: boolean }>>;
  migrateLegacyGoogleData(
    args: Readonly<{
      accountId?: string;
      providerAccountId?: string;
      cursor?: string;
    }>,
  ): Promise<
    Readonly<{
      done: boolean;
      cursor?: string;
      migrated: number;
    }>
  >;
  auditGoogleAccountMigration(
    args: Readonly<{
      accountId: string;
      cursor?: string;
    }>,
  ): Promise<
    Readonly<{
      done: boolean;
      cursor?: string;
      checked: number;
      violations: number;
      stage?: GoogleAccountMigrationDataStage;
    }>
  >;
}>;

async function migratePages(
  broker: GoogleAccountMigrationBroker,
  scope: Readonly<{ accountId?: string; providerAccountId?: string }>,
): Promise<void> {
  let cursor: string | undefined;
  for (let page = 0; page < GOOGLE_MIGRATION_PAGE_LIMIT; page += 1) {
    const result = await broker.migrateLegacyGoogleData({
      ...scope,
      ...(cursor === undefined ? {} : { cursor }),
    });
    if (result.done) return;
    if (!result.cursor || result.cursor === cursor) {
      throw new Error("GOOGLE_ACCOUNT_MIGRATION_STALLED");
    }
    cursor = result.cursor;
  }
  throw new Error("GOOGLE_ACCOUNT_MIGRATION_PAGE_LIMIT");
}

async function verifyAccount(
  broker: GoogleAccountMigrationBroker,
  identity: GoogleAccountIdentity,
  onProgress: ReconciliationProgress,
): Promise<void> {
  onProgress("google-account-attach");
  await broker.attachGoogleAccount({
    accountEmail: identity.accountEmail,
    accountId: identity.accountId,
    providerAccountId: identity.providerAccountId,
  });
  // The migration is intentionally restartable and scoped to the proven
  // connection. Run it even after the connection reached "complete": a prior
  // desktop generation may have left an operation in the old payload shape.
  // `belongsToClaimedLegacy` will repair rows already bound to this connection
  // without claiming identity-less rows once ownership is complete.
  onProgress("google-account-migration");
  await migratePages(broker, {
    accountId: identity.accountId,
    providerAccountId: identity.providerAccountId,
  });

  let cursor: string | undefined;
  let violations = 0;
  onProgress("google-account-audit");
  for (let page = 0; page < GOOGLE_MIGRATION_PAGE_LIMIT; page += 1) {
    const result = await broker.auditGoogleAccountMigration({
      accountId: identity.accountId,
      ...(cursor === undefined ? {} : { cursor }),
    });
    if (result.violations !== 0 && result.stage) {
      const safeStageCode = {
        calendars: "CALENDARS",
        events: "EVENTS",
        recurringSeries: "RECURRING_SERIES",
        calendarOperations: "CALENDAR_OPERATIONS",
      }[result.stage];
      throw new Error(
        `GOOGLE_ACCOUNT_MIGRATION_POSTCONDITION_${safeStageCode}`,
      );
    }
    violations += result.violations;
    if (result.done) {
      if (violations !== 0) {
        throw new Error("GOOGLE_ACCOUNT_MIGRATION_POSTCONDITION_FAILED");
      }
      return;
    }
    if (!result.cursor || result.cursor === cursor) {
      throw new Error("GOOGLE_ACCOUNT_MIGRATION_AUDIT_STALLED");
    }
    cursor = result.cursor;
  }
  throw new Error("GOOGLE_ACCOUNT_MIGRATION_AUDIT_PAGE_LIMIT");
}

/** Proves every identity before it can be exposed. With no identity, legacy
 * rows are attached to a paused detached connection instead of guessed onto
 * whichever Google account happens to connect next. */
export async function verifyGoogleAccounts(
  broker: GoogleAccountMigrationBroker,
  identities: readonly GoogleAccountIdentity[],
  onProgress: ReconciliationProgress = () => {},
): Promise<void> {
  // A legacy row can appear after an account was already marked migrated
  // (for example, an older desktop generation finishing a write during an
  // upgrade). Sweep those identity-less rows into the detached quarantine
  // before auditing any proven account. Never guess ownership from account
  // order or email.
  onProgress("google-detached-migration");
  await migratePages(broker, {});
  for (const identity of identities) {
    await verifyAccount(broker, identity, onProgress);
  }
}
