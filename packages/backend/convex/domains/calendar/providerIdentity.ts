const GOOGLE_ACCOUNT_NAMESPACE = "qali/google-account/v1\0";
const MAX_PROVIDER_ID_BYTES = 1_024;
const BASE64URL =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function assertProviderIdentity(
  value: string,
  errorCode: string,
  expectedPrefix?: string,
): void {
  const bytes = new TextEncoder().encode(value);
  if (
    value.length === 0 ||
    bytes.byteLength > MAX_PROVIDER_ID_BYTES ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    (expectedPrefix !== undefined && !value.startsWith(expectedPrefix))
  ) {
    throw new Error(errorCode);
  }
}

function base64Url(bytes: Uint8Array): string {
  let result = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index]!;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    result += BASE64URL[first >>> 2]!;
    result += BASE64URL[((first & 0x03) << 4) | ((second ?? 0) >>> 4)]!;
    if (second !== undefined) {
      result += BASE64URL[((second & 0x0f) << 2) | ((third ?? 0) >>> 6)]!;
    }
    if (third !== undefined) result += BASE64URL[third & 0x3f]!;
  }
  return result;
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return base64Url(new Uint8Array(digest));
}

/** Stable local account key. Email is deliberately absent: Google `sub` is immutable. */
export async function googleAccountIdForSubject(subject: string): Promise<string> {
  assertProviderIdentity(subject, "GOOGLE_SUBJECT_INVALID");
  return `gacc_${await sha256Base64Url(`${GOOGLE_ACCOUNT_NAMESPACE}${subject}`)}`;
}

/** Collision-safe local calendar identity; the raw Google id stays provider-side. */
export async function googleCalendarKey(
  accountId: string,
  providerCalendarId: string,
): Promise<string> {
  assertProviderIdentity(accountId, "GOOGLE_ACCOUNT_ID_INVALID", "gacc_");
  assertProviderIdentity(providerCalendarId, "GOOGLE_CALENDAR_ID_INVALID");
  return `gcal_${await sha256Base64Url(`${accountId}\0${providerCalendarId}`)}`;
}
