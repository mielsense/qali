import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { QaliKeychainRecord } from "../src/main/keychain/keychain";
import {
  GOOGLE_TOKEN_ENDPOINT,
  parseGoogleDesktopClientId,
  parseGooglePublicDesktopClient,
} from "../src/main/google/oauth-client-config";
import { GoogleOAuthBroker } from "../src/main/google/oauth-broker";

const resourcePath = resolve(
  import.meta.dir,
  "../resources/google-oauth-client.json",
);
const TEST_CLIENT_SECRET = "GOCSPX-qali_test_installed_secret_1234";
const publicClient = parseGooglePublicDesktopClient({
  clientId:
    "453413974502-e9ou9i10flj1u5fttlmkpq1lftmit4n6.apps.googleusercontent.com",
  clientSecret: TEST_CLIENT_SECRET,
});

async function nextEventLoopTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

class MemoryKeychain {
  beforeDelete: (account: QaliKeychainRecord) => Promise<void> = async () => {};
  readonly records = new Map<QaliKeychainRecord, string>();
  rejectDeleteFor: QaliKeychainRecord | null = null;

  async get(account: QaliKeychainRecord): Promise<string | null> {
    return this.records.get(account) ?? null;
  }

  async set(account: QaliKeychainRecord, value: string): Promise<void> {
    this.records.set(account, value);
  }

  async delete(account: QaliKeychainRecord): Promise<void> {
    await this.beforeDelete(account);
    if (account === this.rejectDeleteFor) {
      throw new Error("seeded-keychain-delete-failure");
    }
    this.records.delete(account);
  }
}

function seedLegacyConnection(
  keychain: MemoryKeychain,
  overrides: Partial<{ clientId: string; subject: string }> = {},
): void {
  keychain.records.set(
    "google-oauth-client-config",
    JSON.stringify({
      clientId: overrides.clientId ?? publicClient.clientId,
      clientSecret: "legacy-secret-must-never-enter-a-request",
      version: 1,
    }),
  );
  keychain.records.set("google-refresh-token", "legacy-refresh-token");
  keychain.records.set(
    "google-account-metadata",
    JSON.stringify({
      email: "legacy@example.com",
      subject: overrides.subject ?? "legacy-subject",
      version: 1,
    }),
  );
}

function verifiedMigrationFetch(
  options: {
    refreshToken?: string;
    subject?: string;
    tokenStatus?: number;
    userinfoStatus?: number;
  } = {},
): typeof fetch {
  return async (input, init) => {
    if (String(input) === GOOGLE_TOKEN_ENDPOINT) {
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("client_id")).toBe(publicClient.clientId);
      expect(body.get("refresh_token")).toBe("legacy-refresh-token");
      expect(body.get("client_secret")).toBe(publicClient.clientSecret);
      if (options.tokenStatus) {
        return new Response(null, { status: options.tokenStatus });
      }
      return Response.json({
        access_token: "verified-access-token",
        expires_in: 3_600,
        ...(options.refreshToken !== undefined
          ? { refresh_token: options.refreshToken }
          : {}),
        token_type: "Bearer",
      });
    }
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer verified-access-token",
    );
    if (options.userinfoStatus) {
      return new Response(null, { status: options.userinfoStatus });
    }
    return Response.json({
      email: "legacy@example.com",
      email_verified: true,
      sub: options.subject ?? "legacy-subject",
    });
  };
}

describe("release-owned Google public client", () => {
  test("keeps the public ID in source and constructs a strict installed-app credential", async () => {
    const source = JSON.parse(await readFile(resourcePath, "utf8"));

    expect(Object.keys(source)).toEqual(["clientId"]);
    expect(source.clientId).toBe(
      "453413974502-e9ou9i10flj1u5fttlmkpq1lftmit4n6.apps.googleusercontent.com",
    );
    expect(parseGoogleDesktopClientId(source)).toBe(source.clientId);
    expect(publicClient.clientSecret).toBe(TEST_CLIENT_SECRET);
  });

  test("rejects missing, placeholder, malformed, and extra-key resources", () => {
    for (const value of [
      { clientId: "replace-me" },
      { clientId: "not-a-google-client" },
      { clientId: publicClient.clientId },
      { clientId: publicClient.clientId, clientSecret: "replace-me" },
      { clientId: publicClient.clientId, unexpected: true },
    ]) {
      expect(() => parseGooglePublicDesktopClient(value)).toThrow(
        "GOOGLE_OAUTH_CLIENT_INVALID",
      );
    }
  });
});

