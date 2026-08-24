// @ts-expect-error Bun supplies its test module at runtime; the web app's
// TypeScript config intentionally includes browser globals only.
import { expect, test } from "bun:test";

import { updateInstallCopy } from "./update-install-dialog";

test("the update confirmation names the exact version and restart impact", () => {
  expect(updateInstallCopy("0.2.0")).toEqual({
    title: "Install Qali 0.2.0 and restart?",
    description:
      "Qali will finish its current calendar sync, close safely, install the verified update, and reopen. Unsaved event drafts will be interrupted.",
    confirmLabel: "Install and restart",
  });
});
