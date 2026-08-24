import { describe, expect, test } from "bun:test";

import { verifyGoogleAccounts } from "../src/main/google/account-reconciliation";

describe("Google account migration reconciliation", () => {
  test("restartably detaches legacy database rows when Keychain has no identity", async () => {
    const calls: unknown[] = [];
    let page = 0;
    const broker = {
      attachGoogleAccount: async () => {
        throw new Error("must not guess an identity");
      },
      auditGoogleAccountMigration: async () => {
        throw new Error("detached rows are not account-scoped");
      },
      migrateLegacyGoogleData: async (args: unknown) => {
        calls.push(args);
        page += 1;
        return page === 1
          ? { done: false, cursor: "detached-page-2", migrated: 50 }
          : { done: true, migrated: 4 };
      },
    };

    await verifyGoogleAccounts(broker, []);

    expect(calls).toEqual([{}, { cursor: "detached-page-2" }]);
  });

  test("a proven account first quarantines any late unassigned rows", async () => {
    const calls: string[] = [];
    const stages: string[] = [];
    let detachedSweepComplete = false;
    let accountRepairComplete = false;
    const broker = {
      attachGoogleAccount: async () => {
        calls.push("attach:proven");
        return { claimedLegacy: false };
      },
      auditGoogleAccountMigration: async () => {
        calls.push("audit:proven");
        return {
          done: true,
          checked: detachedSweepComplete && accountRepairComplete ? 0 : 1,
          violations: detachedSweepComplete && accountRepairComplete ? 0 : 1,
        };
      },
      migrateLegacyGoogleData: async (args: { accountId?: string }) => {
        if (args.accountId) {
          calls.push("migrate:proven");
          accountRepairComplete = true;
        } else {
          calls.push("migrate:detached");
          detachedSweepComplete = true;
        }
        return { done: true, migrated: 0 };
      },
    };

    await verifyGoogleAccounts(
      broker,
      [
        {
          accountEmail: "person@example.com",
          accountId: `gacc_${"a".repeat(43)}`,
          providerAccountId: "google-subject",
        },
      ],
      (stage) => stages.push(stage),
    );

    expect(calls).toEqual([
      "migrate:detached",
      "attach:proven",
      "migrate:proven",
      "audit:proven",
    ]);
    expect(stages).toEqual([
      "google-detached-migration",
      "google-account-attach",
      "google-account-migration",
      "google-account-audit",
    ]);
  });
});
