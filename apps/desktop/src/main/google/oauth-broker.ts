import { randomBytes as nodeRandomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";

import {
  GOOGLE_CALENDAR_SCOPES,
  GOOGLE_REVOCATION_ENDPOINT,
  GOOGLE_TOKEN_ENDPOINT,
  GOOGLE_USERINFO_ENDPOINT,
  loadDevelopmentGoogleClient,
  type GoogleDesktopClient,
} from "./oauth-client-config";
import { createPkceMaterial, type RandomBytes } from "./pkce";
import {
  GOOGLE_ACCOUNT_LIMIT,
  googleAccountId,
  GoogleTokenStore,
  type GoogleAccountMetadata,
  type GoogleCredentialKeychain,
} from "./token-store";

export type OAuthCallbackAttempt = {
  callbackPath: string;
  consumed: boolean;
  expiresAt: number;
  expectedHost: string;
  state: string;
};

export type OAuthCallbackRequest = Readonly<{
  host?: string;
  method?: string;
  url?: string;
}>;

type TokenResponse = Readonly<{
  accessToken: string;
  expiresInSeconds: number;
  refreshToken?: string;
}>;

type AccessTokenRecord = Readonly<{
  accountId: string;
  expiresAt: number;
  value: string;
}>;

type RefreshAttempt = Readonly<{
  generation: number;
  promise: Promise<string>;
}>;

export type GoogleOAuthBrokerDependencies = Readonly<{
  callbackTimeoutMs?: number;
  confirmDisconnect?: (pendingOperationCount: number) => Promise<boolean>;
  client?: GoogleDesktopClient;
  fetch?: typeof fetch;
  keychain: GoogleCredentialKeychain;
  networkTimeoutMs?: number;
  now?: () => number;
  openExternal: (url: string) => Promise<unknown>;
  pendingOperationCount?: (accountId?: string) => Promise<number>;
  randomBytes?: RandomBytes;
  stopSynchronization?: (accountId?: string) => Promise<void>;
}>;

export type GoogleCredentialMigrationResult =
  | Readonly<{ kind: "not-needed" }>
  | Readonly<{ accountSubject: string; kind: "migrated" }>
  | Readonly<{ accountSubject: string; kind: "cleanup-deferred" }>
  | Readonly<{ kind: "client-mismatch" }>
  | Readonly<{
      kind: "verification-failed";
      reason:
        | "credentials-incomplete"
        | "credentials-unsafe"
        | "identity-failed"
        | "refresh-failed"
        | "subject-mismatch";
    }>;

export type GoogleAccountConnection = Readonly<{
  accountEmail: string;
  accountId: string;
  kind: "connected";
  message?: string;
  syncState: "idle";
}>;

export type GoogleOAuthStatus =
  | GoogleAccountConnection
  | Readonly<{ kind: "disconnected" }>
  | Readonly<{
      kind: "reconnect-required";
      reason:
        | "client-mismatch"
        | "authentication-expired"
        | "credentials-incomplete"
        | "credentials-unsafe";
    }>
  | Readonly<{ kind: "unavailable"; message?: string }>;

export type GoogleAccountSummary = Readonly<{
  accountEmail: string;
  accountId: string;
}>;

/** Trusted main-process attachment identity. Never expose through preload IPC. */
export type GoogleAccountIdentity = GoogleAccountSummary &
  Readonly<{ providerAccountId: string }>;

const DEFAULT_CALLBACK_TIMEOUT_MS = 180_000;
const DEFAULT_NETWORK_TIMEOUT_MS = 15_000;
const MAX_CALLBACK_TIMEOUT_MS = 300_000;
const MAX_NETWORK_TIMEOUT_MS = 60_000;
const MAX_JSON_BYTES = 64 * 1024;
const ACCESS_TOKEN_EXPIRY_SKEW_MS = 60_000;
const GOOGLE_USERINFO_EMAIL_SCOPE =
  "https://www.googleapis.com/auth/userinfo.email";

function developmentGoogleDesktopClient(): GoogleDesktopClient {
  return loadDevelopmentGoogleClient(
    resolve(import.meta.dirname, "../../../resources/google-oauth-client.json"),
    process.env.QALI_GOOGLE_OAUTH_CLIENT_SECRET,
  );
}

function normalizeGoogleScope(scope: string): string {
  return scope === "email" ? GOOGLE_USERINFO_EMAIL_SCOPE : scope;
}

const APPROVED_GOOGLE_SCOPES = new Set(
  GOOGLE_CALENDAR_SCOPES.map(normalizeGoogleScope),
);

function oauthError(code: string): Error {
  return new Error(code);
}

function boundedTimeout(value: number, maximum: number, code: string): number {
  if (!Number.isInteger(value) || value < 1 || value > maximum)
    throw oauthError(code);
  return value;
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function validateCallbackEnvelope(
  attempt: OAuthCallbackAttempt,
  request: OAuthCallbackRequest,
  now: number,
): URL {
  if (attempt.consumed) throw oauthError("OAUTH_CALLBACK_REPLAY");
  if (now > attempt.expiresAt) throw oauthError("OAUTH_CALLBACK_EXPIRED");
  if (
    request.method !== "GET" ||
    request.host !== attempt.expectedHost ||
    typeof request.url !== "string" ||
    request.url.length > 4_096
  ) {
    throw oauthError("OAUTH_CALLBACK_REJECTED");
  }

  let url: URL;
  try {
    url = new URL(request.url, `http://${attempt.expectedHost}`);
  } catch {
    throw oauthError("OAUTH_CALLBACK_REJECTED");
  }
  const states = url.searchParams.getAll("state");
  if (
    url.protocol !== "http:" ||
    url.host !== attempt.expectedHost ||
    url.pathname !== attempt.callbackPath ||
    states.length !== 1 ||
    !constantTimeEqual(states[0]!, attempt.state)
  ) {
    throw oauthError("OAUTH_CALLBACK_REJECTED");
  }
  return url;
}

export function consumeOAuthCallback(
  attempt: OAuthCallbackAttempt,
  request: OAuthCallbackRequest,
  now = Date.now(),
): { code: string; consumed: true } {
  const url = validateCallbackEnvelope(attempt, request, now);
  const codes = url.searchParams.getAll("code");
  if (
    codes.length !== 1 ||
    codes[0]!.length < 1 ||
    codes[0]!.length > 4_096 ||
    url.searchParams.has("error")
  ) {
    throw oauthError("OAUTH_CALLBACK_REJECTED");
  }
  attempt.consumed = true;
  return { code: codes[0]!, consumed: true };
}

export function consumeOAuthCancellation(
  attempt: OAuthCallbackAttempt,
  request: OAuthCallbackRequest,
  now = Date.now(),
): { consumed: true } {
  const url = validateCallbackEnvelope(attempt, request, now);
  const errors = url.searchParams.getAll("error");
  if (
    errors.length !== 1 ||
    errors[0] !== "access_denied" ||
    url.searchParams.has("code")
  ) {
    throw oauthError("OAUTH_CALLBACK_REJECTED");
  }
  attempt.consumed = true;
  return { consumed: true };
}

async function readBoundedJson(
  response: Response,
  signal?: AbortSignal,
): Promise<unknown> {
  const mediaType = response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (mediaType !== "application/json") {
    throw oauthError("GOOGLE_OAUTH_INVALID_RESPONSE");
  }
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > MAX_JSON_BYTES
    ) {
      throw oauthError("GOOGLE_OAUTH_INVALID_RESPONSE");
    }
  }
  if (!response.body) throw oauthError("GOOGLE_OAUTH_INVALID_RESPONSE");

  const reader = response.body.getReader();
  let aborted = signal?.aborted ?? false;
  const onAbort = () => {
    aborted = true;
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > MAX_JSON_BYTES)
        throw oauthError("GOOGLE_OAUTH_INVALID_RESPONSE");
      chunks.push(item.value);
    }
    if (aborted) throw oauthError("GOOGLE_OAUTH_NETWORK_ERROR");
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message)) {
      throw error;
    }
    throw oauthError("GOOGLE_OAUTH_INVALID_RESPONSE");
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }

  const body = Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    bytes,
  );
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw oauthError("GOOGLE_OAUTH_INVALID_RESPONSE");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const GOOGLE_PROVIDER_ERROR_CODES = {
  access_denied: "GOOGLE_OAUTH_PROVIDER_ACCESS_DENIED",
  invalid_client: "GOOGLE_OAUTH_PROVIDER_INVALID_CLIENT",
  invalid_grant: "GOOGLE_OAUTH_PROVIDER_INVALID_GRANT",
  invalid_scope: "GOOGLE_OAUTH_PROVIDER_INVALID_SCOPE",
  unauthorized_client: "GOOGLE_OAUTH_PROVIDER_UNAUTHORIZED_CLIENT",
} as const;

