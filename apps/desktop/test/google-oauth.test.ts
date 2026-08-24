import { describe, expect, test } from "bun:test";
import {
  GOOGLE_AUTHORIZATION_ENDPOINT,
  GOOGLE_CALENDAR_SCOPES,
  GOOGLE_REVOCATION_ENDPOINT,
  GOOGLE_TOKEN_ENDPOINT,
  parseGooglePublicDesktopClient,
} from "../src/main/google/oauth-client-config";
import { createPkceMaterial } from "../src/main/google/pkce";
import { GoogleTokenStore } from "../src/main/google/token-store";
import type { QaliKeychainRecord } from "../src/main/keychain/keychain";
import type { GoogleDesktopClient } from "../src/main/google/oauth-client-config";

const TEST_GOOGLE_DESKTOP_CLIENT: GoogleDesktopClient =
  parseGooglePublicDesktopClient({
    clientId:
      "453413974502-e9ou9i10flj1u5fttlmkpq1lftmit4n6.apps.googleusercontent.com",
    clientSecret: "GOCSPX-qali_test_installed_secret_1234",
  });
const LEGACY_CLIENT_SECRET = "legacy-secret-must-never-enter-a-request";
process.env.QALI_GOOGLE_OAUTH_CLIENT_SECRET =
  TEST_GOOGLE_DESKTOP_CLIENT.clientSecret;

const { GoogleOAuthBroker, consumeOAuthCancellation, consumeOAuthCallback } =
  await import("../src/main/google/oauth-broker");
type OAuthCallbackAttempt =
  import("../src/main/google/oauth-broker").OAuthCallbackAttempt;

class MemoryKeychain {
  beforeSet: (account: QaliKeychainRecord, value: string) => Promise<void> =
    async () => {};
  readonly records = new Map<QaliKeychainRecord, string>();
  rejectDeleteFor: QaliKeychainRecord | null = null;
  rejectSetFor: QaliKeychainRecord | null = null;

  async get(account: QaliKeychainRecord): Promise<string | null> {
    return this.records.get(account) ?? null;
  }

  async set(account: QaliKeychainRecord, value: string): Promise<void> {
    if (account === this.rejectSetFor)
      throw new Error("seeded-keychain-failure");
    await this.beforeSet(account, value);
    this.records.set(account, value);
  }

  async delete(account: QaliKeychainRecord): Promise<void> {
    if (account === this.rejectDeleteFor)
      throw new Error("seeded-keychain-delete-failure");
    this.records.delete(account);
  }
}

function storedV2Accounts(keychain: MemoryKeychain) {
  return [...keychain.records.entries()]
    .filter(([record]) => record.startsWith("google-account-v2-"))
    .map(
      ([, source]) =>
        JSON.parse(source) as {
          accountId: string;
          email: string;
          refreshToken: string;
          subject: string;
          version: 2;
        },
    );
}

async function nextEventLoopTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function callbackAttempt(
  overrides: Partial<OAuthCallbackAttempt> = {},
): OAuthCallbackAttempt {
  return {
    callbackPath: "/oauth/google/callback/attempt-1",
    consumed: false,
    expiresAt: 2_000,
    expectedHost: "127.0.0.1:43123",
    state: "seeded-state",
    ...overrides,
  };
}

function callbackRequest(
  overrides: Partial<{ host: string; method: string; url: string }> = {},
) {
  return {
    host: "127.0.0.1:43123",
    method: "GET",
    url: "/oauth/google/callback/attempt-1?code=seeded-code&state=seeded-state",
    ...overrides,
  };
}

function googleFetch(
  account: { email: string; sub: string },
  calls: string[],
  grantedScopes: readonly string[] = GOOGLE_CALENDAR_SCOPES,
) {
  return async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = String(input);
    calls.push(url);
    if (url === GOOGLE_TOKEN_ENDPOINT) {
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("code_verifier")).toBeTruthy();
      expect(body.get("client_secret")).toBe(
        TEST_GOOGLE_DESKTOP_CLIENT.clientSecret,
      );
      expect(body.has("seeded-state")).toBe(false);
      return Response.json({
        access_token: "seeded-access-token",
        expires_in: 3_600,
        refresh_token: `refresh-for-${account.sub}`,
        scope: grantedScopes.join(" "),
        token_type: "Bearer",
      });
    }
    if (url === "https://openidconnect.googleapis.com/v1/userinfo") {
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer seeded-access-token",
      );
      return Response.json({
        email: account.email,
        email_verified: true,
        sub: account.sub,
      });
    }
    if (url === "https://oauth2.googleapis.com/revoke") {
      return new Response(null, { status: 200 });
    }
    throw new Error("unexpected request");
  };
}

function browserCompletesCallback(openedUrls: URL[]) {
  return async (rawUrl: string): Promise<void> => {
    const authorizationUrl = new URL(rawUrl);
    openedUrls.push(authorizationUrl);
    const callback = new URL(
      authorizationUrl.searchParams.get("redirect_uri")!,
    );
    callback.searchParams.set("code", "seeded-code");
    callback.searchParams.set(
      "state",
      authorizationUrl.searchParams.get("state")!,
    );
    const response = await fetch(callback);
    expect(response.status).toBe(200);
  };
}

describe("Google desktop OAuth client configuration", () => {
  test("defines a strict built-in installed-app configuration", () => {
    const client = TEST_GOOGLE_DESKTOP_CLIENT;

    expect(client.authorizationEndpoint).toBe(GOOGLE_AUTHORIZATION_ENDPOINT);
    expect(client.tokenEndpoint).toBe(GOOGLE_TOKEN_ENDPOINT);
    expect(client.scopes).toEqual(GOOGLE_CALENDAR_SCOPES);
    expect(client.scopes).toHaveLength(5);
  });
});