describe("legacy Google credential migration", () => {
  test("a migration finishing after disconnect cannot republish its stale access token", async () => {
    const keychain = new MemoryKeychain();
    seedLegacyConnection(keychain);
    let releaseMigrationDelete!: () => void;
    let announceMigrationDelete!: () => void;
    const migrationDeleteStarted = new Promise<void>((resolve) => {
      announceMigrationDelete = resolve;
    });
    const migrationDeleteMayFinish = new Promise<void>((resolve) => {
      releaseMigrationDelete = resolve;
    });
    let legacyDeleteCount = 0;
    keychain.beforeDelete = async (record) => {
      if (record !== "google-oauth-client-config") return;
      legacyDeleteCount += 1;
      if (legacyDeleteCount === 1) {
        announceMigrationDelete();
        await migrationDeleteMayFinish;
      }
    };
    const broker = new GoogleOAuthBroker({
      client: publicClient,
      fetch: verifiedMigrationFetch(),
      keychain,
      openExternal: async () => {},
    });

    const migration = broker.migrateLegacyGoogleCredentials();
    await migrationDeleteStarted;
    const disconnect = broker.disconnect();
    await nextEventLoopTurn();
    releaseMigrationDelete();
    await migration.catch(() => {});
    await disconnect;

    await expect(broker.accessToken()).rejects.toThrow(
      "GOOGLE_OAUTH_NOT_CONNECTED",
    );
  });

  test("disconnect and reconnect cannot be overwritten by an older migration token", async () => {
    const keychain = new MemoryKeychain();
    seedLegacyConnection(keychain);
    let releaseMigrationDelete!: () => void;
    let announceMigrationDelete!: () => void;
    const migrationDeleteStarted = new Promise<void>((resolve) => {
      announceMigrationDelete = resolve;
    });
    const migrationDeleteMayFinish = new Promise<void>((resolve) => {
      releaseMigrationDelete = resolve;
    });
    let legacyDeleteCount = 0;
    keychain.beforeDelete = async (record) => {
      if (record !== "google-oauth-client-config") return;
      legacyDeleteCount += 1;
      if (legacyDeleteCount === 1) {
        announceMigrationDelete();
        await migrationDeleteMayFinish;
      }
    };
    let reconnecting = false;
    const broker = new GoogleOAuthBroker({
      client: publicClient,
      fetch: async (input, init) => {
        if (!reconnecting) return verifiedMigrationFetch()(input, init);
        const url = String(input);
        if (url === GOOGLE_TOKEN_ENDPOINT) {
          return Response.json({
            access_token: "fresh-access-token",
            expires_in: 3_600,
            refresh_token: "fresh-refresh-token",
            scope: publicClient.scopes.join(" "),
            token_type: "Bearer",
          });
        }
        if (url === "https://openidconnect.googleapis.com/v1/userinfo") {
          return Response.json({
            email: "fresh@example.com",
            email_verified: true,
            sub: "fresh-subject",
          });
        }
        if (url === "https://oauth2.googleapis.com/revoke") {
          return new Response(null, { status: 200 });
        }
        throw new Error("unexpected request");
      },
      keychain,
      openExternal: async (rawUrl) => {
        const authorizationUrl = new URL(rawUrl);
        const callback = new URL(
          authorizationUrl.searchParams.get("redirect_uri")!,
        );
        callback.searchParams.set("code", "fresh-code");
        callback.searchParams.set(
          "state",
          authorizationUrl.searchParams.get("state")!,
        );
        await fetch(callback);
      },
    });

    const migration = broker.migrateLegacyGoogleCredentials();
    await migrationDeleteStarted;
    const disconnect = broker.disconnect();
    await nextEventLoopTurn();
    releaseMigrationDelete();
    await migration.catch(() => {});
    await disconnect;
    reconnecting = true;
    await broker.connect();

    await expect(broker.accessToken()).resolves.toBe("fresh-access-token");
  });

  test("deletes the legacy client only after refresh, userinfo, and subject verification", async () => {
    const keychain = new MemoryKeychain();
    seedLegacyConnection(keychain);
    const originalClientRecord = keychain.records.get(
      "google-oauth-client-config",
    );
    const fetch = verifiedMigrationFetch();
    const broker = new GoogleOAuthBroker({
      client: publicClient,
      fetch: async (input, init) => {
        expect(keychain.records.get("google-oauth-client-config")).toBe(
          originalClientRecord,
        );
        return fetch(input, init);
      },
      keychain,
      openExternal: async () => {},
    });

    await expect(broker.migrateLegacyGoogleCredentials()).resolves.toEqual({
      accountSubject: "legacy-subject",
      kind: "migrated",
    });
    expect(keychain.records.has("google-oauth-client-config")).toBe(false);
    expect(keychain.records.has("google-refresh-token")).toBe(false);
    const migrated = [...keychain.records.entries()].find(([record]) =>
      record.startsWith("google-account-v2-"),
    );
    expect(JSON.parse(migrated?.[1] ?? "null")).toMatchObject({
      refreshToken: "legacy-refresh-token",
      subject: "legacy-subject",
      version: 2,
    });
    await expect(broker.migrateLegacyGoogleCredentials()).resolves.toEqual({
      kind: "not-needed",
    });
  });

  test("deduplicates concurrent matching migrations", async () => {
    const keychain = new MemoryKeychain();
    seedLegacyConnection(keychain);
    let tokenRequests = 0;
    const fetch = verifiedMigrationFetch();
    const broker = new GoogleOAuthBroker({
      client: publicClient,
      fetch: async (input, init) => {
        if (String(input) === GOOGLE_TOKEN_ENDPOINT) tokenRequests += 1;
        return fetch(input, init);
      },
      keychain,
      openExternal: async () => {},
    });

    await expect(
      Promise.all([
        broker.migrateLegacyGoogleCredentials(),
        broker.migrateLegacyGoogleCredentials(),
      ]),
    ).resolves.toEqual([
      { accountSubject: "legacy-subject", kind: "migrated" },
      { accountSubject: "legacy-subject", kind: "migrated" },
    ]);
    expect(tokenRequests).toBe(1);
  });

  test("preserves a rotated refresh token when legacy marker cleanup is deferred", async () => {
    const keychain = new MemoryKeychain();
    seedLegacyConnection(keychain);
    keychain.rejectDeleteFor = "google-oauth-client-config";
    const broker = new GoogleOAuthBroker({
      client: publicClient,
      fetch: verifiedMigrationFetch({ refreshToken: "rotated-refresh-token" }),
      keychain,
      openExternal: async () => {},
    });

    await expect(broker.migrateLegacyGoogleCredentials()).resolves.toEqual({
      accountSubject: "legacy-subject",
      kind: "cleanup-deferred",
    });
    expect(keychain.records.has("google-refresh-token")).toBe(false);
    const migrated = [...keychain.records.entries()].find(([record]) =>
      record.startsWith("google-account-v2-"),
    );
    expect(JSON.parse(migrated?.[1] ?? "null")).toMatchObject({
      refreshToken: "rotated-refresh-token",
      subject: "legacy-subject",
      version: 2,
    });
    expect(keychain.records.has("google-oauth-client-config")).toBe(true);
    await expect(broker.accessToken()).resolves.toBe("verified-access-token");
  });

  test("preserves all records on mismatch, orphan, refresh, userinfo, or subject failure", async () => {
    const cases = [
      {
        expected: { kind: "client-mismatch" },
        setup: (keychain: MemoryKeychain) =>
          seedLegacyConnection(keychain, {
            clientId: "999999999999-otherclientid.apps.googleusercontent.com",
          }),
        fetch: verifiedMigrationFetch(),
      },
      {
        expected: {
          kind: "verification-failed",
          reason: "credentials-unsafe",
        },
        setup: (keychain: MemoryKeychain) => {
          seedLegacyConnection(keychain);
          keychain.records.delete("google-account-metadata");
        },
        fetch: verifiedMigrationFetch(),
      },
      {
        expected: { kind: "verification-failed", reason: "refresh-failed" },
        setup: seedLegacyConnection,
        fetch: verifiedMigrationFetch({ refreshToken: "" }),
      },
      {
        expected: { kind: "verification-failed", reason: "refresh-failed" },
        setup: seedLegacyConnection,
        fetch: verifiedMigrationFetch({ tokenStatus: 401 }),
      },
      {
        expected: { kind: "verification-failed", reason: "identity-failed" },
        setup: seedLegacyConnection,
        fetch: verifiedMigrationFetch({ userinfoStatus: 401 }),
      },
      {
        expected: { kind: "verification-failed", reason: "subject-mismatch" },
        setup: seedLegacyConnection,
        fetch: verifiedMigrationFetch({ subject: "other-subject" }),
      },
    ] as const;

    for (const item of cases) {
      const keychain = new MemoryKeychain();
      item.setup(keychain);
      const original = new Map(keychain.records);
      const broker = new GoogleOAuthBroker({
        client: publicClient,
        fetch: item.fetch,
        keychain,
        openExternal: async () => {},
      });

      await expect(broker.migrateLegacyGoogleCredentials()).resolves.toEqual(
        item.expected,
      );
      expect(keychain.records).toEqual(original);
    }
  });

  test("surfaces a client mismatch as typed reconnect remediation", async () => {
    const keychain = new MemoryKeychain();
    seedLegacyConnection(keychain, {
      clientId: "999999999999-otherclientid.apps.googleusercontent.com",
    });
    const broker = new GoogleOAuthBroker({
      client: publicClient,
      fetch: verifiedMigrationFetch(),
      keychain,
      openExternal: async () => {},
    });

    await expect(broker.status()).resolves.toEqual({
      kind: "reconnect-required",
      reason: "client-mismatch",
    });
    expect(keychain.records.has("google-oauth-client-config")).toBe(true);
  });

  test("requires explicit cleanup when a mismatched legacy tuple is partial", async () => {
    const keychain = new MemoryKeychain();
    seedLegacyConnection(keychain, {
      clientId: "999999999999-otherclientid.apps.googleusercontent.com",
    });
    keychain.records.delete("google-account-metadata");
    const broker = new GoogleOAuthBroker({
      client: publicClient,
      fetch: verifiedMigrationFetch(),
      keychain,
      openExternal: async () => {},
    });

    await expect(broker.status()).resolves.toEqual({
      kind: "reconnect-required",
      reason: "client-mismatch",
    });
    expect(keychain.records.has("google-oauth-client-config")).toBe(true);
  });
});
