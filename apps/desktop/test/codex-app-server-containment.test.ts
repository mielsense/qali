import { afterEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";

import { createContainedCodexAppServerClient } from "../src/main/codex/app-server-provider";
import {
  CODEX_APP_SERVER_ARGS,
  createCodexAppServerContainment,
  createCodexAppServerTestHarness,
  captureCodexSandboxProfileIdentity,
  auditCodexAppServerSandboxProfile,
  verifyCodexSandboxProfileIdentity,
} from "../src/main/codex/app-server-containment";
import type { CodexAppServerChild, CodexAppServerSpawn } from "../src/main/codex/app-server-driver";
import {
  createCodexAppServerContainmentAuthority,
  createCodexRuntimeAuthority,
  resolveCodexAppServerContainmentAuthority,
} from "../src/main/codex/boundary";
import { createCodexLoginEventChannel, subscribeCodexLoginEvents } from "../src/main/codex/events";
import {
  probeCodexEgressPolicy,
  startEgressProxy,
  type EgressProxy,
} from "../src/main/codex/egress-proxy";
import { loadCodexManifest, sha256File } from "../src/main/codex/manifest";

class FakeChild extends EventEmitter implements CodexAppServerChild {
  // Keep the synthetic process group clear of ordinary host PIDs so cleanup
  // observes ESRCH instead of probing an unrelated protected process group.
  pid = 404_404_404;
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  signals: NodeJS.Signals[] = [];
  private closeQueued = false;

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    this.signalCode = signal;
    if (!this.closeQueued) {
      this.closeQueued = true;
      queueMicrotask(() => this.emit("close"));
    }
    return true;
  }
}

const resources = resolve(import.meta.dir, "../resources");
const cleanups: Array<() => Promise<void>> = [];

const METADATA_PATH_PARAMETER_COUNT = 16;
const SYSTEM_REQUIREMENTS_PATH = "/etc/codex/requirements.toml";

function metadataPathDefinitions(paths: readonly string[]): string[] {
  const ancestors = new Set<string>();
  for (const path of [...paths, SYSTEM_REQUIREMENTS_PATH]) {
    let current = path;
    for (;;) {
      ancestors.add(current);
      const parent = resolve(current, "..");
      if (parent === current) break;
      current = parent;
    }
  }
  const values = [...ancestors];
  while (values.length < METADATA_PATH_PARAMETER_COUNT) values.push("/");
  return values.flatMap((path, index) => [
    "-D",
    `CODEX_METADATA_PATH_${index}=${path}`,
  ]);
}

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function validAuthority() {
  const manifest = await loadCodexManifest(join(resources, "codex-provider-manifest.json"));
  const root = await mkdtemp(join(tmpdir(), "qali-app-server-containment-"));
  const home = join(root, "home");
  const cwd = join(root, "cwd");
  await Promise.all([mkdir(home, { mode: 0o700 }), mkdir(cwd, { mode: 0o700 })]);
  const proxy = await startEgressProxy({
    allowedHosts: manifest.proxy.allowedHosts,
    allowedPorts: manifest.proxy.allowedPorts,
    expectedPolicySha256: manifest.proxy.policySha256,
  }, {
    listen: async () => 43_123,
    closeServer: async () => {},
  });
  const events = createCodexLoginEventChannel();
  const unsubscribe = subscribeCodexLoginEvents(events, () => {});
  cleanups.push(async () => { unsubscribe(); await proxy.close(); await rm(root, { force: true, recursive: true }); });
  const runtimeAuthority = await createCodexRuntimeAuthority({
    codexHome: home,
    cwd,
    proxy,
    keyringHealthProbe: async () => true,
    loginEvents: events,
  });
  const entry = manifest.appServerCompatibility![0]!;
  const authority = createCodexAppServerContainmentAuthority(runtimeAuthority, {
    executablePath: manifest.executable.resolvedPath,
    version: entry.version,
    arch: entry.architecture,
    format: entry.format,
    sha256: entry.sha256,
    generatedSchemaSha256: entry.generatedSchema.sha256,
  });
  return { authority, runtimeAuthority, home, cwd, manifest, proxy };
}