function googleTokenProviderError(value: unknown): string | null {
  if (!isRecord(value) || typeof value.error !== "string") return null;
  return (
    GOOGLE_PROVIDER_ERROR_CODES[
      value.error as keyof typeof GOOGLE_PROVIDER_ERROR_CODES
    ] ?? null
  );
}

function parseTokenResponse(
  value: unknown,
  options: { requireRefreshToken: boolean; requireScopes: boolean },
): TokenResponse {
  if (!isRecord(value) || Object.keys(value).length > 16) {
    throw oauthError("GOOGLE_OAUTH_INVALID_TOKEN_RESPONSE");
  }
  const accessToken = value.access_token;
  const expiresIn = value.expires_in;
  const refreshToken = value.refresh_token;
  const tokenType = value.token_type;
  const scope = value.scope;
  if (
    typeof accessToken !== "string" ||
    accessToken.length < 1 ||
    accessToken.length > 8_192 ||
    !Number.isInteger(expiresIn) ||
    (expiresIn as number) < 1 ||
    (expiresIn as number) > 86_400 ||
    tokenType !== "Bearer" ||
    (options.requireRefreshToken &&
      (typeof refreshToken !== "string" ||
        refreshToken.length < 1 ||
        refreshToken.length > 8_192)) ||
    (!options.requireRefreshToken &&
      refreshToken !== undefined &&
      (typeof refreshToken !== "string" ||
        refreshToken.length < 1 ||
        refreshToken.length > 8_192)) ||
    (scope !== undefined &&
      (typeof scope !== "string" || scope.length > 4_096)) ||
    (options.requireScopes && typeof scope !== "string")
  ) {
    throw oauthError("GOOGLE_OAUTH_INVALID_TOKEN_RESPONSE");
  }
  if (typeof scope === "string") {
    const granted = new Set(
      scope.split(/\s+/).filter(Boolean).map(normalizeGoogleScope),
    );
    if (
      [...APPROVED_GOOGLE_SCOPES].some((required) => !granted.has(required))
    ) {
      throw oauthError("GOOGLE_OAUTH_REQUIRED_SCOPE_MISSING");
    }
    if ([...granted].some((value) => !APPROVED_GOOGLE_SCOPES.has(value))) {
      throw oauthError("GOOGLE_OAUTH_SCOPE_NOT_ALLOWED");
    }
  }
  return Object.freeze({
    accessToken,
    expiresInSeconds: expiresIn as number,
    ...(typeof refreshToken === "string" ? { refreshToken } : {}),
  });
}

