import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  createCodexAppServerHost,
  createContainedCodexAppServerClient,
} from "../src/main/codex/app-server-provider";
import { resolveCodexInstallation } from "../src/main/codex/app-server-compatibility";
import { createCodexRuntimeAuthority } from "../src/main/codex/boundary";
import { startEgressProxy } from "../src/main/codex/egress-proxy";
import {
  createCodexLoginEventChannel,
  subscribeCodexLoginEvents,
} from "../src/main/codex/events";
import { loadCodexManifest } from "../src/main/codex/manifest";

test("opt-in: retained Codex host reaches an actionable account state", async () => {
  if (process.env.QALI_LIVE_CODEX_HOST !== "1") return;
  const root = await mkdtemp(join(tmpdir(), "qali-live-codex-host-"));
  const home = join(root, "home");
  const work = join(root, "work");
  await Promise.all([
    mkdir(home, { mode: 0o700 }),
    mkdir(work, { mode: 0o700 }),
  ]);
  const manifest = await loadCodexManifest(
    resolve(import.meta.dir, "../resources/codex-provider-manifest.json"),
  );
  const proxy = await startEgressProxy({
    allowedHosts: manifest.proxy.allowedHosts,
    allowedPorts: manifest.proxy.allowedPorts,
    expectedPolicySha256: manifest.proxy.policySha256,
  });
  const loginEvents = createCodexLoginEventChannel();
  const unsubscribe = subscribeCodexLoginEvents(loginEvents, () => {});
  const authority = await createCodexRuntimeAuthority({
    codexHome: home,
    cwd: work,
    proxy,
    keyringHealthProbe: async () => false,
    loginEvents,
  });
  const host = createCodexAppServerHost({
    resolveInstallation: () => resolveCodexInstallation({ manifest }),
    createClient: (evidence) =>
      createContainedCodexAppServerClient(authority, evidence),
    probeReadiness: async () => ({ kind: "ready-degraded" }),
    waitForLoginCompletion: async () => {},
    loginEvents,
    workRoot: work,
  });

  try {
    expect(await host.status()).toEqual({ kind: "probing" });
    const status = await host.status();
    expect(["authentication-required", "ready-degraded"]).toContain(
      status.kind,
    );
  } finally {
    await host.close();
    unsubscribe();
    await proxy.close();
    await rm(root, { force: true, recursive: true });
  }
}, 30_000);
