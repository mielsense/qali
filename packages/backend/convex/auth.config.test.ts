// @ts-expect-error Bun supplies its test module at runtime.
import { afterAll, describe, expect, test } from "bun:test";
import type { AuthConfig } from "convex/server";

const previousChannel = process.env.QALI_LOCAL_AUTH_CHANNEL;
process.env.QALI_LOCAL_AUTH_CHANNEL = "test";

const authModule = await import("./auth.config");
const authConfigForChannel = Reflect.get(authModule, "authConfigForChannel") as
  | ((channel: unknown) => AuthConfig)
  | undefined;

afterAll(() => {
  if (previousChannel === undefined) {
    delete process.env.QALI_LOCAL_AUTH_CHANNEL;
  } else {
    process.env.QALI_LOCAL_AUTH_CHANNEL = previousChannel;
  }
});

describe("local Convex auth configuration", () => {
  test.each([
    ["stable", "http://127.0.0.1:3212"],
    ["development", "http://127.0.0.1:3312"],
    ["test", "http://127.0.0.1:3412"],
  ] as const)(
    "%s selects only its exact issuer and JWKS",
    (channel: string, issuer: string) => {
      expect(authConfigForChannel?.(channel)).toEqual({
        providers: [
          {
            type: "customJwt",
            applicationID: "qali-local-convex",
            issuer,
            jwks: `${issuer}/jwks.json`,
            algorithm: "RS256",
          },
        ],
      });
    },
  );

  test("missing channel fails closed", () => {
    expect(() => authConfigForChannel?.(undefined)).toThrow(
      "QALI_LOCAL_AUTH_CHANNEL_REQUIRED",
    );
  });

  test("forged channel fails closed", () => {
    expect(() => authConfigForChannel?.("forged")).toThrow(
      "QALI_LOCAL_AUTH_CHANNEL_INVALID",
    );
  });
});