function parseUserInfo(value: unknown): GoogleAccountMetadata {
  if (!isRecord(value) || Object.keys(value).length > 32) {
    throw oauthError("GOOGLE_OAUTH_INVALID_IDENTITY");
  }
  const email = value.email;
  const subject = value.sub;
  if (
    typeof email !== "string" ||
    email.length > 320 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    value.email_verified !== true ||
    typeof subject !== "string" ||
    subject.length < 1 ||
    subject.length > 256
  ) {
    throw oauthError("GOOGLE_OAUTH_INVALID_IDENTITY");
  }
  return Object.freeze({ email, subject });
}

type LoopbackCallback = Readonly<{
  attempt: OAuthCallbackAttempt;
  cancel(code: string): void;
  close(): Promise<void>;
  redirectUri: string;
  result: Promise<string>;
}>;

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    server.closeAllConnections();
    return;
  }
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

async function startLoopbackCallback(options: {
  now: () => number;
  randomBytes: RandomBytes;
  state: string;
  timeoutMs: number;
}): Promise<LoopbackCallback> {
  let resolveResult!: (code: string) => void;
  let rejectResult!: (error: Error) => void;
  let settled = false;
  let timeout: ReturnType<typeof setTimeout>;
  const result = new Promise<string>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  const attemptId = Buffer.from(options.randomBytes(16)).toString("base64url");
  const attempt: OAuthCallbackAttempt = {
    callbackPath: `/oauth/google/callback/${attemptId}`,
    consumed: false,
    expiresAt: options.now() + options.timeoutMs,
    expectedHost: "",
    state: options.state,
  };

  const settle = (error: Error | null, code?: string) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    if (error) rejectResult(error);
    else resolveResult(code!);
  };

  const server = createServer(
    { maxHeaderSize: 8 * 1024 },
    (request, response) => {
      try {
        const consumed = consumeOAuthCallback(
          attempt,
          {
            host: request.headers.host,
            method: request.method,
            url: request.url,
          },
          options.now(),
        );
        response.writeHead(200, {
          "cache-control": "no-store",
          "content-security-policy": "default-src 'none'",
          "content-type": "text/html; charset=utf-8",
          "x-content-type-options": "nosniff",
        });
        response.end(
          "<!doctype html><title>Qali connected</title><p>You can return to Qali.</p>",
        );
        settle(null, consumed.code);
        void closeServer(server);
      } catch (error) {
        try {
          consumeOAuthCancellation(
            attempt,
            {
              host: request.headers.host,
              method: request.method,
              url: request.url,
            },
            options.now(),
          );
          response.writeHead(200, {
            "cache-control": "no-store",
            "content-security-policy": "default-src 'none'",
            "content-type": "text/html; charset=utf-8",
            "x-content-type-options": "nosniff",
          });
          response.end(
            "<!doctype html><title>Qali connection cancelled</title><p>You can return to Qali.</p>",
          );
          settle(oauthError("GOOGLE_OAUTH_CANCELLED"));
          void closeServer(server);
          return;
        } catch {
          // Invalid callbacks do not consume or terminate the active attempt.
        }
        response.writeHead(400, {
          "cache-control": "no-store",
          "content-type": "text/plain; charset=utf-8",
          "x-content-type-options": "nosniff",
        });
        response.end("Qali rejected this OAuth callback.");
        if (
          error instanceof Error &&
          error.message === "OAUTH_CALLBACK_EXPIRED"
        ) {
          settle(error);
          void closeServer(server);
        }
      }
    },
  );
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 1_000;
  server.maxConnections = 8;
  server.maxRequestsPerSocket = 1;
  server.requestTimeout = 5_000;

  await new Promise<void>((resolve, reject) => {
    const onError = () => reject(oauthError("OAUTH_CALLBACK_LISTEN_FAILED"));
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeServer(server);
    throw oauthError("OAUTH_CALLBACK_LISTEN_FAILED");
  }
  attempt.expectedHost = `127.0.0.1:${address.port}`;
  const redirectUri = `http://${attempt.expectedHost}${attempt.callbackPath}`;
  timeout = setTimeout(() => {
    settle(oauthError("OAUTH_CALLBACK_TIMEOUT"));
    void closeServer(server);
  }, options.timeoutMs);

  return {
    attempt,
    cancel(code) {
      settle(oauthError(code));
      void closeServer(server);
    },
    close: () => closeServer(server),
    redirectUri,
    result,
  };
}

