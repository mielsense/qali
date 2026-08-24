const MAX_EXTERNAL_URL_LENGTH = 2_048;
const IPV4_LITERAL = /^\d{1,3}(?:\.\d{1,3}){3}$/;

function isLocalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    IPV4_LITERAL.test(host) ||
    host.includes(":")
  );
}

/**
 * Returns a public, shareable HTTPS URL or null. This boundary deliberately
 * rejects renderer/deep links, credentials, and literal/local network hosts.
 */
export function safeExternalHttpsUrl(
  value: unknown,
  rendererOrigin: string,
): URL | null {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > MAX_EXTERNAL_URL_LENGTH
  ) {
    return null;
  }

  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      isLocalHostname(url.hostname) ||
      (rendererOrigin !== "" && url.origin === rendererOrigin)
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}
