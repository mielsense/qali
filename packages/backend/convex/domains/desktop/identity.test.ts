// @ts-expect-error Bun supplies its test module at runtime.
import { describe, expect, test } from "bun:test";
import type { UserIdentity } from "convex/server";

import {
  LOCAL_AUTH_ISSUERS,
  optionalLocalUser,
  requireDesktopBroker,
  requireRenderer,
} from "./identity";

type IdentityContext = Parameters<typeof optionalLocalUser>[0];

function fakeCtx(claims: Partial<UserIdentity> | null): IdentityContext {
  const identity =
    claims === null
      ? null
      : ({
          tokenIdentifier: `${claims.issuer ?? LOCAL_AUTH_ISSUERS.test}|${claims.subject ?? "qali-local-user"}`,
          issuer: LOCAL_AUTH_ISSUERS.test,
          subject: "qali-local-user",
          email: "local@qali.app",
          name: "Qali User",
          ...claims,
        } satisfies UserIdentity);
  return {
    auth: {
      getUserIdentity: async () => identity,
    },
  };
}

describe("local desktop identity roles", () => {
  test("renderer cannot claim broker work", async () => {
    const ctx = fakeCtx({ role: "renderer" });

    await expect(requireDesktopBroker(ctx)).rejects.toThrow(
      "DESKTOP_BROKER_REQUIRED",
    );
  });

  test("broker identity is not accepted by renderer functions", async () => {
    const ctx = fakeCtx({ role: "desktop_broker" });

    await expect(requireRenderer(ctx)).rejects.toThrow("RENDERER_REQUIRED");
  });

  test("renderer returns the stable local user projection", async () => {
    const user = await requireRenderer(
      fakeCtx({
        role: "renderer",
        email: "owner@example.test",
        name: "Owner",
        pictureUrl: "https://example.test/avatar.png",
      }),
    );

    expect(user).toEqual({
      id: "qali-local-user",
      email: "owner@example.test",
      name: "Owner",
      image: "https://example.test/avatar.png",
    });
  });

  test("rejects a wrong subject or issuer before role authorization", async () => {
    await expect(
      requireRenderer(
        fakeCtx({
          role: "renderer",
          subject: "someone-else",
        }),
      ),
    ).rejects.toThrow("LOCAL_IDENTITY_REQUIRED");
    await expect(
      requireRenderer(
        fakeCtx({
          role: "renderer",
          issuer: "http://127.0.0.1:65535",
        }),
      ),
    ).rejects.toThrow("LOCAL_IDENTITY_REQUIRED");
  });

  test("optional identity is null when no token is present", async () => {
    expect(await optionalLocalUser(fakeCtx(null))).toBeNull();
  });
});
