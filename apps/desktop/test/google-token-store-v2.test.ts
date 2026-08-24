import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import type { QaliKeychainRecord } from "../src/main/keychain/keychain";
import {
  GOOGLE_ACCOUNT_SLOT_RECORDS,
  GoogleTokenStore,
  googleAccountId,
} from "../src/main/google/token-store";
import {
  GOOGLE_REVOCATION_ENDPOINT,
  GOOGLE_TOKEN_ENDPOINT,
  loadDevelopmentGoogleClient,
} from "../src/main/google/oauth-client-config";
import { GoogleOAuthBroker } from "../src/main/google/oauth-broker";
import { resolve } from "node:path";

const TEST_GOOGLE_CLIENT_SECRET = "GOCSPX-TestCredentialForQali1234";
process.env.QALI_GOOGLE_OAUTH_CLIENT_SECRET = TEST_GOOGLE_CLIENT_SECRET;

class MemoryKeychain {
  readonly records = new Map<QaliKeychainRecord, string>();
  rejectDeleteFor: QaliKeychainRecord | null = null;

  async get(record: QaliKeychainRecord): Promise<string | null> {
    return this.records.get(record) ?? null;
  }

  async set(record: QaliKeychainRecord, value: string): Promise<void> {
    this.records.set(record, value);
  }

  async delete(record: QaliKeychainRecord): Promise<void> {
    if (record === this.rejectDeleteFor)
      throw new Error("seeded-delete-failure");
    this.records.delete(record);
  }
}

function connection(index: number) {
  return {
    account: {
      email: `person-${index}@example.com`,
      subject: `subject-${index}`,
    },
    refreshToken: `refresh-${index}`,
  };
}

