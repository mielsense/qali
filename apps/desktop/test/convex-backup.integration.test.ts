import { afterEach, describe, expect, test } from "bun:test";

import {
  restorePinnedConvexBackup,
  startAuthenticatedPinnedConvex,
  type PinnedConvexFixture,
} from "./pinned-convex-fixture";

const fixtures: PinnedConvexFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
});

describe("real pinned local Convex cold backup", () => {
  test(
    "reopens representative calendar, queue, assistant, module, storage, and marker state",
    async () => {
      const fixture = await startAuthenticatedPinnedConvex();
      fixtures.push(fixture);
      const expected = await fixture.seedRepresentativeRows();
      const snapshot = await fixture.stopAndCreateColdBackup(
        "task-6-representative-build",
      );

      const restored = await restorePinnedConvexBackup({
        ...snapshot,
        // The reopened fixture must read the marker from restored backup state,
        // never trust this caller-owned closure value.
        buildMarker: "forged-closure-marker",
      });
      fixtures.push(restored);
      await expect(restored.readRepresentativeRows(expected)).resolves.toEqual({
        calendarRows: 1,
        eventRows: 1,
        pendingOperationRows: 1,
        assistantMessageRows: 2,
        buildMarker: "task-6-representative-build",
        settingsRevision: 41,
      });
    },
    120_000,
  );
});
