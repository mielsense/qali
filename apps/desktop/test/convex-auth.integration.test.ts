import { afterEach, describe, expect, test } from "bun:test";

import {
  startAuthenticatedPinnedConvex,
  type PinnedConvexFixture,
} from "./pinned-convex-fixture";

const fixtures: PinnedConvexFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
});

describe("real pinned local Convex authentication", () => {
  test(
    "enforces signature, issuer, audience, expiry, token refresh, and role",
    async () => {
      const deployment = await startAuthenticatedPinnedConvex();
      fixtures.push(deployment);

      await expect(
        deployment.renderer.query("calendar:listCalendars", {}),
      ).resolves.toEqual([]);
      await expect(
        deployment.renderer.mutation("desktopCalendar:leaseOperations", {
          accountId: "account_001",
          leaseId: "lease_0001",
        }),
      ).rejects.toThrow();
      await expect(
        deployment.broker.mutation("desktopCalendar:leaseOperations", {
          accountId: "account_001",
          leaseId: "lease_0001",
        }),
      ).resolves.toEqual([]);

      for (const token of await deployment.invalidTokens([
        "wrong-key",
        "wrong-issuer",
        "wrong-audience",
        "expired",
      ])) {
        await expect(
          deployment.client(token).query("calendar:listCalendars", {}),
        ).rejects.toThrow();
      }

      const refreshed = await deployment.freshRendererToken();
      await expect(
        deployment.client(refreshed).query("calendar:listCalendars", {}),
      ).resolves.toEqual([]);
    },
    120_000,
  );
});