describe("Google v2 account credential slots", () => {
  test("derives the backend-compatible versioned account ID from the Google subject", () => {
    expect(googleAccountId("subject-123")).toBe(
      "gacc_abnt2gG_xN1NFz4bgEljgydhfD2D9wHzlVU7OgcMk_E",
    );
  });

  test("stores one strict atomic v2 JSON value and deduplicates by subject", async () => {
    const keychain = new MemoryKeychain();
    const store = new GoogleTokenStore(keychain);

    const first = await store.save(connection(1));
    const updated = await store.save({
      account: { email: "renamed@example.com", subject: "subject-1" },
      refreshToken: "rotated-refresh",
    });

    expect(updated.accountId).toBe(first.accountId);
    expect(updated.slot).toBe(first.slot);
    expect(await store.list()).toHaveLength(1);
    expect(JSON.parse(keychain.records.get(first.slot)!)).toEqual({
      accountId: first.accountId,
      email: "renamed@example.com",
      refreshToken: "rotated-refresh",
      subject: "subject-1",
      version: 2,
    });
    expect(keychain.records.has("google-refresh-token")).toBe(false);
    expect(keychain.records.has("google-account-metadata")).toBe(false);
  });

  test("reads the exact account ID emitted by the first multi-account release and normalizes it", async () => {
    const keychain = new MemoryKeychain();
    const subject = "subject-from-first-multi-account-release";
    const previousAccountId = `gacc_${createHash("sha256")
      .update(subject, "utf8")
      .digest("base64url")}`;
    keychain.records.set(
      "google-account-v2-0",
      JSON.stringify({
        accountId: previousAccountId,
        email: "liveinhoney@gmail.com",
        refreshToken: "preserved-refresh-token",
        subject,
        version: 2,
      }),
    );

    const store = new GoogleTokenStore(keychain);
    const [account] = await store.list();

    expect(account).toMatchObject({
      account: { email: "liveinhoney@gmail.com", subject },
      accountId: googleAccountId(subject),
      refreshToken: "preserved-refresh-token",
      slot: "google-account-v2-0",
    });
    expect(account?.accountId).not.toBe(previousAccountId);

    await store.save({
      account: account!.account,
      refreshToken: account!.refreshToken,
    });
    expect(JSON.parse(keychain.records.get("google-account-v2-0")!)).toEqual({
      accountId: googleAccountId(subject),
      email: "liveinhoney@gmail.com",
      refreshToken: "preserved-refresh-token",
      subject,
      version: 2,
    });
  });

  test("rejects malformed, extra-key, and account-ID-mismatched slot records", async () => {
    for (const source of [
      "not-json",
      JSON.stringify({
        ...JSON.parse(
          JSON.stringify({
            accountId: googleAccountId("subject-1"),
            email: "person@example.com",
            refreshToken: "refresh",
            subject: "subject-1",
            version: 2,
          }),
        ),
        extra: true,
      }),
      JSON.stringify({
        accountId: googleAccountId("different-subject"),
        email: "person@example.com",
        refreshToken: "refresh",
        subject: "subject-1",
        version: 2,
      }),
    ]) {
      const keychain = new MemoryKeychain();
      keychain.records.set("google-account-v2-0", source);
      await expect(new GoogleTokenStore(keychain).list()).rejects.toThrow(
        "GOOGLE_CREDENTIALS_CORRUPT",
      );
    }
  });

  test("enforces the fixed eight-account cap without overwriting a slot", async () => {
    const keychain = new MemoryKeychain();
    const store = new GoogleTokenStore(keychain);
    for (let index = 0; index < 8; index += 1)
      await store.save(connection(index));
    const before = new Map(keychain.records);

    await expect(store.save(connection(8))).rejects.toThrow(
      "GOOGLE_ACCOUNT_LIMIT_REACHED",
    );
    expect(keychain.records).toEqual(before);
    expect(GOOGLE_ACCOUNT_SLOT_RECORDS).toHaveLength(8);
  });

  test("legacy migration writes and verifies v2 before cleanup and safely deduplicates a retry", async () => {
    const keychain = new MemoryKeychain();
    keychain.records.set(
      "google-oauth-client-config",
      JSON.stringify({
        clientId: "123456789-test.apps.googleusercontent.com",
        clientSecret: "legacy-only-secret",
        version: 1,
      }),
    );
    keychain.records.set("google-refresh-token", "legacy-refresh");
    keychain.records.set(
      "google-account-metadata",
      JSON.stringify({
        email: "legacy@example.com",
        subject: "legacy-subject",
        version: 1,
      }),
    );
    keychain.rejectDeleteFor = "google-oauth-client-config";
    const store = new GoogleTokenStore(keychain);
    const first = await store.inspectLegacy(
      "123456789-test.apps.googleusercontent.com",
    );
    if (first.kind !== "candidate") throw new Error("expected candidate");

    await expect(
      store.completeLegacyMigration(first.candidate, "rotated-refresh"),
    ).resolves.toBe("cleanup-deferred");
    expect(await store.list()).toHaveLength(1);
    expect((await store.list())[0]?.refreshToken).toBe("rotated-refresh");

    keychain.records.set("google-refresh-token", "legacy-refresh");
    keychain.records.set(
      "google-account-metadata",
      JSON.stringify({
        email: "legacy@example.com",
        subject: "legacy-subject",
        version: 1,
      }),
    );
    const retry = await store.inspectLegacy(
      "123456789-test.apps.googleusercontent.com",
    );
    if (retry.kind !== "candidate") throw new Error("expected retry candidate");
    await store.completeLegacyMigration(retry.candidate);

    expect(await store.list()).toHaveLength(1);
    expect((await store.list())[0]?.refreshToken).toBe("rotated-refresh");
  });

  test("a crash-left duplicate advances to the replacement token returned during verification", async () => {
    const keychain = new MemoryKeychain();
    const store = new GoogleTokenStore(keychain);
    const existing = await store.save({
      account: { email: "legacy@example.com", subject: "legacy-subject" },
      refreshToken: "legacy-refresh",
    });
    keychain.records.set(
      "google-oauth-client-config",
      JSON.stringify({
        clientId: "123456789-test.apps.googleusercontent.com",
        clientSecret: "legacy-only-secret",
        version: 1,
      }),
    );
    keychain.records.set("google-refresh-token", "legacy-refresh");
    keychain.records.set(
      "google-account-metadata",
      JSON.stringify({
        email: "legacy@example.com",
        subject: "legacy-subject",
        version: 1,
      }),
    );
    const inspected = await store.inspectLegacy(
      "123456789-test.apps.googleusercontent.com",
    );
    if (inspected.kind !== "candidate") throw new Error("expected candidate");

    await store.completeLegacyMigration(
      inspected.candidate,
      "verification-rotated-refresh",
    );

    expect((await store.loadAccount(existing.accountId))?.refreshToken).toBe(
      "verification-rotated-refresh",
    );
  });

  test("a crash-left duplicate preserves a v2 token that is already newer than legacy", async () => {
    const keychain = new MemoryKeychain();
    const store = new GoogleTokenStore(keychain);
    const existing = await store.save({
      account: { email: "legacy@example.com", subject: "legacy-subject" },
      refreshToken: "already-newer-v2-refresh",
    });
    keychain.records.set(
      "google-oauth-client-config",
      JSON.stringify({
        clientId: "123456789-test.apps.googleusercontent.com",
        clientSecret: "legacy-only-secret",
        version: 1,
      }),
    );
    keychain.records.set("google-refresh-token", "legacy-refresh");
    keychain.records.set(
      "google-account-metadata",
      JSON.stringify({
        email: "legacy@example.com",
        subject: "legacy-subject",
        version: 1,
      }),
    );
    const inspected = await store.inspectLegacy(
      "123456789-test.apps.googleusercontent.com",
    );
    if (inspected.kind !== "candidate") throw new Error("expected candidate");

    await store.completeLegacyMigration(
      inspected.candidate,
      "rotation-derived-from-stale-legacy",
    );

    expect((await store.loadAccount(existing.accountId))?.refreshToken).toBe(
      "already-newer-v2-refresh",
    );
  });
});