describe("Google OAuth credential storage", () => {
  const account = JSON.stringify({
    email: "first@example.com",
    subject: "subject-first",
    version: 1,
  });

  test("loads a legacy three-record connection without deleting it before verification", async () => {
    const keychain = new MemoryKeychain();
    keychain.records.set(
      "google-oauth-client-config",
      JSON.stringify({
        clientId: TEST_GOOGLE_DESKTOP_CLIENT.clientId,
        clientSecret: LEGACY_CLIENT_SECRET,
        version: 1,
      }),
    );
    keychain.records.set("google-refresh-token", "seeded-refresh-token");
    keychain.records.set("google-account-metadata", account);

    await expect(new GoogleTokenStore(keychain).load()).resolves.toMatchObject({
      account: { email: "first@example.com", subject: "subject-first" },
      refreshToken: "seeded-refresh-token",
    });
    expect(keychain.records.has("google-oauth-client-config")).toBe(true);
    expect(keychain.records.has("google-refresh-token")).toBe(true);
    expect(keychain.records.has("google-account-metadata")).toBe(true);
  });

  test("reports a mismatch or corrupt legacy client without deleting credentials", async () => {
    for (const legacy of [
      "not-json",
      JSON.stringify({
        clientId: "other.apps.googleusercontent.com",
        clientSecret: LEGACY_CLIENT_SECRET,
        version: 1,
      }),
    ]) {
      const keychain = new MemoryKeychain();
      keychain.records.set("google-oauth-client-config", legacy);
      keychain.records.set("google-refresh-token", "seeded-refresh-token");
      keychain.records.set("google-account-metadata", account);
      const original = new Map(keychain.records);

      const inspection = await new GoogleTokenStore(keychain).inspectLegacy(
        TEST_GOOGLE_DESKTOP_CLIENT.clientId,
      );
      expect(inspection.kind).toMatch(/client-mismatch|incomplete-or-corrupt/);
      expect(keychain.records).toEqual(original);
    }
  });

  test("loads the two-record state without a legacy client record", async () => {
    const keychain = new MemoryKeychain();
    keychain.records.set("google-refresh-token", "seeded-refresh-token");
    keychain.records.set("google-account-metadata", account);

    await expect(new GoogleTokenStore(keychain).load()).resolves.toMatchObject({
      account: { email: "first@example.com", subject: "subject-first" },
      refreshToken: "seeded-refresh-token",
    });
  });

  test("clears both two-record and legacy OAuth storage", async () => {
    const keychain = new MemoryKeychain();
    keychain.records.set("google-oauth-client-config", "legacy-client");
    keychain.records.set("google-refresh-token", "seeded-refresh-token");
    keychain.records.set("google-account-metadata", account);

    await new GoogleTokenStore(keychain).clear();
    expect(keychain.records.has("google-oauth-client-config")).toBe(false);
    expect(keychain.records.has("google-refresh-token")).toBe(false);
    expect(keychain.records.has("google-account-metadata")).toBe(false);
  });
});

describe("Google OAuth callback and PKCE", () => {
  test("creates 256-bit state and PKCE S256 material", () => {
    const material = createPkceMaterial((size) => Buffer.alloc(size, 0xa5));

    expect(material.state).toHaveLength(43);
    expect(material.verifier).toHaveLength(43);
    expect(material.challenge).toHaveLength(43);
    expect(material.challenge).not.toBe(material.verifier);
  });

  test("callback is one-time and exact", () => {
    const attempt = callbackAttempt();

    expect(() =>
      consumeOAuthCallback(
        attempt,
        callbackRequest({ host: "evil.invalid" }),
        1_000,
      ),
    ).toThrow("OAUTH_CALLBACK_REJECTED");
    expect(consumeOAuthCallback(attempt, callbackRequest(), 1_000)).toEqual({
      code: "seeded-code",
      consumed: true,
    });
    expect(() =>
      consumeOAuthCallback(attempt, callbackRequest(), 1_000),
    ).toThrow("OAUTH_CALLBACK_REPLAY");
  });

  test("callback rejects the wrong method, path, state, duplicate values, and expiry", () => {
    for (const request of [
      callbackRequest({ method: "POST" }),
      callbackRequest({ url: "/oauth/google/other?code=x&state=seeded-state" }),
      callbackRequest({
        url: "/oauth/google/callback/attempt-1?code=x&state=wrong",
      }),
      callbackRequest({
        url: "/oauth/google/callback/attempt-1?code=x&code=y&state=seeded-state",
      }),
    ]) {
      expect(() =>
        consumeOAuthCallback(callbackAttempt(), request, 1_000),
      ).toThrow("OAUTH_CALLBACK_REJECTED");
    }
    expect(() =>
      consumeOAuthCallback(callbackAttempt(), callbackRequest(), 2_001),
    ).toThrow("OAUTH_CALLBACK_EXPIRED");
  });

  test("only one of two racing valid callbacks can consume an attempt", async () => {
    const attempt = callbackAttempt();
    const outcomes = await Promise.allSettled([
      Promise.resolve().then(() =>
        consumeOAuthCallback(attempt, callbackRequest(), 1_000),
      ),
      Promise.resolve().then(() =>
        consumeOAuthCallback(attempt, callbackRequest(), 1_000),
      ),
    ]);

    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      outcomes.filter((outcome) => outcome.status === "rejected"),
    ).toHaveLength(1);
  });

  test("accepts only an exact state-bound provider cancellation once", () => {
    const attempt = callbackAttempt();
    expect(() =>
      consumeOAuthCancellation(
        attempt,
        callbackRequest({
          url: "/oauth/google/callback/attempt-1?error=access_denied&state=wrong",
        }),
        1_000,
      ),
    ).toThrow("OAUTH_CALLBACK_REJECTED");
    expect(
      consumeOAuthCancellation(
        attempt,
        callbackRequest({
          url: "/oauth/google/callback/attempt-1?error=access_denied&state=seeded-state",
        }),
        1_000,
      ),
    ).toEqual({ consumed: true });
    expect(() =>
      consumeOAuthCancellation(attempt, callbackRequest(), 1_000),
    ).toThrow("OAUTH_CALLBACK_REPLAY");
  });
});

