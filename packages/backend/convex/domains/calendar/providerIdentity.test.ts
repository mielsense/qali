// @ts-expect-error Bun supplies its test module at runtime.
import { describe, expect, test } from "bun:test";

import {
  googleAccountIdForSubject,
  googleCalendarKey,
} from "./providerIdentity";

describe("Google provider identity", () => {
  test("derives the versioned desktop account id from the immutable Google subject", async () => {
    expect(await googleAccountIdForSubject("subject-123")).toBe(
      "gacc_abnt2gG_xN1NFz4bgEljgydhfD2D9wHzlVU7OgcMk_E",
    );
  });

  test("namespaces a provider calendar id by account before hashing it", async () => {
    expect(await googleCalendarKey("gacc_test", "primary")).toBe(
      "gcal_svvl-8R2rECvGd1C-cz73klhl_oeL9O0OTbx-LZsEWM",
    );
  });

  test("rejects empty or control-bearing provider identity", async () => {
    await expect(googleAccountIdForSubject("")).rejects.toThrow(
      "GOOGLE_SUBJECT_INVALID",
    );
    await expect(googleCalendarKey("gacc_test", "bad\0calendar")).rejects.toThrow(
      "GOOGLE_CALENDAR_ID_INVALID",
    );
  });
});