describe("Google multi-account token lifecycle", () => {
  test("keeps a first-release multi-account credential usable through the broker", async () => {
    const keychain = new MemoryKeychain();
    const subject = "subject-from-first-multi-account-release";
    keychain.records.set(
      "google-account-v2-0",
      JSON.stringify({
        accountId: `gacc_${createHash("sha256")
          .update(subject, "utf8")
          .digest("base64url")}`,
        email: "liveinhoney@gmail.com",
        refreshToken: "preserved-refresh-token",
        subject,
        version: 2,
      }),
    );
    const broker = new GoogleOAuthBroker({
      fetch: async (input) => {
        expect(String(input)).toBe(GOOGLE_TOKEN_ENDPOINT);
        return Response.json({
          access_token: "replacement-access-token",
          expires_in: 3_600,
          token_type: "Bearer",
        });
      },
      keychain,
      openExternal: async () => {},
    });
    const accountId = googleAccountId(subject);

    await expect(broker.listAccounts()).resolves.toEqual([
      { accountEmail: "liveinhoney@gmail.com", accountId },
    ]);
    await expect(broker.accessToken(accountId)).resolves.toBe(
      "replacement-access-token",
    );
  });

  test("lists verified accounts in fixed-slot order without credential metadata", async () => {
    const keychain = new MemoryKeychain();
    const store = new GoogleTokenStore(keychain);
    const first = await store.save(connection(4));
    const second = await store.save(connection(2));
    const broker = new GoogleOAuthBroker({
      keychain,
      openExternal: async () => {},
    });

    const accounts = await broker.listAccounts();
    const identities = await broker.listAccountIdentities();

    expect(accounts).toEqual([
      { accountEmail: "person-4@example.com", accountId: first.accountId },
      { accountEmail: "person-2@example.com", accountId: second.accountId },
    ]);
    expect(Object.isFrozen(accounts)).toBe(true);
    expect(accounts.every(Object.isFrozen)).toBe(true);
    expect(Object.keys(accounts[0]!).sort()).toEqual([
      "accountEmail",
      "accountId",
    ]);
    expect(JSON.stringify(accounts)).not.toMatch(
      /subject|refresh|slot|google-account-v2/,
    );
    expect(identities).toEqual([
      {
        accountEmail: "person-4@example.com",
        accountId: first.accountId,
        providerAccountId: "subject-4",
      },
      {
        accountEmail: "person-2@example.com",
        accountId: second.accountId,
        providerAccountId: "subject-2",
      },
    ]);
    expect(Object.isFrozen(identities)).toBe(true);
    expect(identities.every(Object.isFrozen)).toBe(true);
    await expect(broker.status(second.accountId)).resolves.toMatchObject({
      accountEmail: "person-2@example.com",
      kind: "connected",
    });
  });

  test("refreshes, caches, and disconnects accounts independently", async () => {
    const keychain = new MemoryKeychain();
    const store = new GoogleTokenStore(keychain);
    const first = await store.save(connection(1));
    const second = await store.save(connection(2));
    const refreshes: string[] = [];
    const revocations: string[] = [];
    const broker = new GoogleOAuthBroker({
      client: loadDevelopmentGoogleClient(
        resolve(import.meta.dir, "../resources/google-oauth-client.json"),
        TEST_GOOGLE_CLIENT_SECRET,
      ),
      fetch: async (input, init) => {
        const url = String(input);
        const body = new URLSearchParams(String(init?.body));
        if (url === GOOGLE_TOKEN_ENDPOINT) {
          const refreshToken = body.get("refresh_token")!;
          refreshes.push(refreshToken);
          return Response.json({
            access_token: `access-for-${refreshToken}`,
            expires_in: 3_600,
            token_type: "Bearer",
          });
        }
        if (url === GOOGLE_REVOCATION_ENDPOINT) {
          revocations.push(body.get("token")!);
          return new Response(null, { status: 200 });
        }
        throw new Error("unexpected request");
      },
      keychain,
      openExternal: async () => {},
    });

    await expect(
      Promise.all([
        broker.accessToken(first.accountId),
        broker.accessToken(second.accountId),
      ]),
    ).resolves.toEqual(["access-for-refresh-1", "access-for-refresh-2"]);
    expect(refreshes.sort()).toEqual(["refresh-1", "refresh-2"]);

    await broker.disconnect(first.accountId);
    expect(revocations).toEqual(["refresh-1"]);
    await expect(broker.accessToken(first.accountId)).rejects.toThrow(
      "GOOGLE_OAUTH_NOT_CONNECTED",
    );
    await expect(broker.accessToken(second.accountId)).resolves.toBe(
      "access-for-refresh-2",
    );
    expect((await store.list()).map((account) => account.accountId)).toEqual([
      second.accountId,
    ]);
  });

  test("requires an account ID when more than one account is connected", async () => {
    const keychain = new MemoryKeychain();
    const store = new GoogleTokenStore(keychain);
    await store.save(connection(1));
    await store.save(connection(2));
    const broker = new GoogleOAuthBroker({
      keychain,
      openExternal: async () => {},
    });

    await expect(broker.accessToken()).rejects.toThrow(
      "GOOGLE_ACCOUNT_ID_REQUIRED",
    );
    await expect(broker.disconnect()).rejects.toThrow(
      "GOOGLE_ACCOUNT_ID_REQUIRED",
    );
    expect(await store.list()).toHaveLength(2);
  });

  test("checks and drains only the account being disconnected", async () => {
    const keychain = new MemoryKeychain();
    const store = new GoogleTokenStore(keychain);
    const first = await store.save(connection(1));
    const second = await store.save(connection(2));
    const pendingAccounts: Array<string | undefined> = [];
    const drainedAccounts: Array<string | undefined> = [];
    const broker = new GoogleOAuthBroker({
      fetch: async () => new Response(null, { status: 200 }),
      keychain,
      openExternal: async () => {},
      pendingOperationCount: async (accountId) => {
        pendingAccounts.push(accountId);
        return 0;
      },
      stopSynchronization: async (accountId) => {
        drainedAccounts.push(accountId);
      },
    });

    await broker.disconnect(first.accountId);

    expect(pendingAccounts).toEqual([first.accountId]);
    expect(drainedAccounts).toEqual([first.accountId]);
    expect((await store.list()).map((account) => account.accountId)).toEqual([
      second.accountId,
    ]);
  });

  test("rejects a ninth add before opening a browser", async () => {
    const keychain = new MemoryKeychain();
    const store = new GoogleTokenStore(keychain);
    for (let index = 0; index < 8; index += 1)
      await store.save(connection(index));
    let opened = false;
    const broker = new GoogleOAuthBroker({
      keychain,
      openExternal: async () => {
        opened = true;
      },
    });

    await expect(broker.add()).rejects.toThrow("GOOGLE_ACCOUNT_LIMIT_REACHED");
    expect(opened).toBe(false);
    await expect(broker.listAccounts()).resolves.toEqual(
      Array.from({ length: 8 }, (_, index) => ({
        accountEmail: `person-${index}@example.com`,
        accountId: googleAccountId(`subject-${index}`),
      })),
    );
  });

  test("untargeted partial-legacy recovery revokes distinct grants and clears every Google record", async () => {
    const keychain = new MemoryKeychain();
    const store = new GoogleTokenStore(keychain);
    await store.save(connection(1));
    await store.save(connection(2));
    keychain.records.set("google-refresh-token", "legacy-orphan-refresh");
    keychain.records.set(
      "google-oauth-client-config",
      JSON.stringify({
        clientId: "123456789-test.apps.googleusercontent.com",
        clientSecret: "legacy-only-secret",
        version: 1,
      }),
    );
    const revoked: string[] = [];
    const broker = new GoogleOAuthBroker({
      fetch: async (_input, init) => {
        revoked.push(new URLSearchParams(String(init?.body)).get("token")!);
        return new Response(null, { status: 200 });
      },
      keychain,
      openExternal: async () => {},
    });

    await broker.disconnect();

    expect(revoked.sort()).toEqual([
      "legacy-orphan-refresh",
      "refresh-1",
      "refresh-2",
    ]);
    expect(
      [...keychain.records.keys()].filter((record) =>
        record.startsWith("google-"),
      ),
    ).toEqual([]);
  });

  test("untargeted marker-only recovery clears all accounts without requiring an account ID", async () => {
    const keychain = new MemoryKeychain();
    const store = new GoogleTokenStore(keychain);
    await store.save(connection(1));
    await store.save(connection(2));
    keychain.records.set(
      "google-oauth-client-config",
      JSON.stringify({
        clientId: "123456789-test.apps.googleusercontent.com",
        clientSecret: "legacy-only-secret",
        version: 1,
      }),
    );
    const broker = new GoogleOAuthBroker({
      fetch: async () => new Response(null, { status: 200 }),
      keychain,
      openExternal: async () => {},
    });

    await expect(broker.disconnect()).resolves.toBeUndefined();
    expect(await store.list()).toEqual([]);
    expect(keychain.records.has("google-oauth-client-config")).toBe(false);
  });

  test("exposes explicit legacy cleanup only when no modern account is connected", async () => {
    const keychain = new MemoryKeychain();
    keychain.records.set("google-refresh-token", "legacy-orphan-refresh");
    keychain.records.set(
      "google-oauth-client-config",
      JSON.stringify({
        clientId: "123456789-test.apps.googleusercontent.com",
        clientSecret: "legacy-only-secret",
        version: 1,
      }),
    );
    const broker = new GoogleOAuthBroker({
      fetch: async () => new Response(null, { status: 200 }),
      keychain,
      openExternal: async () => {},
    });

    await expect(broker.requiresLegacyCredentialRecovery()).resolves.toBe(true);
    await broker.clearLegacyCredentials();
    await expect(broker.requiresLegacyCredentialRecovery()).resolves.toBe(
      false,
    );
  });

  test("explicit legacy cleanup does not issue an ambiguous account-less pending-work query", async () => {
    const keychain = new MemoryKeychain();
    keychain.records.set("google-refresh-token", "legacy-orphan-refresh");
    keychain.records.set(
      "google-oauth-client-config",
      JSON.stringify({
        clientId: "123456789-test.apps.googleusercontent.com",
        clientSecret: "legacy-only-secret",
        version: 1,
      }),
    );
    let pendingQueries = 0;
    const broker = new GoogleOAuthBroker({
      fetch: async () => new Response(null, { status: 200 }),
      keychain,
      openExternal: async () => {},
      pendingOperationCount: async () => {
        pendingQueries += 1;
        throw new Error("ACCOUNT_SCOPE_REQUIRED");
      },
    });

    await expect(broker.clearLegacyCredentials()).resolves.toBeUndefined();
    expect(pendingQueries).toBe(0);
    await expect(broker.requiresLegacyCredentialRecovery()).resolves.toBe(
      false,
    );
  });
});