describe("GoogleOAuthBroker", () => {
  test("serializes every add and reconnect browser flow globally", async () => {
    const keychain = new MemoryKeychain();
    let announceBrowser!: () => void;
    let releaseBrowser!: () => void;
    const browserStarted = new Promise<void>((resolve) => {
      announceBrowser = resolve;
    });
    const browserMayFinish = new Promise<void>((resolve) => {
      releaseBrowser = resolve;
    });
    const complete = browserCompletesCallback([]);
    const broker = new GoogleOAuthBroker({
      fetch: googleFetch(
        { email: "first@example.com", sub: "subject-first" },
        [],
      ),
      keychain,
      openExternal: async (url) => {
        announceBrowser();
        await browserMayFinish;
        await complete(url);
      },
    });

    const first = broker.add();
    await browserStarted;
    await expect(broker.add()).rejects.toThrow(
      "GOOGLE_OAUTH_CONNECT_IN_PROGRESS",
    );
    releaseBrowser();
    await expect(first).resolves.toMatchObject({ kind: "connected" });
  });

  test("accepts Google's canonical userinfo.email spelling in a token response", async () => {
    const keychain = new MemoryKeychain();
    const canonicalScopes = [
      "openid",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
      "https://www.googleapis.com/auth/calendar.events",
      "https://www.googleapis.com/auth/calendar.freebusy",
    ];
    const broker = new GoogleOAuthBroker({
      fetch: googleFetch(
        { email: "first@example.com", sub: "subject-first" },
        [],
        canonicalScopes,
      ),
      keychain,
      openExternal: browserCompletesCallback([]),
    });

    const canonicalConnection = await broker.connect();
    expect(canonicalConnection).toMatchObject({
      accountEmail: "first@example.com",
      kind: "connected",
    });
  });

  test("rejects previously granted Contacts or Drive scopes without storing credentials", async () => {
    for (const extraScope of [
      "https://www.googleapis.com/auth/contacts",
      "https://www.googleapis.com/auth/drive.metadata.readonly",
    ]) {
      const keychain = new MemoryKeychain();
      const broker = new GoogleOAuthBroker({
        fetch: googleFetch(
          { email: "first@example.com", sub: "subject-first" },
          [],
          [...GOOGLE_CALENDAR_SCOPES, extraScope],
        ),
        keychain,
        openExternal: browserCompletesCallback([]),
      });

      await expect(broker.connect()).rejects.toThrow(
        "GOOGLE_OAUTH_SCOPE_NOT_ALLOWED",
      );
      expect(keychain.records.size).toBe(0);
    }
  });

  test("connects without a picker or readFile dependency and opens the exact loopback PKCE request", async () => {
    const keychain = new MemoryKeychain();
    const openedUrls: URL[] = [];
    const calls: string[] = [];
    const broker = new GoogleOAuthBroker({
      fetch: googleFetch(
        { email: "first@example.com", sub: "subject-first" },
        calls,
      ),
      keychain,
      now: () => 10_000,
      openExternal: browserCompletesCallback(openedUrls),
    });

    await expect(broker.connect()).resolves.toMatchObject({
      accountEmail: "first@example.com",
      kind: "connected",
    });

    const authorizationUrl = openedUrls[0]!;
    const redirect = new URL(
      authorizationUrl.searchParams.get("redirect_uri")!,
    );
    expect(authorizationUrl.origin + authorizationUrl.pathname).toBe(
      GOOGLE_AUTHORIZATION_ENDPOINT,
    );
    expect(authorizationUrl.searchParams.get("client_id")).toBe(
      TEST_GOOGLE_DESKTOP_CLIENT.clientId,
    );
    expect(redirect.hostname).toBe("127.0.0.1");
    expect(Number(redirect.port)).toBeGreaterThan(0);
    expect(authorizationUrl.searchParams.get("access_type")).toBe("offline");
    expect(authorizationUrl.searchParams.get("prompt")).toBe(
      "consent select_account",
    );
    expect(authorizationUrl.searchParams.get("include_granted_scopes")).toBe(
      "true",
    );
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe(
      "S256",
    );
    expect(authorizationUrl.searchParams.get("scope")?.split(" ")).toEqual(
      GOOGLE_CALENDAR_SCOPES,
    );
    expect(calls).not.toContain("https://evil.invalid/token");
    expect([...keychain.records.values()].join(" ")).not.toContain(
      "seeded-access-token",
    );
  });

  test("keeps Google token rejections bounded but specific enough to remediate", async () => {
    for (const [providerError, expectedCode] of [
      ["invalid_client", "GOOGLE_OAUTH_PROVIDER_INVALID_CLIENT"],
      ["unauthorized_client", "GOOGLE_OAUTH_PROVIDER_UNAUTHORIZED_CLIENT"],
      ["invalid_grant", "GOOGLE_OAUTH_PROVIDER_INVALID_GRANT"],
      ["invalid_scope", "GOOGLE_OAUTH_PROVIDER_INVALID_SCOPE"],
      ["access_denied", "GOOGLE_OAUTH_PROVIDER_ACCESS_DENIED"],
    ] as const) {
      const broker = new GoogleOAuthBroker({
        fetch: async (input) => {
          if (String(input) !== GOOGLE_TOKEN_ENDPOINT) {
            throw new Error("unexpected request");
          }
          return Response.json(
            {
              error: providerError,
              error_description: "provider detail must remain private",
            },
            { status: 400 },
          );
        },
        keychain: new MemoryKeychain(),
        openExternal: browserCompletesCallback([]),
      });

      await expect(broker.connect()).rejects.toThrow(expectedCode);
    }
  });

  test("adds a second account without replacing the first account", async () => {
    const keychain = new MemoryKeychain();
    const openedUrls: URL[] = [];
    let account = { email: "first@example.com", sub: "subject-first" };
    const broker = new GoogleOAuthBroker({
      fetch: (input, init) => googleFetch(account, [])(input, init),
      keychain,
      openExternal: browserCompletesCallback(openedUrls),
    });

    const first = await broker.add();
    account = { email: "second@example.com", sub: "subject-second" };

    const second = await broker.add();
    expect(first.accountId).not.toBe(second.accountId);
    expect(storedV2Accounts(keychain)).toEqual([
      expect.objectContaining({ subject: "subject-first" }),
      expect.objectContaining({ subject: "subject-second" }),
    ]);
  });

  test("an account-only modern tuple permits only a same-subject reconnect", async () => {
    const keychain = new MemoryKeychain();
    keychain.records.set(
      "google-account-metadata",
      JSON.stringify({
        email: "stored@example.com",
        subject: "stored-subject",
        version: 1,
      }),
    );
    const openedUrls: URL[] = [];
    const broker = new GoogleOAuthBroker({
      fetch: googleFetch(
        { email: "fresh@example.com", sub: "stored-subject" },
        [],
      ),
      keychain,
      openExternal: browserCompletesCallback(openedUrls),
    });

    await expect(broker.status()).resolves.toEqual({
      kind: "reconnect-required",
      reason: "credentials-incomplete",
    });
    await expect(broker.connect()).resolves.toMatchObject({
      accountEmail: "fresh@example.com",
      kind: "connected",
    });
    expect(openedUrls).toHaveLength(1);
    expect(storedV2Accounts(keychain)).toEqual([
      expect.objectContaining({
        refreshToken: "refresh-for-stored-subject",
        subject: "stored-subject",
      }),
    ]);
  });

  test("refresh-only and corrupt modern tuples require cleanup before opening a browser", async () => {
    for (const setup of [
      (keychain: MemoryKeychain) => {
        keychain.records.set("google-refresh-token", "orphan-refresh-token");
      },
      (keychain: MemoryKeychain) => {
        keychain.records.set("google-refresh-token", "stored-refresh-token");
        keychain.records.set("google-account-metadata", "corrupt-account");
      },
    ]) {
      const keychain = new MemoryKeychain();
      setup(keychain);
      const openedUrls: URL[] = [];
      const broker = new GoogleOAuthBroker({
        fetch: googleFetch(
          { email: "fresh@example.com", sub: "fresh-subject" },
          [],
        ),
        keychain,
        openExternal: browserCompletesCallback(openedUrls),
      });

      await expect(broker.status()).resolves.toEqual({
        kind: "reconnect-required",
        reason: "credentials-unsafe",
      });
      await expect(broker.connect()).rejects.toThrow(
        "GOOGLE_OAUTH_DISCONNECT_REQUIRED",
      );
      expect(openedUrls).toHaveLength(0);
    }
  });

  test("reconnecting the same Google subject refreshes its account metadata", async () => {
    const keychain = new MemoryKeychain();
    let account = { email: "old@example.com", sub: "subject-stable" };
    const broker = new GoogleOAuthBroker({
      fetch: (input, init) => googleFetch(account, [])(input, init),
      keychain,
      openExternal: browserCompletesCallback([]),
    });

    await broker.connect();
    account = { email: "new@example.com", sub: "subject-stable" };
    await expect(broker.connect()).resolves.toMatchObject({
      accountEmail: "new@example.com",
      kind: "connected",
    });
    expect(await broker.status()).toMatchObject({
      accountEmail: "new@example.com",
      kind: "connected",
    });
  });

  test("reconnect preserves the selected slot when Google returns another subject", async () => {
    const keychain = new MemoryKeychain();
    let account = { email: "first@example.com", sub: "subject-first" };
    const calls: string[] = [];
    const broker = new GoogleOAuthBroker({
      fetch: (input, init) => googleFetch(account, calls)(input, init),
      keychain,
      openExternal: browserCompletesCallback([]),
    });
    const first = await broker.add();
    const before = new Map(keychain.records);
    account = { email: "other@example.com", sub: "subject-other" };

    await expect(broker.reconnect(first.accountId)).rejects.toThrow(
      "GOOGLE_OAUTH_ACCOUNT_MISMATCH",
    );
    expect(keychain.records).toEqual(before);
    expect(calls).toContain(GOOGLE_REVOCATION_ENDPOINT);
  });

  test("an orphaned legacy tuple recovers through explicit cleanup before browser connection", async () => {
    const keychain = new MemoryKeychain();
    keychain.records.set(
      "google-oauth-client-config",
      JSON.stringify({
        clientId: TEST_GOOGLE_DESKTOP_CLIENT.clientId,
        clientSecret: LEGACY_CLIENT_SECRET,
        version: 1,
      }),
    );
    keychain.records.set("google-refresh-token", "orphaned-refresh-token");
    const openedUrls: URL[] = [];
    const calls: string[] = [];
    const broker = new GoogleOAuthBroker({
      fetch: googleFetch(
        { email: "recovered@example.com", sub: "subject-recovered" },
        calls,
      ),
      keychain,
      openExternal: browserCompletesCallback(openedUrls),
    });

    await expect(broker.status()).resolves.toEqual({
      kind: "reconnect-required",
      reason: "credentials-unsafe",
    });
    await expect(broker.connect()).rejects.toThrow(
      "GOOGLE_OAUTH_DISCONNECT_REQUIRED",
    );
    expect(openedUrls).toHaveLength(0);
    await expect(broker.disconnect()).resolves.toBeUndefined();
    expect(calls).toContain("https://oauth2.googleapis.com/revoke");
    await expect(broker.connect()).resolves.toMatchObject({
      accountEmail: "recovered@example.com",
      kind: "connected",
    });
    expect(keychain.records.has("google-oauth-client-config")).toBe(false);
    expect(storedV2Accounts(keychain)).toEqual([
      expect.objectContaining({
        refreshToken: "refresh-for-subject-recovered",
        subject: "subject-recovered",
      }),
    ]);
  });

  test("a corrupt legacy marker cannot hide a different stored account subject", async () => {
    const keychain = new MemoryKeychain();
    keychain.records.set("google-oauth-client-config", "corrupt-marker");
    keychain.records.set("google-refresh-token", "stored-refresh-token");
    keychain.records.set(
      "google-account-metadata",
      JSON.stringify({
        email: "stored@example.com",
        subject: "stored-subject",
        version: 1,
      }),
    );
    const openedUrls: URL[] = [];
    const broker = new GoogleOAuthBroker({
      fetch: googleFetch(
        { email: "different@example.com", sub: "different-subject" },
        [],
      ),
      keychain,
      openExternal: browserCompletesCallback(openedUrls),
    });

    await expect(broker.connect()).rejects.toThrow(
      "GOOGLE_OAUTH_DISCONNECT_REQUIRED",
    );
    expect(openedUrls).toHaveLength(0);
    expect(keychain.records.get("google-refresh-token")).toBe(
      "stored-refresh-token",
    );
    expect(keychain.records.get("google-account-metadata")).toContain(
      "stored-subject",
    );
  });

  test("does not report connected when deferred marker cleanup leaves fresh credentials unloadable", async () => {
    const keychain = new MemoryKeychain();
    keychain.records.set(
      "google-oauth-client-config",
      JSON.stringify({
        clientId: TEST_GOOGLE_DESKTOP_CLIENT.clientId,
        clientSecret: LEGACY_CLIENT_SECRET,
        version: 1,
      }),
    );
    keychain.records.set(
      "google-account-metadata",
      JSON.stringify({
        email: "stable@example.com",
        subject: "stable-subject",
        version: 1,
      }),
    );
    keychain.beforeSet = async (account) => {
      if (account.startsWith("google-account-v2-")) {
        keychain.records.set("google-oauth-client-config", "corrupt-marker");
      }
    };
    keychain.rejectDeleteFor = "google-oauth-client-config";
    const broker = new GoogleOAuthBroker({
      fetch: googleFetch(
        { email: "stable@example.com", sub: "stable-subject" },
        [],
      ),
      keychain,
      openExternal: browserCompletesCallback([]),
    });

    await expect(broker.connect()).rejects.toThrow(
      "GOOGLE_OAUTH_CLEANUP_REQUIRED",
    );
    expect(storedV2Accounts(keychain)).toEqual([
      expect.objectContaining({
        refreshToken: "refresh-for-stable-subject",
        subject: "stable-subject",
      }),
    ]);
    await expect(broker.status()).resolves.toEqual({
      kind: "reconnect-required",
      reason: "credentials-unsafe",
    });
  });

  test("does not report connected when deferred cleanup leaves a marker bound to another client", async () => {
    const keychain = new MemoryKeychain();
    keychain.records.set(
      "google-oauth-client-config",
      JSON.stringify({
        clientId: TEST_GOOGLE_DESKTOP_CLIENT.clientId,
        clientSecret: LEGACY_CLIENT_SECRET,
        version: 1,
      }),
    );
    keychain.records.set(
      "google-account-metadata",
      JSON.stringify({
        email: "stable@example.com",
        subject: "stable-subject",
        version: 1,
      }),
    );
    keychain.beforeSet = async (account) => {
      if (account.startsWith("google-account-v2-")) {
        keychain.records.set(
          "google-oauth-client-config",
          JSON.stringify({
            clientId: "999999999999-otherclientid.apps.googleusercontent.com",
            clientSecret: LEGACY_CLIENT_SECRET,
            version: 1,
          }),
        );
      }
    };
    keychain.rejectDeleteFor = "google-oauth-client-config";
    const broker = new GoogleOAuthBroker({
      fetch: googleFetch(
        { email: "stable@example.com", sub: "stable-subject" },
        [],
      ),
      keychain,
      openExternal: browserCompletesCallback([]),
    });

    await expect(broker.connect()).rejects.toThrow(
      "GOOGLE_OAUTH_CLEANUP_REQUIRED",
    );
    expect(storedV2Accounts(keychain)).toEqual([
      expect.objectContaining({
        refreshToken: "refresh-for-stable-subject",
        subject: "stable-subject",
      }),
    ]);
    await expect(broker.status()).resolves.toEqual({
      kind: "reconnect-required",
      reason: "client-mismatch",
    });
  });

  test("a client mismatch requires explicit cleanup and revokes the old grant before reconnect", async () => {
    const keychain = new MemoryKeychain();
    keychain.records.set(
      "google-oauth-client-config",
      JSON.stringify({
        clientId: "999999999999-otherclientid.apps.googleusercontent.com",
        clientSecret: LEGACY_CLIENT_SECRET,
        version: 1,
      }),
    );
    keychain.records.set("google-refresh-token", "old-client-refresh-token");
    keychain.records.set(
      "google-account-metadata",
      JSON.stringify({
        email: "old@example.com",
        subject: "old-subject",
        version: 1,
      }),
    );
    const openedUrls: URL[] = [];
    const revokedTokens: string[] = [];
    const broker = new GoogleOAuthBroker({
      fetch: async (input, init) => {
        if (String(input) !== "https://oauth2.googleapis.com/revoke") {
          throw new Error("unexpected request");
        }
        revokedTokens.push(
          new URLSearchParams(String(init?.body)).get("token") ?? "",
        );
        return new Response(null, { status: 200 });
      },
      keychain,
      openExternal: browserCompletesCallback(openedUrls),
    });

    await expect(broker.connect()).rejects.toThrow(
      "GOOGLE_OAUTH_DISCONNECT_REQUIRED",
    );
    expect(openedUrls).toHaveLength(0);
    await expect(broker.disconnect()).resolves.toBeUndefined();
    expect(revokedTokens).toEqual(["old-client-refresh-token"]);
    expect(keychain.records.has("google-oauth-client-config")).toBe(false);
    expect(keychain.records.has("google-refresh-token")).toBe(false);
    expect(keychain.records.has("google-account-metadata")).toBe(false);
  });

  test("times out and closes an unused callback port", async () => {
    const keychain = new MemoryKeychain();
    let redirectUri = "";
    const broker = new GoogleOAuthBroker({
      callbackTimeoutMs: 20,
      fetch: googleFetch(
        { email: "first@example.com", sub: "subject-first" },
        [],
      ),
      keychain,
      openExternal: async (rawUrl) => {
        redirectUri = new URL(rawUrl).searchParams.get("redirect_uri")!;
      },
    });

    await expect(broker.connect()).rejects.toThrow("OAUTH_CALLBACK_TIMEOUT");
    await expect(fetch(redirectUri)).rejects.toThrow();
  });

  test("disconnect confirms pending work, revokes remotely, and deletes only Google records", async () => {
    const keychain = new MemoryKeychain();
    const calls: string[] = [];
    let confirmed = false;
    const broker = new GoogleOAuthBroker({
      confirmDisconnect: async () => confirmed,
      fetch: googleFetch(
        { email: "first@example.com", sub: "subject-first" },
        calls,
      ),
      keychain,
      openExternal: browserCompletesCallback([]),
      pendingOperationCount: async () => 2,
    });
    keychain.records.set("local-jwt-signing-key", "unrelated-key");
    await broker.connect();

    await expect(broker.disconnect()).rejects.toThrow(
      "GOOGLE_DISCONNECT_CANCELLED",
    );
    expect(await broker.status()).toMatchObject({ kind: "connected" });

    confirmed = true;
    await broker.disconnect();
    expect(await broker.status()).toEqual({ kind: "disconnected" });
    expect(keychain.records.get("local-jwt-signing-key")).toBe("unrelated-key");
    expect(keychain.records.has("google-oauth-client-config")).toBe(false);
    expect(keychain.records.has("google-refresh-token")).toBe(false);
    expect(keychain.records.has("google-account-metadata")).toBe(false);
    expect(calls).toContain("https://oauth2.googleapis.com/revoke");
  });

  test("refreshes an expired access token without persisting either access token", async () => {
    const keychain = new MemoryKeychain();
    let now = 100_000;
    let tokenRequestCount = 0;
    const broker = new GoogleOAuthBroker({
      fetch: async (input, init) => {
        const url = String(input);
        if (url === GOOGLE_TOKEN_ENDPOINT) {
          tokenRequestCount += 1;
          if (tokenRequestCount === 1) {
            return Response.json({
              access_token: "seeded-access-token",
              expires_in: 3_600,
              refresh_token: "seeded-refresh-token",
              scope: GOOGLE_CALENDAR_SCOPES.join(" "),
              token_type: "Bearer",
            });
          }
          const body = new URLSearchParams(String(init?.body));
          expect(body.get("client_id")).toBe(
            TEST_GOOGLE_DESKTOP_CLIENT.clientId,
          );
          expect(body.get("refresh_token")).toBe("seeded-refresh-token");
          expect(body.get("client_secret")).toBe(
            TEST_GOOGLE_DESKTOP_CLIENT.clientSecret,
          );
          return Response.json({
            access_token: "refreshed-access-token",
            expires_in: 3_600,
            token_type: "Bearer",
          });
        }
        if (url === "https://openidconnect.googleapis.com/v1/userinfo") {
          return Response.json({
            email: "first@example.com",
            email_verified: true,
            sub: "subject-first",
          });
        }
        throw new Error("unexpected request");
      },
      keychain,
      now: () => now,
      openExternal: browserCompletesCallback([]),
    });
    await broker.connect();
    expect(await broker.accessToken()).toBe("seeded-access-token");

    now += 3_600_000;
    expect(await broker.accessToken()).toBe("refreshed-access-token");
    expect(tokenRequestCount).toBe(2);
    expect([...keychain.records.values()].join(" ")).not.toMatch(
      /seeded-access-token|refreshed-access-token/,
    );
  });

  test("concurrent access-token callers share one refresh request per credential generation", async () => {
    const keychain = new MemoryKeychain();
    let now = 100_000;
    let refreshRequestCount = 0;
    const broker = new GoogleOAuthBroker({
      fetch: async (input, init) => {
        const url = String(input);
        if (url === GOOGLE_TOKEN_ENDPOINT) {
          const body = String(init?.body);
          if (body.includes("grant_type=refresh_token")) {
            refreshRequestCount += 1;
            return Response.json({
              access_token: "shared-refreshed-access-token",
              expires_in: 3_600,
              token_type: "Bearer",
            });
          }
          return Response.json({
            access_token: "seeded-access-token",
            expires_in: 3_600,
            refresh_token: "seeded-refresh-token",
            scope: GOOGLE_CALENDAR_SCOPES.join(" "),
            token_type: "Bearer",
          });
        }
        if (url === "https://openidconnect.googleapis.com/v1/userinfo") {
          return Response.json({
            email: "first@example.com",
            email_verified: true,
            sub: "subject-first",
          });
        }
        throw new Error("unexpected request");
      },
      keychain,
      now: () => now,
      openExternal: browserCompletesCallback([]),
    });
    await broker.connect();
    now += 3_600_000;

    await expect(
      Promise.all([
        broker.accessToken(),
        broker.accessToken(),
        broker.accessToken(),
      ]),
    ).resolves.toEqual([
      "shared-refreshed-access-token",
      "shared-refreshed-access-token",
      "shared-refreshed-access-token",
    ]);
    expect(refreshRequestCount).toBe(1);
  });

  test("durably stores a rotated refresh token before returning its access token", async () => {
    const keychain = new MemoryKeychain();
    let now = 100_000;
    const broker = new GoogleOAuthBroker({
      fetch: async (input, init) => {
        const url = String(input);
        if (url === GOOGLE_TOKEN_ENDPOINT) {
          const body = String(init?.body);
          return Response.json(
            body.includes("grant_type=refresh_token")
              ? {
                  access_token: "rotated-access-token",
                  expires_in: 3_600,
                  refresh_token: "rotated-refresh-token",
                  token_type: "Bearer",
                }
              : {
                  access_token: "seeded-access-token",
                  expires_in: 3_600,
                  refresh_token: "seeded-refresh-token",
                  scope: GOOGLE_CALENDAR_SCOPES.join(" "),
                  token_type: "Bearer",
                },
          );
        }
        if (url === "https://openidconnect.googleapis.com/v1/userinfo") {
          return Response.json({
            email: "first@example.com",
            email_verified: true,
            sub: "subject-first",
          });
        }
        throw new Error("unexpected request");
      },
      keychain,
      now: () => now,
      openExternal: browserCompletesCallback([]),
    });
    await broker.connect();
    now += 3_600_000;

    await expect(broker.accessToken()).resolves.toBe("rotated-access-token");
    expect(storedV2Accounts(keychain)[0]?.refreshToken).toBe(
      "rotated-refresh-token",
    );
  });

  test("does not publish a refreshed access token when rotated-token persistence fails", async () => {
    const keychain = new MemoryKeychain();
    let now = 100_000;
    let refreshRequestCount = 0;
    const broker = new GoogleOAuthBroker({
      fetch: async (input, init) => {
        const url = String(input);
        if (url === GOOGLE_TOKEN_ENDPOINT) {
          const body = String(init?.body);
          if (body.includes("grant_type=refresh_token")) {
            refreshRequestCount += 1;
            return Response.json({
              access_token: "rotated-access-token",
              expires_in: 3_600,
              refresh_token: "rotated-refresh-token",
              token_type: "Bearer",
            });
          }
          return Response.json({
            access_token: "seeded-access-token",
            expires_in: 3_600,
            refresh_token: "seeded-refresh-token",
            scope: GOOGLE_CALENDAR_SCOPES.join(" "),
            token_type: "Bearer",
          });
        }
        if (url === "https://openidconnect.googleapis.com/v1/userinfo") {
          return Response.json({
            email: "first@example.com",
            email_verified: true,
            sub: "subject-first",
          });
        }
        throw new Error("unexpected request");
      },
      keychain,
      now: () => now,
      openExternal: browserCompletesCallback([]),
    });
    await broker.connect();
    now += 3_600_000;
    keychain.rejectSetFor = "google-account-v2-0";

    await expect(broker.accessToken()).rejects.toThrow(
      "GOOGLE_REFRESH_TOKEN_SAVE_FAILED",
    );
    expect(storedV2Accounts(keychain)[0]?.refreshToken).toBe(
      "seeded-refresh-token",
    );

    keychain.rejectSetFor = null;
    await expect(broker.accessToken()).resolves.toBe("rotated-access-token");
    expect(refreshRequestCount).toBe(2);
    expect(storedV2Accounts(keychain)[0]?.refreshToken).toBe(
      "rotated-refresh-token",
    );
  });

  test("disconnect invalidates an access-token refresh already in flight", async () => {
    const keychain = new MemoryKeychain();
    let now = 100_000;
    let finishRefresh!: (response: Response) => void;
    let announceRefresh!: () => void;
    const refreshStarted = new Promise<void>((resolve) => {
      announceRefresh = resolve;
    });
    const broker = new GoogleOAuthBroker({
      fetch: async (input, init) => {
        const url = String(input);
        if (url === GOOGLE_TOKEN_ENDPOINT) {
          const body = String(init?.body);
          if (body.includes("grant_type=refresh_token")) {
            announceRefresh();
            return await new Promise<Response>((resolve) => {
              finishRefresh = resolve;
            });
          }
          return Response.json({
            access_token: "seeded-access-token",
            expires_in: 3_600,
            refresh_token: "seeded-refresh-token",
            scope: GOOGLE_CALENDAR_SCOPES.join(" "),
            token_type: "Bearer",
          });
        }
        if (url === "https://openidconnect.googleapis.com/v1/userinfo") {
          return Response.json({
            email: "first@example.com",
            email_verified: true,
            sub: "subject-first",
          });
        }
        if (url === "https://oauth2.googleapis.com/revoke") {
          return new Response(null, { status: 200 });
        }
        throw new Error("unexpected request");
      },
      keychain,
      now: () => now,
      openExternal: browserCompletesCallback([]),
    });
    await broker.connect();
    now += 3_600_000;

    const accessToken = broker.accessToken();
    await refreshStarted;
    await broker.disconnect();
    finishRefresh(
      Response.json({
        access_token: "late-access-token",
        expires_in: 3_600,
        token_type: "Bearer",
      }),
    );

    await expect(accessToken).rejects.toThrow(
      "GOOGLE_OAUTH_CONNECTION_CHANGED",
    );
    expect(await broker.status()).toEqual({ kind: "disconnected" });
  });

  test("rejects a refresh that starts after disconnect invalidates the credential generation", async () => {
    const keychain = new MemoryKeychain();
    let now = 100_000;
    let refreshRequestCount = 0;
    let announceSyncStopped!: () => void;
    let finishStoppingSync!: () => void;
    const syncStopStarted = new Promise<void>((resolve) => {
      announceSyncStopped = resolve;
    });
    const syncMayFinish = new Promise<void>((resolve) => {
      finishStoppingSync = resolve;
    });
    const broker = new GoogleOAuthBroker({
      fetch: async (input, init) => {
        const url = String(input);
        if (url === GOOGLE_TOKEN_ENDPOINT) {
          const body = String(init?.body);
          if (body.includes("grant_type=refresh_token")) {
            refreshRequestCount += 1;
            return Response.json({
              access_token: "must-not-survive-disconnect",
              expires_in: 3_600,
              token_type: "Bearer",
            });
          }
          return Response.json({
            access_token: "seeded-access-token",
            expires_in: 3_600,
            refresh_token: "seeded-refresh-token",
            scope: GOOGLE_CALENDAR_SCOPES.join(" "),
            token_type: "Bearer",
          });
        }
        if (url === "https://openidconnect.googleapis.com/v1/userinfo") {
          return Response.json({
            email: "first@example.com",
            email_verified: true,
            sub: "subject-first",
          });
        }
        if (url === "https://oauth2.googleapis.com/revoke") {
          return new Response(null, { status: 200 });
        }
        throw new Error("unexpected request");
      },
      keychain,
      now: () => now,
      openExternal: browserCompletesCallback([]),
      stopSynchronization: async () => {
        announceSyncStopped();
        await syncMayFinish;
      },
    });
    await broker.connect();
    now += 3_600_000;

    const disconnect = broker.disconnect();
    await syncStopStarted;
    try {
      await expect(broker.accessToken()).rejects.toThrow("GOOGLE_OAUTH_BUSY");
      expect(refreshRequestCount).toBe(0);
    } finally {
      finishStoppingSync();
      await disconnect;
    }

    expect(await broker.status()).toEqual({ kind: "disconnected" });
    expect(keychain.records.has("google-refresh-token")).toBe(false);
    await expect(broker.accessToken()).rejects.toThrow(
      "GOOGLE_OAUTH_NOT_CONNECTED",
    );
  });

  test("disconnect waits for a paused refresh-token replacement before clearing credentials", async () => {
    const keychain = new MemoryKeychain();
    let now = 100_000;
    let announceReplacement!: () => void;
    let releaseReplacement!: () => void;
    const replacementStarted = new Promise<void>((resolve) => {
      announceReplacement = resolve;
    });
    const replacementMayFinish = new Promise<void>((resolve) => {
      releaseReplacement = resolve;
    });
    keychain.beforeSet = async (account, value) => {
      if (
        account.startsWith("google-account-v2-") &&
        value.includes("stale-rotated-refresh-token")
      ) {
        announceReplacement();
        await replacementMayFinish;
      }
    };
    const broker = new GoogleOAuthBroker({
      fetch: async (input, init) => {
        const url = String(input);
        if (url === GOOGLE_TOKEN_ENDPOINT) {
          const body = String(init?.body);
          return Response.json(
            body.includes("grant_type=refresh_token")
              ? {
                  access_token: "stale-refreshed-access-token",
                  expires_in: 3_600,
                  refresh_token: "stale-rotated-refresh-token",
                  token_type: "Bearer",
                }
              : {
                  access_token: "seeded-access-token",
                  expires_in: 3_600,
                  refresh_token: "first-refresh-token",
                  scope: GOOGLE_CALENDAR_SCOPES.join(" "),
                  token_type: "Bearer",
                },
          );
        }
        if (url === "https://openidconnect.googleapis.com/v1/userinfo") {
          return Response.json({
            email: "first@example.com",
            email_verified: true,
            sub: "subject-first",
          });
        }
        if (url === "https://oauth2.googleapis.com/revoke") {
          return new Response(null, { status: 200 });
        }
        throw new Error("unexpected request");
      },
      keychain,
      now: () => now,
      openExternal: browserCompletesCallback([]),
    });
    await broker.connect();
    now += 3_600_000;

    const accessToken = broker.accessToken();
    await replacementStarted;
    let disconnectSettled = false;
    const disconnect = broker.disconnect().finally(() => {
      disconnectSettled = true;
    });
    await nextEventLoopTurn();
    const settledBeforeReplacement = disconnectSettled;
    releaseReplacement();
    const accessError = await accessToken.catch((error) => error as Error);
    const disconnectError = await disconnect.catch((error) => error as Error);

    expect(settledBeforeReplacement).toBe(false);
    expect(accessError.message).toBe("GOOGLE_OAUTH_BUSY");
    expect(disconnectError).toBeUndefined();
    expect(await broker.status()).toEqual({ kind: "disconnected" });
    expect(keychain.records.has("google-oauth-client-config")).toBe(false);
    expect(keychain.records.has("google-refresh-token")).toBe(false);
    expect(keychain.records.has("google-account-metadata")).toBe(false);
  });

  test("a stale paused refresh cannot overwrite credentials connected after disconnect", async () => {
    const keychain = new MemoryKeychain();
    let account = { email: "first@example.com", sub: "subject-first" };
    let now = 100_000;
    let announceReplacement!: () => void;
    let releaseReplacement!: () => void;
    const replacementStarted = new Promise<void>((resolve) => {
      announceReplacement = resolve;
    });
    const replacementMayFinish = new Promise<void>((resolve) => {
      releaseReplacement = resolve;
    });
    keychain.beforeSet = async (record, value) => {
      if (
        record.startsWith("google-account-v2-") &&
        value.includes("stale-rotated-refresh-token")
      ) {
        announceReplacement();
        await replacementMayFinish;
      }
    };
    const broker = new GoogleOAuthBroker({
      fetch: async (input, init) => {
        const url = String(input);
        if (url === GOOGLE_TOKEN_ENDPOINT) {
          const body = String(init?.body);
          if (body.includes("grant_type=refresh_token")) {
            return Response.json({
              access_token: "stale-refreshed-access-token",
              expires_in: 3_600,
              refresh_token: "stale-rotated-refresh-token",
              token_type: "Bearer",
            });
          }
          return Response.json({
            access_token: `access-for-${account.sub}`,
            expires_in: 3_600,
            refresh_token: `refresh-for-${account.sub}`,
            scope: GOOGLE_CALENDAR_SCOPES.join(" "),
            token_type: "Bearer",
          });
        }
        if (url === "https://openidconnect.googleapis.com/v1/userinfo") {
          return Response.json({
            email: account.email,
            email_verified: true,
            sub: account.sub,
          });
        }
        if (url === "https://oauth2.googleapis.com/revoke") {
          return new Response(null, { status: 200 });
        }
        throw new Error("unexpected request");
      },
      keychain,
      now: () => now,
      openExternal: browserCompletesCallback([]),
    });
    await broker.connect();
    now += 3_600_000;
    const staleAccess = broker.accessToken();
    await replacementStarted;

    const disconnect = broker.disconnect();
    await nextEventLoopTurn();
    account = { email: "second@example.com", sub: "subject-second" };
    let connectedBeforeReplacement = true;
    try {
      await broker.connect();
    } catch (error) {
      connectedBeforeReplacement = false;
      expect((error as Error).message).toBe("GOOGLE_OAUTH_CONNECT_IN_PROGRESS");
    }

    releaseReplacement();
    await staleAccess.catch(() => {});
    await disconnect;
    if (!connectedBeforeReplacement) await broker.connect();

    expect(await broker.status()).toMatchObject({
      accountEmail: "second@example.com",
      kind: "connected",
    });
    expect(storedV2Accounts(keychain)).toEqual([
      expect.objectContaining({
        email: "second@example.com",
        refreshToken: "refresh-for-subject-second",
        subject: "subject-second",
        version: 2,
      }),
    ]);
    expect(keychain.records.has("google-oauth-client-config")).toBe(false);
  });

  test("network timeout remains active while a hostile JSON body stalls", async () => {
    const keychain = new MemoryKeychain();
    const broker = new GoogleOAuthBroker({
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start() {
              // The peer sends headers but never completes its response body.
            },
          }),
          { headers: { "content-type": "application/json" }, status: 200 },
        ),
      keychain,
      networkTimeoutMs: 20,
      openExternal: browserCompletesCallback([]),
    });

    await expect(broker.connect()).rejects.toThrow(
      "GOOGLE_OAUTH_NETWORK_ERROR",
    );
    expect(keychain.records.size).toBe(0);
  });

  test("rejects hostile token and userinfo JSON with redacted errors", async () => {
    for (const response of [
      Response.json({
        access_token: 42,
        refresh_token: "seeded-refresh-token",
      }),
      Response.json({
        access_token: "seeded-access-token",
        expires_in: 3_600,
        refresh_token: "seeded-refresh-token",
        token_type: "Bearer",
      }),
      Response.json({
        access_token: "seeded-access-token",
        expires_in: 3_600,
        refresh_token: "seeded-refresh-token",
        scope: GOOGLE_CALENDAR_SCOPES.join(" "),
        token_type: "Bearer",
      }),
    ]) {
      const keychain = new MemoryKeychain();
      let requestCount = 0;
      const broker = new GoogleOAuthBroker({
        fetch: async () => {
          requestCount += 1;
          return requestCount === 1
            ? response
            : Response.json({
                email: "attacker@example.com",
                email_verified: false,
                sub: "attacker",
              });
        },
        keychain,
        openExternal: browserCompletesCallback([]),
      });

      const error = await broker.connect().catch((caught) => caught as Error);
      expect(error.message).toMatch(/^GOOGLE_OAUTH_/);
      expect(error.message).not.toMatch(
        /seeded-(?:code|state|verifier|client-secret|refresh-token|access-token)/,
      );
      expect(keychain.records.size).toBe(0);
    }
  });
});
