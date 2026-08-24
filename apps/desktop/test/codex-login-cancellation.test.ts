import { expect, test } from "bun:test";

import {
  createCodexLoginEventChannel,
  subscribeCodexLoginEvents,
} from "../src/main/codex/events";
import {
  superviseCodexDeviceLogin,
  type CodexSpawn,
} from "../src/main/codex/process-driver";

test("an abort during deferred credential verification prevents login process spawn", async () => {
  const channel = createCodexLoginEventChannel();
  const unsubscribe = subscribeCodexLoginEvents(channel, () => {});
  let verificationStarted!: () => void;
  const started = new Promise<void>((resolvePromise) => {
    verificationStarted = resolvePromise;
  });
  let releaseVerification!: () => void;
  const verification = new Promise<void>((resolvePromise) => {
    releaseVerification = resolvePromise;
  });
  const controller = new AbortController();
  let spawned = false;
  const result = superviseCodexDeviceLogin({
    boundary: {
      codexHome: "/tmp/qali-cancel-before-driver-registration",
      cwd: "/tmp/qali-cancel-before-driver-registration",
      schemaPath: "/tmp/qali-cancel-before-driver-registration/schema.json",
      sandboxProfilePath: "/tmp/qali-cancel-before-driver-registration/profile.sb",
      manifest: {} as never,
      manifestPath: "/tmp/qali-cancel-before-driver-registration/manifest.json",
      proxy: {} as never,
      keyringHealthProbe: async () => {
        verificationStarted();
        await verification;
        return true;
      },
      loginEvents: channel,
    },
    verified: {
      executablePath: "/opt/homebrew/Caskroom/codex/0.147.0/bin/codex",
      proxyUrl: "http://127.0.0.1:43123",
      proxyEndpoint: "localhost:43123",
    },
    attemptId: `login_${"a".repeat(32)}`,
    signal: controller.signal,
    timeoutMs: 1_000,
  }, {
    spawnProcess: (() => {
      spawned = true;
      throw new Error("cancelled login must not spawn");
    }) as CodexSpawn,
  });

  await started;
  controller.abort();
  releaseVerification();

  await expect(result).rejects.toMatchObject({ code: "CODEX_CANCELLED" });
  expect(spawned).toBe(false);
  unsubscribe();
});
