import { describe, expect, test } from "bun:test";

const module = await import("../src/main/packaged-smoke-scenario").catch(
  (error: unknown) => ({ error }),
);

describe("packaged smoke calendar state", () => {
  test("seeds a deterministic stable account and uses its local calendar key", async () => {
    expect("error" in module).toBe(false);
    if ("error" in module) return;
    const runScenario = (
      module as Record<string, unknown>
    ).runPackagedSmokeCalendarScenario as
      | ((options: {
          broker: Record<string, (...args: any[]) => unknown>;
          client: Record<string, (...args: any[]) => unknown>;
          phase: "seed" | "verify";
        }) => Promise<{ eventCount: number; pendingCount: number }>)
      | undefined;
    expect(typeof runScenario).toBe("function");
    if (!runScenario) return;

    const attached: unknown[][] = [];
    const applied: unknown[][] = [];
    const pendingScopes: unknown[][] = [];
    const actionInputs: Array<Record<string, unknown>> = [];
    let queryCount = 0;
    const result = await runScenario({
      broker: {
        attachGoogleAccount: async (...args: unknown[]) => {
          attached.push(args);
          return { claimedLegacy: false, connectionId: "connection" };
        },
        applyRemoteCalendars: async (...args: unknown[]) => {
          applied.push(args);
        },
        pendingOperationCount: async (...args: unknown[]) => {
          pendingScopes.push(args);
          return 2;
        },
      },
      client: {
        action: async (_reference: unknown, args: Record<string, unknown>) => {
          actionInputs.push(args);
          return args.summary === "Qali packaged smoke disposable"
            ? { localEventId: "qali-smoke-delete" }
            : {};
        },
        query: async () => {
          queryCount += 1;
          if (queryCount === 1) {
            return [{ _id: "kept", summary: "Qali packaged smoke" }];
          }
          if (queryCount === 2) {
            return [
              { _id: "kept", summary: "Qali packaged smoke edited" },
              {
                _id: "disposable",
                localEventId: "qali-smoke-delete",
                summary: "Qali packaged smoke disposable",
              },
            ];
          }
          return [{ _id: "kept", summary: "Qali packaged smoke edited" }];
        },
      },
      phase: "seed",
    });

    const accountId = "gacc_U0REpVWh0BpZkWb9Q-pjzBllr2glJYBRjdATcgXEIDc";
    const calendarId = "gcal_TzpXDIzFli9IF06gVYuO5qeHci0orVoBQ5uSuw77egk";
    expect(attached).toEqual([
      [
        {
          accountEmail: "packaged-smoke@qali.local",
          accountId,
          providerAccountId: "qali-packaged-smoke-subject-v1",
        },
      ],
    ]);
    expect(applied).toEqual([
      [
        accountId,
        [expect.objectContaining({ id: "qali-packaged-smoke-calendar-v1" })],
      ],
    ]);
    expect(
      actionInputs
        .filter((input) => typeof input.calendarId === "string")
        .map((input) => input.calendarId),
    ).toEqual([calendarId, calendarId]);
    expect(pendingScopes).toEqual([[accountId]]);
    expect(result).toEqual({ eventCount: 1, pendingCount: 2 });
  });

  test("requires the persisted edited event, offline queue, and deleted-event absence", () => {
    expect("error" in module).toBe(false);
    if ("error" in module) return;
    expect(
      module.assertPackagedSmokeState(
        [
          { localEventId: "qali-smoke-create", summary: "Qali packaged smoke edited" },
        ],
        2,
      ),
    ).toEqual({ eventCount: 1, pendingCount: 2 });
    expect(() => module.assertPackagedSmokeState([], 2)).toThrow(
      "PACKAGED_SMOKE_CALENDAR_STATE_INVALID",
    );
    expect(() =>
      module.assertPackagedSmokeState(
        [
          { localEventId: "qali-smoke-create", summary: "Qali packaged smoke edited" },
          { localEventId: "qali-smoke-delete", summary: "Qali packaged smoke disposable" },
        ],
        2,
      ),
    ).toThrow("PACKAGED_SMOKE_CALENDAR_STATE_INVALID");
    expect(() =>
      module.assertPackagedSmokeState(
        [{ localEventId: "qali-smoke-create", summary: "Qali packaged smoke edited" }],
        0,
      ),
    ).toThrow("PACKAGED_SMOKE_CALENDAR_STATE_INVALID");
  });
});