describe("Codex app-server retained containment", () => {
  test("live sandbox initializes Codex from isolated roots but denies external metadata", async () => {
    if (process.platform !== "darwin") return;
    const root = await mkdtemp(join(tmpdir(), "qali-app-server-metadata-"));
    const home = join(root, "home");
    const cwd = join(root, "cwd");
    await Promise.all([mkdir(home, { mode: 0o700 }), mkdir(cwd, { mode: 0o700 })]);
    const canonicalHome = await realpath(home);
    const canonicalCwd = await realpath(cwd);
    cleanups.push(() => rm(root, { force: true, recursive: true }));
    const args = [
      ...metadataPathDefinitions([canonicalHome, canonicalCwd]),
      "-D", `CODEX_HOME=${canonicalHome}`,
      "-D", `CODEX_CWD=${canonicalCwd}`,
      "-D", "CODEX_SCHEMA=/dev/null",
      "-D", "CODEX_EXECUTABLE=/usr/bin/stat",
      "-D", "CODEX_PROXY_ENDPOINT=localhost:9",
      "-f", join(resources, "codex-calendar.sb"),
      "/usr/bin/stat",
    ];
    const options = {
      cwd: canonicalCwd,
      env: {
        CODEX_HOME: canonicalHome,
        HOME: canonicalHome,
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        PATH: "/usr/bin:/bin",
        TMPDIR: canonicalHome,
      },
      encoding: "utf8" as const,
    };

    expect(spawnSync("/usr/bin/sandbox-exec", [...args, canonicalHome], options).status).toBe(0);
    expect(spawnSync("/usr/bin/sandbox-exec", [...args, "/etc/passwd"], options).status).not.toBe(0);

    const fixture = await validAuthority();
    const entry = fixture.manifest.appServerCompatibility[0]!;
    const client = await createContainedCodexAppServerClient(
      fixture.runtimeAuthority,
      {
        executablePath: fixture.manifest.executable.resolvedPath,
        version: entry.version,
        arch: entry.architecture,
        format: entry.format,
        sha256: entry.sha256,
        generatedSchemaSha256: entry.generatedSchema.sha256,
      },
    );
    try {
      const initialized = await client.initialize();
      expect(initialized).toBeObject();
      const account = await client.accountRead();
      expect(account).toBeObject();
    } finally {
      await client.close();
    }
  });

  test("canonicalizes isolated runtime roots before minting sandbox authority", async () => {
    const fixture = await validAuthority();
    const root = await mkdtemp(join(tmpdir(), "qali-app-server-canonical-"));
    const actual = join(root, "actual");
    const alias = join(root, "alias");
    await mkdir(actual, { mode: 0o700 });
    await symlink(actual, alias);
    const home = join(alias, "home");
    const cwd = join(alias, "cwd");
    await Promise.all([mkdir(home, { mode: 0o700 }), mkdir(cwd, { mode: 0o700 })]);
    const events = createCodexLoginEventChannel();
    const unsubscribe = subscribeCodexLoginEvents(events, () => {});
    cleanups.push(async () => {
      unsubscribe();
      await rm(root, { force: true, recursive: true });
    });

    const authority = await createCodexRuntimeAuthority({
      codexHome: home,
      cwd,
      proxy: fixture.proxy,
      keyringHealthProbe: async () => true,
      loginEvents: events,
    });
    const entry = fixture.manifest.appServerCompatibility[0]!;
    const containmentAuthority = createCodexAppServerContainmentAuthority(
      authority,
      {
        executablePath: fixture.manifest.executable.resolvedPath,
        version: entry.version,
        arch: entry.architecture,
        format: entry.format,
        sha256: entry.sha256,
        generatedSchemaSha256: entry.generatedSchema.sha256,
      },
    );
    const boundary = resolveCodexAppServerContainmentAuthority(
      containmentAuthority,
    ).boundary;

    expect(boundary.codexHome).toBe(await realpath(home));
    expect(boundary.cwd).toBe(await realpath(cwd));
  });

  test("normal close awaits forced drain of a real captured process group", async () => {
    const fixture = await validAuthority();
    let child: ReturnType<typeof spawn> | undefined;
    const containment = await createCodexAppServerContainment(fixture.authority, {
      testHarness: createCodexAppServerTestHarness(
        (() => {
          child = spawn(
            process.execPath,
            [
              "-e",
              "process.on('SIGTERM', () => {}); process.stdin.resume(); process.stdout.write('ready'); setInterval(() => {}, 1000)",
            ],
            { detached: true, stdio: ["pipe", "pipe", "pipe"] },
          );
          return child as CodexAppServerChild;
        }) as CodexAppServerSpawn,
      ),
    });
    const owned = containment.spawn(CODEX_APP_SERVER_ARGS);
    await once(owned.stdout, "data");
    const pid = owned.pid!;

    try {
      await containment.close();
      expect(owned.exitCode !== null || owned.signalCode !== null).toBe(true);
      expect(() => process.kill(-pid, 0)).toThrow();
    } finally {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // The successful path has already drained the captured process group.
      }
    }
  });

  test("release drains descendants after the owned process leader has exited", async () => {
    const fixture = await validAuthority();
    let child: ReturnType<typeof spawn> | undefined;
    const containment = await createCodexAppServerContainment(fixture.authority, {
      // Bun's process.kill currently reports EPERM for a negative process-group
      // probe once the group leader exits. Use macOS' native kill utility here
      // so this real descendant-drain test exercises the intended syscall.
      processGroupAlive: (pid) =>
        spawnSync("/bin/kill", ["-0", `-${pid}`]).status === 0,
      signalOwnedGroup: (ownedChild, signal) => {
        const pid = ownedChild.pid;
        if (!pid) return;
        const result = spawnSync("/bin/kill", [
          `-${signal.replace("SIG", "")}`,
          `-${pid}`,
        ]);
        if (result.status !== 0) {
          const check = spawnSync("/bin/kill", ["-0", `-${pid}`]);
          if (check.status === 0) throw new Error("Failed to signal owned group");
        }
      },
      testHarness: createCodexAppServerTestHarness(
        (() => {
          child = spawn(
            process.execPath,
            [
              "-e",
              [
                "const { spawn } = require('node:child_process');",
                "const descendant = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\"], { stdio: 'ignore' });",
                "process.stdin.resume();",
                "setTimeout(() => process.stdout.write(String(descendant.pid)), 100);",
                "process.stdin.on('end', () => process.exit(0));",
              ].join(" "),
            ],
            { detached: true, stdio: ["pipe", "pipe", "pipe"] },
          );
          return child as CodexAppServerChild;
        }) as CodexAppServerSpawn,
      ),
    });
    const owned = containment.spawn(CODEX_APP_SERVER_ARGS);
    const [pidChunk] = await once(owned.stdout, "data") as [Buffer];
    const descendantPid = Number(pidChunk.toString("utf8"));
    const groupPid = owned.pid!;
    owned.stdin.end();
    await once(owned, "close");

    try {
      expect(() => process.kill(descendantPid, 0)).not.toThrow();
      await containment.release(owned);
      expect(() => process.kill(-groupPid, 0)).toThrow();
      expect(() => process.kill(descendantPid, 0)).toThrow();
    } finally {
      try {
        process.kill(-groupPid, "SIGKILL");
      } catch {
        // The successful path has already drained the captured process group.
      }
    }
  });

  test("retains a Task-1-compatible explicitly selected executable path", async () => {
    const fixture = await validAuthority();
    const entry = fixture.manifest.appServerCompatibility![0]!;
    const selectedPath = "/Applications/Codex Preview.app/Contents/MacOS/codex";
    const authority = createCodexAppServerContainmentAuthority(
      fixture.runtimeAuthority,
      {
        executablePath: selectedPath,
        version: entry.version,
        arch: entry.architecture,
        format: entry.format,
        sha256: entry.sha256,
        generatedSchemaSha256: entry.generatedSchema.sha256,
      },
    );
    let observed: Parameters<CodexAppServerSpawn> | undefined;
    const containment = await createCodexAppServerContainment(authority, {
      testHarness: createCodexAppServerTestHarness(
        ((...args) => {
          observed = args;
          return new FakeChild();
        }) as CodexAppServerSpawn,
      ),
    });

    containment.spawn(CODEX_APP_SERVER_ARGS);
    expect(observed?.[1]).toContain(`CODEX_EXECUTABLE=${selectedPath}`);
    expect(observed?.[1]).toContain(selectedPath);
    await containment.close();
  });

  test("launches only stdio v2 through the exact profile, proxy, and fresh environment", async () => {
    const fixture = await validAuthority();
    const canonicalHome = await realpath(fixture.home);
    const canonicalCwd = await realpath(fixture.cwd);
    const child = new FakeChild();
    let observed: Parameters<CodexAppServerSpawn> | undefined;
    const containment = await createCodexAppServerContainment(fixture.authority, {
      testHarness: createCodexAppServerTestHarness(
        ((...args) => { observed = args; return child; }) as CodexAppServerSpawn,
      ),
    });

    expect(containment.spawn(CODEX_APP_SERVER_ARGS)).toBe(child);
    expect(observed?.[0]).toBe("/usr/bin/sandbox-exec");
    expect(observed?.[1]).toEqual([
      ...metadataPathDefinitions([canonicalHome, canonicalCwd]),
      "-D", `CODEX_HOME=${canonicalHome}`,
      "-D", `CODEX_CWD=${canonicalCwd}`,
      "-D", `CODEX_SCHEMA=${join(resources, "codex-planner-output.schema.json")}`,
      "-D", `CODEX_EXECUTABLE=${fixture.manifest.executable.resolvedPath}`,
      "-D", `CODEX_PROXY_ENDPOINT=localhost:${fixture.proxy.port}`,
      "-f", join(resources, "codex-calendar.sb"),
      fixture.manifest.executable.resolvedPath,
      ...CODEX_APP_SERVER_ARGS,
    ]);
    expect(observed?.[2]).toMatchObject({
      cwd: canonicalCwd,
      detached: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        CODEX_HOME: canonicalHome,
        HOME: canonicalHome,
        TMPDIR: canonicalHome,
        PATH: "/usr/bin:/bin",
        HTTPS_PROXY: fixture.proxy.url,
        HTTP_PROXY: fixture.proxy.url,
      },
    });
    expect(observed?.[2].env.NO_PROXY).toBeUndefined();
    expect(observed?.[2].env.ALL_PROXY).toBeUndefined();
    expect(
      observed?.[1].filter((value) =>
        value.startsWith("CODEX_METADATA_PATH_"),
      ),
    ).toEqual(
      metadataPathDefinitions([canonicalHome, canonicalCwd]).filter((value) =>
        value.startsWith("CODEX_METADATA_PATH_"),
      ),
    );
    expect(() => containment.spawn(["app-server"] as never)).toThrow();
    await containment.close();
    expect(child.signals).toEqual(["SIGTERM"]);
  });

  test("rejects forged authority and changed installation evidence before spawn", async () => {
    await expect(createCodexAppServerContainment({ kind: "qali-codex-app-server-containment-authority" } as never)).rejects.toMatchObject({ code: "CODEX_CONTAINMENT_AUTHORITY_REQUIRED" });
    const fixture = await validAuthority();
    await expect(createCodexAppServerContainment(fixture.authority, {
      testHarness: { kind: "qali-codex-app-server-test-harness" },
    })).rejects.toMatchObject({ code: "CODEX_TEST_HARNESS_REQUIRED" });
    expect(() => createCodexAppServerContainmentAuthority(
      fixture.runtimeAuthority,
      {
        executablePath: fixture.manifest.executable.resolvedPath,
        version: fixture.manifest.executable.version,
        arch: "arm64",
        format: fixture.manifest.executable.format,
        sha256: "0".repeat(64),
        generatedSchemaSha256: fixture.manifest.appServerCompatibility![0]!.generatedSchema.sha256,
      },
    )).toThrow();
  });

  test("audits the committed profile as deny-default and rejects broadened authority", async () => {
    const profile = await readFile(join(resources, "codex-calendar.sb"), "utf8");
    expect(auditCodexAppServerSandboxProfile(profile)).toEqual({
      defaultDeny: true,
      initialExecutableOnly: true,
      childProcessesDenied: true,
      inboundAndListenersDenied: true,
      genericIpcDenied: true,
      readsRestricted: true,
      writesRestrictedToIsolatedHome: true,
      outboundRestrictedToCapturedProxy: true,
    });
    expect(() => auditCodexAppServerSandboxProfile(`${profile}\n(allow process-fork)`)).toThrow();
    expect(() => auditCodexAppServerSandboxProfile(`${profile}\n(allow network-inbound)`)).toThrow();
    expect(() => auditCodexAppServerSandboxProfile(`${profile}\n(allow file-read* (subpath "/Users"))`)).toThrow();
    expect(() => auditCodexAppServerSandboxProfile(`${profile}\n(allow file-read*)`)).toThrow();
    expect(() => auditCodexAppServerSandboxProfile(`${profile}\n(allow file-read* (subpath (param "CALLER_PATH")))`)).toThrow();
    expect(() => auditCodexAppServerSandboxProfile(`${profile}\n(allow signal)`)).toThrow();
    expect(() => auditCodexAppServerSandboxProfile(`${profile}\n(allow network-outbound)`)).toThrow();
    expect(await sha256File(join(resources, "codex-calendar.sb"))).toBe((await loadCodexManifest(join(resources, "codex-provider-manifest.json"))).sandbox.sha256);
  });

  test("rejects descendant-only reads that prevent Codex from canonicalizing its isolated roots", async () => {
    const profile = await readFile(join(resources, "codex-calendar.sb"), "utf8");
    const descendantOnly = profile
      .replace('  (literal (param "CODEX_HOME"))\n', "")
      .replace('  (literal (param "CODEX_CWD"))\n', "");

    expect(() => auditCodexAppServerSandboxProfile(descendantOnly)).toThrow();
  });

  test("requires exact metadata-only ancestor filters for isolated-root canonicalization", async () => {
    const profile = await readFile(join(resources, "codex-calendar.sb"), "utf8");
    const metadataStart = profile.indexOf("(allow file-read-metadata");
    const metadataEnd = profile.indexOf("\n(allow file-read*", metadataStart);
    const withoutMetadata =
      profile.slice(0, metadataStart) + profile.slice(metadataEnd + 1);
    const globalMetadata =
      profile.slice(0, metadataStart) +
      "(allow file-read-metadata)\n" +
      profile.slice(metadataEnd + 1);

    expect(() => auditCodexAppServerSandboxProfile(withoutMetadata)).toThrow();
    expect(() => auditCodexAppServerSandboxProfile(globalMetadata)).toThrow();
  });

  test("classifies only exact manifest HTTPS destinations as provider egress", async () => {
    const { manifest } = await validAuthority();
    for (const url of ["https://api.openai.com/v1/responses", "https://auth.openai.com/codex/device", "https://chatgpt.com/backend-api/codex"]) {
      expect(probeCodexEgressPolicy(url, manifest.proxy.allowedHosts, manifest.proxy.allowedPorts)).toEqual({ kind: "allowed-provider-endpoint" });
    }
    for (const url of [
      "https://example.com",
      "https://127.0.0.1",
      "https://api.openai.com:444",
      "http://api.openai.com",
      "https://user@api.openai.com",
      "file:///etc/passwd",
    ]) {
      expect(probeCodexEgressPolicy(url, manifest.proxy.allowedHosts, manifest.proxy.allowedPorts)).toEqual({ kind: "controlled-denial" });
    }
  });

  test("refuses spawn after the captured Qali proxy closes", async () => {
    const fixture = await validAuthority();
    let spawned = false;
    const containment = await createCodexAppServerContainment(fixture.authority, {
      testHarness: createCodexAppServerTestHarness(
        (() => { spawned = true; return new FakeChild(); }) as CodexAppServerSpawn,
      ),
    });
    await fixture.proxy.close();
    expect(() => containment.spawn(CODEX_APP_SERVER_ARGS)).toThrow();
    expect(spawned).toBe(false);
    await containment.close();
  });

  test("prevents captured proxy allowlist mutation after authority minting", async () => {
    const fixture = await validAuthority();
    let spawned = false;
    const containment = await createCodexAppServerContainment(fixture.authority, {
      testHarness: createCodexAppServerTestHarness(
        (() => { spawned = true; return new FakeChild(); }) as CodexAppServerSpawn,
      ),
    });

    expect(() => (fixture.proxy.allowedHosts as string[]).push("example.com")).toThrow();
    expect(spawned).toBe(false);
    await containment.close();
  });

  test("freezes the captured proxy identity so port and URL cannot drift together", async () => {
    const fixture = await validAuthority();

    expect(Object.isFrozen(fixture.proxy)).toBe(true);
    expect(Object.isFrozen(fixture.proxy.allowedHosts)).toBe(true);
    expect(Object.isFrozen(fixture.proxy.allowedPorts)).toBe(true);
    expect(() => Object.assign(fixture.proxy, {
      port: fixture.proxy.port + 1,
      url: `http://127.0.0.1:${fixture.proxy.port + 1}`,
    })).toThrow();
  });

  test("rejects a same-content sandbox profile replacement by captured identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "qali-profile-identity-"));
    cleanups.push(() => rm(root, { force: true, recursive: true }));
    const profile = await readFile(join(resources, "codex-calendar.sb"), "utf8");
    const path = join(root, "codex-calendar.sb");
    const replacement = join(root, "replacement.sb");
    await writeFile(path, profile);
    await writeFile(replacement, profile);
    const identity = captureCodexSandboxProfileIdentity(path);

    await rename(replacement, path);

    expect(() => verifyCodexSandboxProfileIdentity(path, identity)).toThrow();
  });

  test("releases only one captured generation and reserves host close for the rest", async () => {
    const fixture = await validAuthority();
    const first = new FakeChild();
    const second = new FakeChild();
    const queue = [first, second];
    const containment = await createCodexAppServerContainment(fixture.authority, {
      testHarness: createCodexAppServerTestHarness(
        (() => queue.shift()!) as CodexAppServerSpawn,
      ),
    });
    containment.spawn(CODEX_APP_SERVER_ARGS);
    containment.spawn(CODEX_APP_SERVER_ARGS);

    await containment.release(first);

    expect(first.signals).toEqual(["SIGTERM"]);
    expect(second.signals).toEqual([]);
    await containment.close();
    expect(second.signals).toEqual(["SIGTERM"]);
  });

  test("freezes every public containment method before ownership is minted", async () => {
    const fixture = await validAuthority();
    const child = new FakeChild();
    let replacementInvoked = false;
    const containment = await createCodexAppServerContainment(fixture.authority, {
      testHarness: createCodexAppServerTestHarness(
        (() => child) as CodexAppServerSpawn,
      ),
    });

    expect(Object.isFrozen(containment)).toBe(true);
    expect(() => Object.assign(containment, {
      spawn() {
        replacementInvoked = true;
        return new FakeChild();
      },
    })).toThrow();
    expect(containment.spawn(CODEX_APP_SERVER_ARGS)).toBe(child);
    expect(replacementInvoked).toBe(false);
    await containment.close();
  });

  test("rejects a nonempty working directory before exposing spawn", async () => {
    const fixture = await validAuthority();
    await writeFile(join(fixture.cwd, "repository-canary"), "must remain outside Codex");

    await expect(createCodexAppServerContainment(fixture.authority, {
      testHarness: createCodexAppServerTestHarness(
        (() => new FakeChild()) as CodexAppServerSpawn,
      ),
    })).rejects.toMatchObject({ code: "CODEX_WORK_ROOT_NOT_EMPTY" });
  });

  test("rejects file credentials while allowing the stable isolated home", async () => {
    const fixture = await validAuthority();
    await writeFile(join(fixture.home, "auth.json"), "{}", { mode: 0o600 });

    await expect(createCodexAppServerContainment(fixture.authority, {
      testHarness: createCodexAppServerTestHarness(
        (() => new FakeChild()) as CodexAppServerSpawn,
      ),
    })).rejects.toMatchObject({ code: "CODEX_FILE_CREDENTIALS" });
  });
});