export class GoogleOAuthBroker {
  readonly #callbackTimeoutMs: number;
  readonly #confirmDisconnect: (
    pendingOperationCount: number,
  ) => Promise<boolean>;
  readonly #client: GoogleDesktopClient;
  readonly #fetch: typeof fetch;
  readonly #networkTimeoutMs: number;
  readonly #now: () => number;
  readonly #openExternal: (url: string) => Promise<unknown>;
  readonly #pendingOperationCount: (accountId?: string) => Promise<number>;
  readonly #randomBytes: RandomBytes;
  readonly #stopSynchronization: (accountId?: string) => Promise<void>;
  readonly #tokenStore: GoogleTokenStore;
  readonly #accessTokens = new Map<string, AccessTokenRecord>();
  readonly #accountGenerations = new Map<string, number>();
  #connecting = false;
  #credentialMutationTail: Promise<void> = Promise.resolve();
  #disconnecting = false;
  #lifecycleGeneration = 0;
  #legacyMigrationInFlight: Promise<GoogleCredentialMigrationResult> | null =
    null;
  readonly #refreshInFlight = new Map<string, RefreshAttempt>();

  constructor(dependencies: GoogleOAuthBrokerDependencies) {
    this.#client = dependencies.client ?? developmentGoogleDesktopClient();
    this.#callbackTimeoutMs = boundedTimeout(
      dependencies.callbackTimeoutMs ?? DEFAULT_CALLBACK_TIMEOUT_MS,
      MAX_CALLBACK_TIMEOUT_MS,
      "GOOGLE_OAUTH_INVALID_TIMEOUT",
    );
    this.#networkTimeoutMs = boundedTimeout(
      dependencies.networkTimeoutMs ?? DEFAULT_NETWORK_TIMEOUT_MS,
      MAX_NETWORK_TIMEOUT_MS,
      "GOOGLE_OAUTH_INVALID_TIMEOUT",
    );
    this.#confirmDisconnect =
      dependencies.confirmDisconnect ?? (async () => false);
    this.#fetch = dependencies.fetch ?? fetch;
    this.#now = dependencies.now ?? Date.now;
    this.#openExternal = dependencies.openExternal;
    this.#pendingOperationCount =
      dependencies.pendingOperationCount ?? (async () => 0);
    this.#randomBytes = dependencies.randomBytes ?? nodeRandomBytes;
    this.#stopSynchronization =
      dependencies.stopSynchronization ?? (async () => {});
    this.#tokenStore = new GoogleTokenStore(dependencies.keychain);
  }

  async status(accountId?: string): Promise<GoogleOAuthStatus> {
    try {
      const migration = await this.migrateLegacyGoogleCredentials();
      if (migration.kind === "client-mismatch") {
        return {
          kind: "reconnect-required",
          reason: "client-mismatch",
        };
      }
      if (migration.kind === "verification-failed") {
        if (
          migration.reason === "credentials-incomplete" ||
          migration.reason === "credentials-unsafe"
        ) {
          return {
            kind: "reconnect-required",
            reason: migration.reason,
          };
        }
        return {
          kind: "unavailable",
          message: "Google authorization needs attention",
        };
      }
      const accounts = await this.#tokenStore.list();
      const stored =
        accountId === undefined
          ? (accounts[0] ?? null)
          : (accounts.find((account) => account.accountId === accountId) ??
            null);
      return stored
        ? {
            accountEmail: stored.account.email,
            accountId: stored.accountId,
            kind: "connected",
            ...(migration.kind === "cleanup-deferred"
              ? {
                  message:
                    "Google is connected; old authorization metadata cleanup is pending.",
                }
              : {}),
            syncState: "idle",
          }
        : { kind: "disconnected" };
    } catch {
      return {
        kind: "unavailable",
        message: "Google credentials are unavailable",
      };
    }
  }

  async listAccounts(): Promise<readonly GoogleAccountSummary[]> {
    const migration = await this.migrateLegacyGoogleCredentials();
    if (
      migration.kind === "client-mismatch" ||
      migration.kind === "verification-failed"
    ) {
      throw oauthError("GOOGLE_OAUTH_CREDENTIALS_UNAVAILABLE");
    }
    return Object.freeze(
      (await this.#tokenStore.list()).map((stored) =>
        Object.freeze({
          accountEmail: stored.account.email,
          accountId: stored.accountId,
        }),
      ),
    );
  }

  async listAccountIdentities(): Promise<readonly GoogleAccountIdentity[]> {
    const migration = await this.migrateLegacyGoogleCredentials();
    if (
      migration.kind === "client-mismatch" ||
      migration.kind === "verification-failed"
    ) {
      throw oauthError("GOOGLE_OAUTH_CREDENTIALS_UNAVAILABLE");
    }
    const identities = (await this.#tokenStore.list()).map((stored) => {
      if (googleAccountId(stored.account.subject) !== stored.accountId) {
        throw oauthError("GOOGLE_OAUTH_CREDENTIALS_UNAVAILABLE");
      }
      return Object.freeze({
        accountEmail: stored.account.email,
        accountId: stored.accountId,
        providerAccountId: stored.account.subject,
      });
    });
    if (identities.length > GOOGLE_ACCOUNT_LIMIT) {
      throw oauthError("GOOGLE_OAUTH_CREDENTIALS_UNAVAILABLE");
    }
    return Object.freeze(identities);
  }

  isBusy(): boolean {
    return this.#connecting || this.#disconnecting;
  }

  async requiresLegacyCredentialRecovery(): Promise<boolean> {
    const accounts = await this.#tokenStore.list();
    if (accounts.length > 0) return false;
    const recovery = await this.#tokenStore.inspectForDisconnect();
    return recovery.hasCredentials && recovery.hasLegacyCredentials;
  }

  async clearLegacyCredentials(): Promise<void> {
    if (!(await this.requiresLegacyCredentialRecovery())) {
      throw oauthError("GOOGLE_LEGACY_RECOVERY_NOT_REQUIRED");
    }
    await this.disconnect();
  }

  async connect(): Promise<GoogleOAuthStatus> {
    return await this.add();
  }

  async add(): Promise<GoogleAccountConnection> {
    return await this.#authorize();
  }

  async reconnect(accountId: string): Promise<GoogleAccountConnection> {
    const stored = await this.#tokenStore.loadAccount(accountId);
    if (!stored) throw oauthError("GOOGLE_OAUTH_NOT_CONNECTED");
    return await this.#authorize(accountId);
  }

  async #authorize(
    expectedAccountId?: string,
  ): Promise<GoogleAccountConnection> {
    if (this.#connecting || this.#disconnecting)
      throw oauthError("GOOGLE_OAUTH_CONNECT_IN_PROGRESS");
    this.#connecting = true;
    let callback: LoopbackCallback | null = null;
    try {
      const client = this.#client;
      let initialLegacy = await this.#tokenStore.inspectLegacy(client.clientId);
      if (initialLegacy.kind === "candidate") {
        const migration = await this.migrateLegacyGoogleCredentials();
        if (
          migration.kind === "client-mismatch" ||
          migration.kind === "verification-failed"
        ) {
          throw oauthError("GOOGLE_OAUTH_DISCONNECT_REQUIRED");
        }
        initialLegacy = { kind: "not-needed" };
      }
      if (
        initialLegacy.kind === "client-mismatch" ||
        (initialLegacy.kind === "incomplete-or-corrupt" &&
          initialLegacy.recovery === "disconnect")
      ) {
        throw oauthError("GOOGLE_OAUTH_DISCONNECT_REQUIRED");
      }
      if (
        expectedAccountId === undefined &&
        (await this.#tokenStore.list()).length >= GOOGLE_ACCOUNT_LIMIT
      ) {
        throw oauthError("GOOGLE_ACCOUNT_LIMIT_REACHED");
      }
      const pkce = createPkceMaterial(this.#randomBytes);
      callback = await startLoopbackCallback({
        now: this.#now,
        randomBytes: this.#randomBytes,
        state: pkce.state,
        timeoutMs: this.#callbackTimeoutMs,
      });
      const authorizationUrl = this.#authorizationUrl(
        client,
        callback.redirectUri,
        pkce,
      );
      try {
        await this.#openExternal(authorizationUrl);
      } catch {
        callback.cancel("GOOGLE_OAUTH_BROWSER_OPEN_FAILED");
      }
      const code = await callback.result;
      const tokens = await this.#exchangeAuthorizationCode(
        client,
        code,
        callback.redirectUri,
        pkce.verifier,
      );
      const account = await this.#fetchIdentity(tokens.accessToken);
      const legacy = await this.#tokenStore.inspectLegacy(client.clientId);
      if (
        legacy.kind === "client-mismatch" ||
        (legacy.kind === "incomplete-or-corrupt" &&
          legacy.recovery === "disconnect")
      )
        throw oauthError("GOOGLE_OAUTH_DISCONNECT_REQUIRED");
      const accountId = googleAccountId(account.subject);
      if (expectedAccountId !== undefined && expectedAccountId !== accountId) {
        await this.#revokeBestEffort(tokens.refreshToken!);
        throw oauthError("GOOGLE_OAUTH_ACCOUNT_MISMATCH");
      }
      const knownLegacyAccount =
        legacy.kind === "incomplete-or-corrupt" ? legacy.knownAccount : null;
      if (
        knownLegacyAccount &&
        knownLegacyAccount.subject !== account.subject
      ) {
        await this.#revokeBestEffort(tokens.refreshToken!);
        throw oauthError("GOOGLE_OAUTH_ACCOUNT_MISMATCH");
      }
      const cleanup = await this.#withCredentialMutation(async () => {
        const connection = {
          account,
          refreshToken: tokens.refreshToken!,
        };
        if (legacy.kind === "incomplete-or-corrupt") {
          return await this.#tokenStore.replaceIncompleteLegacy(
            legacy.snapshot,
            connection,
          );
        } else {
          await this.#tokenStore.save(connection);
          return await this.#tokenStore.completeVerifiedReconnect(
            account.subject,
          );
        }
      });
      if (cleanup === "cleanup-deferred") {
        const markerMatches = await this.#tokenStore.legacyMarkerMatchesClient(
          client.clientId,
        );
        const loadable = await this.#tokenStore.loadAccount(accountId);
        if (!markerMatches || loadable?.account.subject !== account.subject) {
          throw oauthError("GOOGLE_OAUTH_CLEANUP_REQUIRED");
        }
      }
      this.#lifecycleGeneration += 1;
      this.#bumpAccountGeneration(accountId);
      this.#accessTokens.set(accountId, {
        accountId,
        expiresAt: this.#now() + tokens.expiresInSeconds * 1_000,
        value: tokens.accessToken,
      });
      return {
        accountEmail: account.email,
        accountId,
        kind: "connected",
        ...(cleanup === "cleanup-deferred"
          ? {
              message:
                "Google is connected; old authorization metadata cleanup is pending.",
            }
          : {}),
        syncState: "idle",
      };
    } catch (error) {
      if (error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message))
        throw error;
      throw oauthError("GOOGLE_OAUTH_FAILED");
    } finally {
      await callback?.close();
      this.#connecting = false;
    }
  }

  async accessToken(accountId?: string): Promise<string> {
    if (this.#connecting || this.#disconnecting) {
      throw oauthError("GOOGLE_OAUTH_BUSY");
    }
    const migration = await this.migrateLegacyGoogleCredentials();
    if (
      migration.kind === "client-mismatch" ||
      migration.kind === "verification-failed"
    ) {
      throw oauthError("GOOGLE_OAUTH_CREDENTIALS_UNAVAILABLE");
    }
    const resolvedAccountId = await this.#resolveAccountId(accountId);
    const cached = this.#accessTokens.get(resolvedAccountId);
    if (
      cached &&
      cached.expiresAt > this.#now() + ACCESS_TOKEN_EXPIRY_SKEW_MS
    ) {
      return cached.value;
    }
    const credentialGeneration = this.#accountGeneration(resolvedAccountId);
    const existingRefresh = this.#refreshInFlight.get(resolvedAccountId);
    if (existingRefresh?.generation === credentialGeneration) {
      return await existingRefresh.promise;
    }

    const promise = this.#refreshAccessToken(
      resolvedAccountId,
      credentialGeneration,
    );
    this.#refreshInFlight.set(resolvedAccountId, {
      generation: credentialGeneration,
      promise,
    });
    try {
      return await promise;
    } finally {
      if (this.#refreshInFlight.get(resolvedAccountId)?.promise === promise) {
        this.#refreshInFlight.delete(resolvedAccountId);
      }
    }
  }

  async #refreshAccessToken(
    accountId: string,
    credentialGeneration: number,
  ): Promise<string> {
    const stored = await this.#tokenStore.loadAccount(accountId).catch(() => {
      throw oauthError("GOOGLE_OAUTH_CREDENTIALS_UNAVAILABLE");
    });
    this.#assertTokenLifecycle(accountId, credentialGeneration);
    if (!stored) throw oauthError("GOOGLE_OAUTH_NOT_CONNECTED");
    const cached = this.#accessTokens.get(accountId);
    if (
      cached &&
      cached.expiresAt > this.#now() + ACCESS_TOKEN_EXPIRY_SKEW_MS
    ) {
      return cached.value;
    }

    const response = await this.#tokenRequest(
      new URLSearchParams({
        client_id: this.#client.clientId,
        grant_type: "refresh_token",
        refresh_token: stored.refreshToken,
      }),
    );
    const tokens = parseTokenResponse(response, {
      requireRefreshToken: false,
      requireScopes: false,
    });
    this.#assertTokenLifecycle(accountId, credentialGeneration);
    if (
      tokens.refreshToken !== undefined &&
      tokens.refreshToken !== stored.refreshToken
    ) {
      await this.#withCredentialMutation(async () => {
        this.#assertTokenLifecycle(accountId, credentialGeneration);
        await this.#tokenStore.replaceRefreshToken(
          accountId,
          tokens.refreshToken!,
        );
        this.#assertTokenLifecycle(accountId, credentialGeneration);
      });
    }
    this.#assertTokenLifecycle(accountId, credentialGeneration);
    this.#accessTokens.set(accountId, {
      accountId,
      expiresAt: this.#now() + tokens.expiresInSeconds * 1_000,
      value: tokens.accessToken,
    });
    return tokens.accessToken;
  }

  #assertTokenLifecycle(accountId: string, credentialGeneration: number): void {
    if (this.#connecting || this.#disconnecting) {
      throw oauthError("GOOGLE_OAUTH_BUSY");
    }
    if (credentialGeneration !== this.#accountGeneration(accountId)) {
      throw oauthError("GOOGLE_OAUTH_CONNECTION_CHANGED");
    }
  }

  #accountGeneration(accountId: string): number {
    return this.#accountGenerations.get(accountId) ?? 0;
  }

  #bumpAccountGeneration(accountId: string): void {
    this.#accountGenerations.set(
      accountId,
      this.#accountGeneration(accountId) + 1,
    );
  }

  async #resolveAccountId(accountId?: string): Promise<string> {
    if (accountId !== undefined) return accountId;
    const accounts = await this.#tokenStore.list();
    if (accounts.length === 0) throw oauthError("GOOGLE_OAUTH_NOT_CONNECTED");
    if (accounts.length > 1) throw oauthError("GOOGLE_ACCOUNT_ID_REQUIRED");
    return accounts[0]!.accountId;
  }

  async #withCredentialMutation<T>(operation: () => Promise<T>): Promise<T> {
    const prior = this.#credentialMutationTail;
    let release!: () => void;
    this.#credentialMutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async disconnect(accountId?: string): Promise<void> {
    try {
      if (this.#connecting || this.#disconnecting)
        throw oauthError("GOOGLE_OAUTH_BUSY");
      this.#disconnecting = true;
      const initialRecovery =
        await this.#tokenStore.inspectForDisconnect(accountId);
      if (!initialRecovery.hasCredentials) return;
      const recoveryCleanup =
        accountId === undefined && initialRecovery.hasLegacyCredentials;
      const accounts = await this.#tokenStore.list();
      let resolvedAccountId = accountId;
      if (
        !recoveryCleanup &&
        resolvedAccountId === undefined &&
        accounts.length === 1
      ) {
        resolvedAccountId = accounts[0]!.accountId;
      } else if (
        !recoveryCleanup &&
        resolvedAccountId === undefined &&
        accounts.length > 1
      ) {
        throw oauthError("GOOGLE_ACCOUNT_ID_REQUIRED");
      }
      const pending = recoveryCleanup
        ? 0
        : await this.#pendingOperationCount(resolvedAccountId).catch(() => {
            throw oauthError("GOOGLE_PENDING_WORK_UNAVAILABLE");
          });
      if (
        !Number.isSafeInteger(pending) ||
        pending < 0 ||
        pending > 1_000_000
      ) {
        throw oauthError("GOOGLE_PENDING_WORK_UNAVAILABLE");
      }
      if (pending > 0 && !(await this.#confirmDisconnect(pending))) {
        throw oauthError("GOOGLE_DISCONNECT_CANCELLED");
      }
      this.#lifecycleGeneration += 1;
      if (!recoveryCleanup && resolvedAccountId !== undefined) {
        this.#bumpAccountGeneration(resolvedAccountId);
        this.#accessTokens.delete(resolvedAccountId);
      } else {
        for (const stored of accounts) {
          this.#bumpAccountGeneration(stored.accountId);
          this.#accessTokens.delete(stored.accountId);
        }
      }
      await this.#stopSynchronization(
        recoveryCleanup ? undefined : resolvedAccountId,
      );
      await this.#withCredentialMutation(async () => {
        const recovery = await this.#tokenStore.inspectForDisconnect(
          recoveryCleanup ? undefined : resolvedAccountId,
        );
        if (!recovery.hasCredentials) return;
        await Promise.all(
          recovery.refreshTokens.map((refreshToken) =>
            this.#revokeBestEffort(refreshToken),
          ),
        );
        await this.#tokenStore.clear(
          recoveryCleanup ? undefined : resolvedAccountId,
        );
      });
    } finally {
      this.#disconnecting = false;
    }
  }

  #authorizationUrl(
    client: GoogleDesktopClient,
    redirectUri: string,
    pkce: Readonly<{ challenge: string; state: string }>,
  ): string {
    const url = new URL(client.authorizationEndpoint);
    url.search = new URLSearchParams({
      access_type: "offline",
      client_id: client.clientId,
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
      include_granted_scopes: "true",
      prompt: "consent select_account",
      redirect_uri: redirectUri,
      response_type: "code",
      scope: client.scopes.join(" "),
      state: pkce.state,
    }).toString();
    return url.toString();
  }

  async #revokeBestEffort(token: string): Promise<void> {
    try {
      await this.#fetchWithTimeout(GOOGLE_REVOCATION_ENDPOINT, {
        body: new URLSearchParams({ token }),
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
      });
    } catch {
      // Offline revocation is best-effort. Local credential isolation remains exact.
    }
  }

  async #exchangeAuthorizationCode(
    client: GoogleDesktopClient,
    code: string,
    redirectUri: string,
    verifier: string,
  ): Promise<TokenResponse> {
    const response = await this.#tokenRequest(
      new URLSearchParams({
        client_id: client.clientId,
        code,
        code_verifier: verifier,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      }),
    );
    return parseTokenResponse(response, {
      requireRefreshToken: true,
      requireScopes: true,
    });
  }

  migrateLegacyGoogleCredentials(): Promise<GoogleCredentialMigrationResult> {
    if (this.#legacyMigrationInFlight) return this.#legacyMigrationInFlight;
    const attempt = this.#migrateLegacyGoogleCredentials();
    this.#legacyMigrationInFlight = attempt;
    const clear = () => {
      if (this.#legacyMigrationInFlight === attempt) {
        this.#legacyMigrationInFlight = null;
      }
    };
    void attempt.then(clear, clear);
    return attempt;
  }

  async #migrateLegacyGoogleCredentials(): Promise<GoogleCredentialMigrationResult> {
    const lifecycleGeneration = this.#lifecycleGeneration;
    const inspected = await this.#tokenStore.inspectLegacy(
      this.#client.clientId,
    );
    if (
      inspected.kind === "not-needed" ||
      inspected.kind === "client-mismatch"
    ) {
      return inspected;
    }
    if (inspected.kind === "incomplete-or-corrupt") {
      if (
        inspected.snapshot.clientSource !== null &&
        inspected.snapshot.refreshTokenSource === null &&
        inspected.snapshot.accountSource === null &&
        (await this.#tokenStore.legacyMarkerMatchesClient(
          this.#client.clientId,
        ))
      ) {
        const migrated = (await this.#tokenStore.list())[0];
        if (migrated) {
          return {
            accountSubject: migrated.account.subject,
            kind: "cleanup-deferred",
          };
        }
      }
      return {
        kind: "verification-failed",
        reason:
          inspected.recovery === "reconnect"
            ? "credentials-incomplete"
            : "credentials-unsafe",
      };
    }

    let tokens: TokenResponse;
    try {
      tokens = parseTokenResponse(
        await this.#tokenRequest(
          new URLSearchParams({
            client_id: this.#client.clientId,
            grant_type: "refresh_token",
            refresh_token: inspected.candidate.connection.refreshToken,
          }),
        ),
        { requireRefreshToken: false, requireScopes: false },
      );
    } catch {
      return { kind: "verification-failed", reason: "refresh-failed" };
    }

    let identity: GoogleAccountMetadata;
    try {
      identity = await this.#fetchIdentity(tokens.accessToken);
    } catch {
      return { kind: "verification-failed", reason: "identity-failed" };
    }
    if (identity.subject !== inspected.candidate.connection.account.subject) {
      return { kind: "verification-failed", reason: "subject-mismatch" };
    }

    const accountId = googleAccountId(identity.subject);
    const cleanup = await this.#withCredentialMutation(async () => {
      this.#assertMigrationLifecycle(lifecycleGeneration);
      const result = await this.#tokenStore.completeLegacyMigration(
        inspected.candidate,
        tokens.refreshToken,
      );
      this.#assertMigrationLifecycle(lifecycleGeneration);
      if (result === "cleanup-deferred") {
        const markerMatches = await this.#tokenStore.legacyMarkerMatchesClient(
          this.#client.clientId,
        );
        const loadable = await this.#tokenStore.loadAccount(accountId);
        if (!markerMatches || loadable?.account.subject !== identity.subject) {
          throw oauthError("GOOGLE_OAUTH_CLEANUP_REQUIRED");
        }
      }
      return result;
    });
    this.#assertMigrationLifecycle(lifecycleGeneration);
    const generation = this.#accountGeneration(accountId);
    this.#accessTokens.set(accountId, {
      accountId,
      expiresAt: this.#now() + tokens.expiresInSeconds * 1_000,
      value: tokens.accessToken,
    });
    if (generation !== this.#accountGeneration(accountId)) {
      this.#accessTokens.delete(accountId);
      throw oauthError("GOOGLE_OAUTH_CONNECTION_CHANGED");
    }
    return {
      accountSubject: identity.subject,
      kind: cleanup === "complete" ? "migrated" : "cleanup-deferred",
    };
  }

  #assertMigrationLifecycle(lifecycleGeneration: number): void {
    if (
      this.#disconnecting ||
      lifecycleGeneration !== this.#lifecycleGeneration
    ) {
      throw oauthError("GOOGLE_OAUTH_CONNECTION_CHANGED");
    }
  }

  async #tokenRequest(body: URLSearchParams): Promise<unknown> {
    const requestBody = new URLSearchParams(body);
    requestBody.set("client_secret", this.#client.clientSecret);
    return await this.#fetchJsonWithTimeout(
      GOOGLE_TOKEN_ENDPOINT,
      {
        body: requestBody,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
      },
      "GOOGLE_OAUTH_TOKEN_REQUEST_FAILED",
    );
  }

  async #fetchIdentity(accessToken: string): Promise<GoogleAccountMetadata> {
    return parseUserInfo(
      await this.#fetchJsonWithTimeout(
        GOOGLE_USERINFO_ENDPOINT,
        {
          headers: { authorization: `Bearer ${accessToken}` },
          method: "GET",
        },
        "GOOGLE_OAUTH_IDENTITY_REQUEST_FAILED",
      ),
    );
  }

  async #fetchJsonWithTimeout(
    input: string,
    init: RequestInit,
    unsuccessfulResponseCode: string,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.#networkTimeoutMs,
    );
    try {
      const response = await this.#fetch(input, {
        ...init,
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) {
        if (unsuccessfulResponseCode === "GOOGLE_OAUTH_TOKEN_REQUEST_FAILED") {
          try {
            const providerCode = googleTokenProviderError(
              await readBoundedJson(response, controller.signal),
            );
            if (providerCode) throw oauthError(providerCode);
          } catch (error) {
            if (
              error instanceof Error &&
              error.message.startsWith("GOOGLE_OAUTH_PROVIDER_")
            ) {
              throw error;
            }
          }
        }
        throw oauthError(unsuccessfulResponseCode);
      }
      return await readBoundedJson(response, controller.signal);
    } catch (error) {
      if (error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message)) {
        throw error;
      }
      throw oauthError("GOOGLE_OAUTH_NETWORK_ERROR");
    } finally {
      clearTimeout(timeout);
    }
  }

  async #fetchWithTimeout(input: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.#networkTimeoutMs,
    );
    try {
      return await this.#fetch(input, {
        ...init,
        redirect: "error",
        signal: controller.signal,
      });
    } catch {
      throw oauthError("GOOGLE_OAUTH_NETWORK_ERROR");
    } finally {
      clearTimeout(timeout);
    }
  }
}
