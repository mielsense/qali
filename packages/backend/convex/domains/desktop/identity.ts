import type { Auth } from "convex/server";

export const LOCAL_AUTH_ISSUERS = Object.freeze({
  stable: "http://127.0.0.1:3212",
  development: "http://127.0.0.1:3312",
  test: "http://127.0.0.1:3412",
} as const);

export const LOCAL_AUTH_AUDIENCE = "qali-local-convex";
export const LOCAL_AUTH_SUBJECT = "qali-local-user";

export type LocalDesktopRole = "renderer" | "desktop_broker";

export type LocalUser = Readonly<{
  id: typeof LOCAL_AUTH_SUBJECT;
  email: string;
  name: string;
  image?: string;
}>;

export type LocalIdentityContext = Readonly<{ auth: Auth }>;

type ValidatedLocalIdentity = Readonly<{
  role: LocalDesktopRole;
  user: LocalUser;
}>;

const issuerSet = new Set<string>(Object.values(LOCAL_AUTH_ISSUERS));

async function readLocalIdentity(
  ctx: LocalIdentityContext,
): Promise<ValidatedLocalIdentity | null> {
  const identity = await ctx.auth.getUserIdentity();
  if (identity === null) return null;

  const role = identity.role;
  if (
    identity.subject !== LOCAL_AUTH_SUBJECT ||
    !issuerSet.has(identity.issuer) ||
    (role !== "renderer" && role !== "desktop_broker") ||
    typeof identity.email !== "string" ||
    identity.email.length === 0 ||
    typeof identity.name !== "string" ||
    identity.name.length === 0 ||
    (identity.pictureUrl !== undefined &&
      typeof identity.pictureUrl !== "string")
  ) {
    throw new Error("LOCAL_IDENTITY_REQUIRED");
  }

  return {
    role,
    user: {
      id: LOCAL_AUTH_SUBJECT,
      email: identity.email,
      name: identity.name,
      ...(identity.pictureUrl ? { image: identity.pictureUrl } : {}),
    },
  };
}

/**
 * Returns the renderer's stable local user, or null when no token is present.
 * A broker token is authenticated but intentionally rejected at this boundary.
 */
export async function optionalLocalUser(
  ctx: LocalIdentityContext,
): Promise<LocalUser | null> {
  const identity = await readLocalIdentity(ctx);
  if (identity === null) return null;
  if (identity.role !== "renderer") throw new Error("RENDERER_REQUIRED");
  return identity.user;
}

export async function requireRenderer(
  ctx: LocalIdentityContext,
): Promise<LocalUser> {
  const user = await optionalLocalUser(ctx);
  if (user === null) throw new Error("RENDERER_REQUIRED");
  return user;
}

export async function requireDesktopBroker(
  ctx: LocalIdentityContext,
): Promise<LocalUser> {
  const identity = await readLocalIdentity(ctx);
  if (identity?.role !== "desktop_broker") {
    throw new Error("DESKTOP_BROKER_REQUIRED");
  }
  return identity.user;
}
