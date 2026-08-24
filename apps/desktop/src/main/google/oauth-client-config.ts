import { readFileSync } from "node:fs";

export const GOOGLE_AUTHORIZATION_ENDPOINT =
  "https://accounts.google.com/o/oauth2/v2/auth" as const;
export const GOOGLE_TOKEN_ENDPOINT =
  "https://oauth2.googleapis.com/token" as const;
export const GOOGLE_USERINFO_ENDPOINT =
  "https://openidconnect.googleapis.com/v1/userinfo" as const;
export const GOOGLE_REVOCATION_ENDPOINT =
  "https://oauth2.googleapis.com/revoke" as const;

export const GOOGLE_CALENDAR_SCOPES = Object.freeze([
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.freebusy",
] as const);

export type GoogleDesktopClient = Readonly<{
  authorizationEndpoint: typeof GOOGLE_AUTHORIZATION_ENDPOINT;
  clientId: string;
  clientSecret: string;
  scopes: typeof GOOGLE_CALENDAR_SCOPES;
  tokenEndpoint: typeof GOOGLE_TOKEN_ENDPOINT;
}>;

const GOOGLE_CLIENT_ID_PATTERN =
  /^\d{6,32}-[a-z0-9_-]{16,128}\.apps\.googleusercontent\.com$/;
const GOOGLE_CLIENT_SECRET_PATTERN = /^GOCSPX-[A-Za-z0-9_-]{16,128}$/;

function invalidClient(): Error {
  return new Error("GOOGLE_OAUTH_CLIENT_INVALID");
}

export function parseGooglePublicDesktopClient(
  value: unknown,
): GoogleDesktopClient {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalidClient();
  }
  const source = value as Record<string, unknown>;
  if (
    Object.keys(source).length !== 2 ||
    typeof source.clientId !== "string" ||
    typeof source.clientSecret !== "string" ||
    !GOOGLE_CLIENT_ID_PATTERN.test(source.clientId) ||
    !GOOGLE_CLIENT_SECRET_PATTERN.test(source.clientSecret) ||
    /replace|example|placeholder/i.test(
      `${source.clientId}\n${source.clientSecret}`,
    )
  ) {
    throw invalidClient();
  }
  return Object.freeze({
    authorizationEndpoint: GOOGLE_AUTHORIZATION_ENDPOINT,
    clientId: source.clientId,
    clientSecret: source.clientSecret,
    scopes: GOOGLE_CALENDAR_SCOPES,
    tokenEndpoint: GOOGLE_TOKEN_ENDPOINT,
  });
}

export function parseGoogleDesktopClientId(value: unknown): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalidClient();
  }
  const source = value as Record<string, unknown>;
  if (
    Object.keys(source).length !== 1 ||
    typeof source.clientId !== "string" ||
    !GOOGLE_CLIENT_ID_PATTERN.test(source.clientId) ||
    /replace|example|placeholder/i.test(source.clientId)
  ) {
    throw invalidClient();
  }
  return source.clientId;
}

export function loadPackagedGoogleClient(
  resourcePath: string,
): GoogleDesktopClient {
  let source: string;
  try {
    source = readFileSync(resourcePath, "utf8");
  } catch {
    throw new Error("GOOGLE_OAUTH_CLIENT_MISSING");
  }
  if (source.length < 2 || source.length > 4_096) throw invalidClient();
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw invalidClient();
  }
  return parseGooglePublicDesktopClient(value);
}

export function loadDevelopmentGoogleClient(
  resourcePath: string,
  clientSecret: string | undefined,
): GoogleDesktopClient {
  let source: string;
  try {
    source = readFileSync(resourcePath, "utf8");
  } catch {
    throw new Error("GOOGLE_OAUTH_CLIENT_MISSING");
  }
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw invalidClient();
  }
  return parseGooglePublicDesktopClient({
    clientId: parseGoogleDesktopClientId(value),
    clientSecret,
  });
}
