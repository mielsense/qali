// @ts-expect-error Bun supplies its test module at runtime.
import { describe, expect, test } from "bun:test";

import { claimEventCreateSubmission } from "./event-create-submission";

describe("event create submission", () => {
  test("admits only one submit in the same render frame", () => {
    const latch = { current: false };

    expect(claimEventCreateSubmission(latch)).toBe(true);
    expect(claimEventCreateSubmission(latch)).toBe(false);
  });
});
