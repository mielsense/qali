import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { join, resolve } from "node:path";
import { connect as connectSocket } from "node:net";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import {
  createCodexLoginEventChannel,
  parseCodexJsonLine,
  subscribeCodexLoginEvents,
} from "../src/main/codex/events";
import {
  capabilityEvidenceHash,
  loadCodexManifest,
  proxyPolicyHash,
  type CodexProviderManifest,
} from "../src/main/codex/manifest";
import {
  cancelCodexAttempt,
  runCodexPhase,
  runCodexReleasePhase,
  superviseCodexDeviceLogin,
  type CodexChild,
  type CodexSpawn,
} from "../src/main/codex/process-driver";
import {
  isPublicNetworkAddress,
  parseConnectAuthority,
  parseConnectRequest,
  startCapabilityProviderBoundary,
  startEgressProxy,
  type EgressProxy,
} from "../src/main/codex/egress-proxy";
import {
  createCodexReleaseAuthority,
  createCodexRuntimeAuthority,
  resolveCodexRuntimeAuthority,
  verifyCodexRuntimeBoundary,
} from "../src/main/codex/boundary";

class FakeChild extends EventEmitter implements CodexChild {
  pid = 4040;
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  signals: NodeJS.Signals[] = [];

  kill(signal: NodeJS.Signals = "SIGTERM") {
    this.signals.push(signal);
    this.signalCode = signal;
    queueMicrotask(() => {
      this.emit("exit", null, signal);
      this.emit("close", null, signal);
    });
    return true;
  }
}

function spawnFor(child: FakeChild): CodexSpawn {
  return ((command, args, options) => {
    expect(command).toBe("/usr/bin/sandbox-exec");
    const profileIndex = args.indexOf("-f");
    const executableIndex = args.indexOf("/opt/homebrew/Caskroom/codex/0.149.1/bin/codex");
    const innerSandboxIndex = args.indexOf("danger-full-access");
    expect(profileIndex).toBeGreaterThanOrEqual(0);
    expect(args[profileIndex + 1]).toBe(join(resources, "codex-calendar.sb"));
    expect(executableIndex).toBeGreaterThan(profileIndex);
    expect(innerSandboxIndex).toBeGreaterThan(executableIndex);
    expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(options.shell).toBe(false);
    queueMicrotask(() => child.emit("spawn"));
    return child;
  }) as CodexSpawn;
}

const request = {
  attemptId: "attempt-a",
  prompt: "private calendar request",
  codexHome: "/tmp/qali-codex-home",
  cwd: "/tmp/qali-codex-work",
  schemaPath: "/tmp/qali-schema.json",
  sandboxProfilePath: "/tmp/codex-calendar.sb",
  manifest: {
    formatVersion: 1,
    executable: {
      entryPath: "/opt/homebrew/bin/codex",
      resolvedPath: "/opt/homebrew/Caskroom/codex/0.149.1/bin/codex",
      version: "codex-cli 0.149.1",
      sha256: "f0d8762236594359b60cfbe17f4c7e945a3ce8d1c91e74778838c968d250fb6c",
      format: "Mach-O 64-bit executable arm64",
      architecture: "arm64",
    },
    sandbox: { path: "codex-calendar.sb", sha256: "a".repeat(64) },
    proxy: {
      allowedHosts: ["api.openai.com", "chatgpt.com"],
      allowedPorts: [443],
      policySha256: proxyPolicyHash(["api.openai.com", "chatgpt.com"], [443]),
    },
    capability: {
      status: "ready",
      toolInventory: [],
      denials: [],
      evidenceSha256: capabilityEvidenceHash([]),
    },
  } as CodexProviderManifest,
  manifestPath: resolve(import.meta.dir, "../resources/codex-provider-manifest.json"),
  proxy: {
    url: "http://127.0.0.1:43123",
    port: 43123,
    allowedHosts: ["api.openai.com", "chatgpt.com"],
    allowedPorts: [443],
    policySha256: proxyPolicyHash(["api.openai.com", "chatgpt.com"], [443]),
    isClosed: () => false,
  },
  keyringHealthProbe: async () => true,
  validateFinalOutput: () => {},
  timeoutMs: 1_000,
} as const;
const resources = resolve(import.meta.dir, "../resources");
const LOGIN_SUCCESS = `login_${"1".repeat(32)}`;
const LOGIN_MALFORMED = `login_${"2".repeat(32)}`;
const LOGIN_STATUS_FAILED = `login_${"3".repeat(32)}`;
const LOGIN_SINK_FAILURE = `login_${"4".repeat(32)}`;
const LOGIN_HANGING_SINK = `login_${"5".repeat(32)}`;
const LOGIN_UNSUBSCRIBE = `login_${"6".repeat(32)}`;
const LOGIN_CANCEL = `login_${"7".repeat(32)}`;
const LOGIN_TIMEOUT = `login_${"8".repeat(32)}`;
let releaseProxy: EgressProxy;

beforeAll(async () => {
  const committed = await loadCodexManifest(join(resources, "codex-provider-manifest.json"));
  releaseProxy = await startCapabilityProviderBoundary({
    allowedHosts: committed.proxy.allowedHosts,
    allowedPorts: committed.proxy.allowedPorts,
    expectedPolicySha256: committed.proxy.policySha256,
    async handleRequest(_request, response) { response.writeHead(404).end(); },
    releaseControls: {
      inventory: () => [],
      armToolAttempt: async () => { throw new Error("capability controller is unused in process tests"); },
      createCanary: async () => { throw new Error("canary controller is unused in process tests"); },
    },
  });
});

afterAll(async () => {
  await releaseProxy?.close();
});

async function runTestPhase(
  phase: typeof request,
  dependencies: Parameters<typeof runCodexReleasePhase>[1],
) {
  const authority = await createCodexReleaseAuthority({
    codexHome: phase.codexHome,
    cwd: phase.cwd,
    schemaPath: phase.schemaPath,
    proxy: releaseProxy,
    keyringHealthProbe: phase.keyringHealthProbe,
  });
  return runCodexReleasePhase({
    authority,
    attemptId: phase.attemptId,
    prompt: phase.prompt,
    timeoutMs: phase.timeoutMs,
    validateFinalOutput: phase.validateFinalOutput,
  }, dependencies);
}

function driverFor(child: FakeChild, executablePath = request.manifest.executable.resolvedPath) {
  return {
    spawnProcess: spawnFor(child),
    verifyBoundary: async () => ({
      executablePath,
      proxyUrl: request.proxy.url,
      proxyEndpoint: `localhost:${request.proxy.port}`,
    }),
    processGroupAlive: () => false,
    signalOwnedGroup: (ownedChild: CodexChild, signal: NodeJS.Signals) => { ownedChild.kill(signal); },
  };
}

function completeTurn(child: FakeChild, text: string): void {
  child.stdout.write(`${JSON.stringify({ type: "thread.started" })}\n`);
  child.stdout.write(`${JSON.stringify({ type: "turn.started" })}\n`);
  child.stdout.write(`${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } })}\n`);
  child.stdout.write(`${JSON.stringify({ type: "turn.completed" })}\n`);
  child.exitCode = 0;
  child.emit("exit", 0, null);
  child.emit("close", 0, null);
}

function loginBoundary(loginEvents = createCodexLoginEventChannel()) {
  return {
    boundary: {
      manifest: request.manifest,
      manifestPath: request.manifestPath,
      codexHome: request.codexHome,
      cwd: request.cwd,
      schemaPath: request.schemaPath,
      sandboxProfilePath: request.sandboxProfilePath,
      proxy: request.proxy,
      keyringHealthProbe: request.keyringHealthProbe,
      loginEvents,
    },
    verified: {
      executablePath: request.manifest.executable.resolvedPath,
      proxyUrl: request.proxy.url,
      proxyEndpoint: `localhost:${request.proxy.port}`,
    },
  };
}

function loginDriverFor(child: FakeChild) {
  return {
    spawnProcess: ((_command, args) => {
      expect(args).toContain("--device-auth");
      queueMicrotask(() => child.emit("spawn"));
      return child;
    }) as CodexSpawn,
    processGroupAlive: () => false,
  };
}

describe("bounded Codex JSONL", () => {
  test("accepts a closed final response event", () => {
    expect(parseCodexJsonLine(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "ok" } }))).toMatchObject({
      kind: "assistant-message",
      text: "ok",
    });
  });

  for (const line of [
    "not-json",
    JSON.stringify({ type: "future.executable.event", command: "touch /tmp/x" }),
    JSON.stringify({ type: "item.started", item: { type: "command_execution", command: "touch /tmp/x" } }),
    JSON.stringify({ type: "item.started", item: { type: "mcp_tool_call", server: "x" } }),
  ]) {
    test(`terminates malformed, unknown, or executable event: ${line.slice(0, 24)}`, () => {
      expect(() => parseCodexJsonLine(line)).toThrow();
    });
  }

  test("rejects oversized output before JSON parsing", () => {
    expect(() => parseCodexJsonLine(`{"type":"thread.started","pad":"${"x".repeat(70_000)}"}`)).toThrow();
  });

  test("accepts agent messages only when completed", () => {
    expect(() => parseCodexJsonLine(JSON.stringify({
      type: "item.started",
      item: { type: "agent_message", text: "untrusted" },
    }))).toThrow();
  });
});

describe("supervised subscription device login", () => {
  test("publishes the device challenge while login is pending, then proves ChatGPT authentication", async () => {
    const login = new FakeChild();
    const status = new FakeChild();
    const children = [login, status];
    const argv: string[][] = [];
    const channel = createCodexLoginEventChannel();
    const liveEvents: unknown[] = [];
    let challengeReceived!: () => void;
    const challenge = new Promise<void>((resolvePromise) => { challengeReceived = resolvePromise; });
    const unsubscribe = subscribeCodexLoginEvents(channel, async (envelope) => {
      liveEvents.push(envelope);
      if (envelope.event.kind === "challenge-code") challengeReceived();
    });
    let settled = false;
    const result = superviseCodexDeviceLogin({
      ...loginBoundary(channel),
      attemptId: LOGIN_SUCCESS,
      timeoutMs: 1_000,
    }, {
      spawnProcess: ((_command, args) => {
        argv.push(args);
        const child = children.shift()!;
        queueMicrotask(() => child.emit("spawn"));
        return child;
      }) as CodexSpawn,
      processGroupAlive: () => false,
    });
    void result.finally(() => { settled = true; });
    await new Promise((resolvePromise) => login.once("spawn", resolvePromise));
    login.stdout.write([
      "Preparing device code login",
      "Requesting a one-time code...",
      "https://auth.openai.com/codex/device",
      "ABCD-EFGH",
      "",
    ].join("\n"));
    await challenge;
    expect(settled).toBe(false);
    expect(children).toHaveLength(1);
    expect(liveEvents).toContainEqual({
      attemptId: LOGIN_SUCCESS,
      event: { kind: "challenge-code", code: "ABCD-EFGH" },
    });
    login.stdout.end("Successfully logged in.\n");
    login.exitCode = 0;
    login.emit("exit", 0, null);
    login.emit("close", 0, null);
    await new Promise((resolvePromise) => status.once("spawn", resolvePromise));
    status.stdout.end("Logged in using ChatGPT\n");
    status.exitCode = 0;
    status.emit("exit", 0, null);
    status.emit("close", 0, null);
    await expect(result).resolves.toMatchObject({
      events: [
        { kind: "progress", stage: "preparing" },
        { kind: "progress", stage: "requesting-code" },
        { kind: "challenge-url", url: "https://auth.openai.com/codex/device" },
        { kind: "challenge-code", code: "ABCD-EFGH" },
        { kind: "progress", stage: "credentials-stored" },
      ],
    });
    expect(argv).toHaveLength(2);
    expect(argv[0]).toContain("--device-auth");
    expect(argv[1]!.slice(-2)).toEqual(["login", "status"]);
    unsubscribe();
  });

  test("rejects malformed output and a status that is not authenticated", async () => {
    const malformed = new FakeChild();
    const malformedChannel = createCodexLoginEventChannel();
    const unsubscribeMalformed = subscribeCodexLoginEvents(malformedChannel, () => {});
    const malformedResult = superviseCodexDeviceLogin({
      ...loginBoundary(malformedChannel), attemptId: LOGIN_MALFORMED, timeoutMs: 1_000,
    }, loginDriverFor(malformed));
    await new Promise((resolvePromise) => malformed.once("spawn", resolvePromise));
    malformed.stdout.write("secret-shaped unknown output\n");
    await expect(malformedResult).rejects.toMatchObject({ code: "CODEX_LOGIN_PROTOCOL_INVALID" });
    unsubscribeMalformed();

    const login = new FakeChild();
    const status = new FakeChild();
    const children = [login, status];
    const statusChannel = createCodexLoginEventChannel();
    const unsubscribeStatus = subscribeCodexLoginEvents(statusChannel, () => {});
    const statusResult = superviseCodexDeviceLogin({
      ...loginBoundary(statusChannel), attemptId: LOGIN_STATUS_FAILED, timeoutMs: 1_000,
    }, {
      spawnProcess: ((_command, _args) => {
        const child = children.shift()!;
        queueMicrotask(() => child.emit("spawn"));
        return child;
      }) as CodexSpawn,
      processGroupAlive: () => false,
    });
    await new Promise((resolvePromise) => login.once("spawn", resolvePromise));
    login.stdout.end("https://auth.openai.com/codex/device\nABCD-EFGH\nSuccessfully logged in.\n");
    login.exitCode = 0;
    login.emit("exit", 0, null);
    login.emit("close", 0, null);
    await new Promise((resolvePromise) => status.once("spawn", resolvePromise));
    status.stdout.end("Not logged in\n");
    status.exitCode = 0;
    status.emit("exit", 0, null);
    status.emit("close", 0, null);
    await expect(statusResult).rejects.toMatchObject({ code: "CODEX_LOGIN_NOT_AUTHENTICATED" });
    unsubscribeStatus();
  });

  test("fails closed on sink failure or unsubscribe and still supports cancel and timeout", async () => {
    const sinkFailed = new FakeChild();
    const failedChannel = createCodexLoginEventChannel();
    subscribeCodexLoginEvents(failedChannel, () => { throw new Error("synthetic sink failure with secret"); });
    const failedResult = superviseCodexDeviceLogin({
      ...loginBoundary(failedChannel), attemptId: LOGIN_SINK_FAILURE, timeoutMs: 1_000,
    }, loginDriverFor(sinkFailed));
    await new Promise((resolvePromise) => sinkFailed.once("spawn", resolvePromise));
    sinkFailed.stdout.write("Preparing device code login\n");
    await expect(failedResult).rejects.toMatchObject({ code: "CODEX_LOGIN_EVENT_SINK_FAILED" });
    expect(sinkFailed.signals).toContain("SIGTERM");

    const hangingSink = new FakeChild();
    const hangingChannel = createCodexLoginEventChannel();
    let releaseHangingSink!: () => void;
    const hangingPublication = new Promise<void>((resolvePromise) => { releaseHangingSink = resolvePromise; });
    const unsubscribeHanging = subscribeCodexLoginEvents(hangingChannel, () => hangingPublication);
    const hangingResult = superviseCodexDeviceLogin({
      ...loginBoundary(hangingChannel), attemptId: LOGIN_HANGING_SINK, timeoutMs: 10,
    }, loginDriverFor(hangingSink));
    await new Promise((resolvePromise) => hangingSink.once("spawn", resolvePromise));
    hangingSink.stdout.write("Preparing device code login\n");
    const hangingOutcome = await Promise.race([
      hangingResult.catch((error) => error),
      new Promise((resolvePromise) => setTimeout(() => resolvePromise("did-not-settle"), 100)),
    ]);
    releaseHangingSink();
    await hangingResult.catch(() => {});
    expect(hangingOutcome).toMatchObject({ code: "CODEX_TIMEOUT" });
    unsubscribeHanging();

    const unsubscribed = new FakeChild();
    const unsubscribedChannel = createCodexLoginEventChannel();
    const unsubscribePending = subscribeCodexLoginEvents(unsubscribedChannel, () => {});
    const unsubscribedResult = superviseCodexDeviceLogin({
      ...loginBoundary(unsubscribedChannel), attemptId: LOGIN_UNSUBSCRIBE, timeoutMs: 1_000,
    }, loginDriverFor(unsubscribed));
    await new Promise((resolvePromise) => unsubscribed.once("spawn", resolvePromise));
    unsubscribePending();
    await expect(unsubscribedResult).rejects.toMatchObject({ code: "CODEX_LOGIN_EVENT_SINK_CLOSED" });
    expect(unsubscribed.signals).toContain("SIGTERM");

    const cancelled = new FakeChild();
    const cancelledChannel = createCodexLoginEventChannel();
    const unsubscribeCancelled = subscribeCodexLoginEvents(cancelledChannel, () => {});
    const cancelledResult = superviseCodexDeviceLogin({
      ...loginBoundary(cancelledChannel), attemptId: LOGIN_CANCEL, timeoutMs: 1_000,
    }, loginDriverFor(cancelled));
    await new Promise((resolvePromise) => cancelled.once("spawn", resolvePromise));
    expect(cancelCodexAttempt(LOGIN_CANCEL)).toBe(true);
    await expect(cancelledResult).rejects.toMatchObject({ code: "CODEX_CANCELLED" });
    unsubscribeCancelled();

    const timedOut = new FakeChild();
    const timeoutChannel = createCodexLoginEventChannel();
    const unsubscribeTimeout = subscribeCodexLoginEvents(timeoutChannel, () => {});
    const timeoutResult = superviseCodexDeviceLogin({
      ...loginBoundary(timeoutChannel), attemptId: LOGIN_TIMEOUT, timeoutMs: 10,
    }, loginDriverFor(timedOut));
    await expect(timeoutResult).rejects.toMatchObject({ code: "CODEX_TIMEOUT" });
    expect(timedOut.signals).toContain("SIGTERM");
    unsubscribeTimeout();
  });
});

describe("direct-child supervision", () => {
  test("application authority owns distinct committed planner and finalizer schemas", async () => {
    const authority = await createCodexRuntimeAuthority({
      codexHome: request.codexHome,
      cwd: request.cwd,
      schemaPath: "/tmp/forged-caller-schema.json",
      proxy: request.proxy,
      keyringHealthProbe: request.keyringHealthProbe,
      loginEvents: createCodexLoginEventChannel(),
    });

    expect(resolveCodexRuntimeAuthority(authority)).toMatchObject({
      phaseSchemaPaths: {
        planner: join(resources, "codex-planner-output.schema.json"),
        finalizer: join(resources, "codex-finalizer-output.schema.json"),
      },
    });
  });

  test("release execution selects the authority-owned schema for each phase", async () => {
    const authority = await createCodexReleaseAuthority({
      codexHome: request.codexHome,
      cwd: request.cwd,
      schemaPath: "/tmp/forged-caller-schema.json",
      proxy: releaseProxy,
      keyringHealthProbe: request.keyringHealthProbe,
    });
    const run = async (phase: "planner" | "finalizer", attemptId: string) => {
      const child = new FakeChild();
      let args: string[] = [];
      const result = runCodexReleasePhase(
        {
          authority,
          phase,
          attemptId,
          prompt: request.prompt,
          timeoutMs: request.timeoutMs,
          validateFinalOutput: () => {},
        } as never,
        {
          ...driverFor(child),
          spawnProcess: ((_command, invocationArgs) => {
            args = invocationArgs;
            queueMicrotask(() => child.emit("spawn"));
            return child;
          }) as CodexSpawn,
        },
      );
      await new Promise((resolvePromise) => child.once("spawn", resolvePromise));
      completeTurn(child, "{}");
      await result;
      const outputSchema = args.indexOf("--output-schema");
      expect(args[outputSchema + 1]).toBe(
        join(resources, `codex-${phase}-output.schema.json`),
      );
    };

    await run("planner", "phase-schema-planner");
    await run("finalizer", "phase-schema-finalizer");
  });

  test("a blocked committed manifest prevents every public spawn", async () => {
    const authority = await createCodexRuntimeAuthority({
      codexHome: request.codexHome,
      cwd: request.cwd,
      schemaPath: request.schemaPath,
      proxy: request.proxy,
      keyringHealthProbe: request.keyringHealthProbe,
      loginEvents: createCodexLoginEventChannel(),
    });
    let spawned = false;
    await expect(runCodexPhase({
      authority,
      attemptId: request.attemptId,
      prompt: request.prompt,
      timeoutMs: request.timeoutMs,
      validateFinalOutput: () => {},
    } as never, { spawnProcess: (() => { spawned = true; throw new Error("must not spawn"); }) as CodexSpawn })).rejects.toMatchObject({
      code: "CODEX_CAPABILITY_BLOCKED",
    });
    expect(spawned).toBe(false);
  });

  test("rejects a copied self-consistent resource set without application authority", async () => {
    const copied = await mkdtemp(join(tmpdir(), "qali-codex-copied-ready-"));
    let spawned = false;
    try {
      const blocked = await loadCodexManifest(join(resources, "codex-provider-manifest.json"));
      const ready = {
        ...blocked,
        capability: { status: "ready", toolInventory: [], denials: [], evidenceSha256: capabilityEvidenceHash([]) },
      } as CodexProviderManifest;
      await writeFile(join(copied, "codex-provider-manifest.json"), JSON.stringify(ready));
      await copyFile(join(resources, blocked.sandbox.path), join(copied, blocked.sandbox.path));
      await expect(runCodexPhase({
        authority: {
          manifest: ready,
          manifestPath: join(copied, "codex-provider-manifest.json"),
          sandboxProfilePath: join(copied, blocked.sandbox.path),
        },
        attemptId: "copied-ready",
        prompt: "must not run",
        timeoutMs: 1_000,
        validateFinalOutput: () => {},
      } as never, { spawnProcess: (() => { spawned = true; throw new Error("must not spawn"); }) as CodexSpawn })).rejects.toMatchObject({
        code: "CODEX_BOUNDARY_AUTHORITY_REQUIRED",
      });
    } finally {
      await rm(copied, { recursive: true, force: true });
    }
    expect(spawned).toBe(false);
  });

  test("does not expose mutable application resource identity through authority resolution", async () => {
    await expect(createCodexRuntimeAuthority({
      codexHome: request.codexHome,
      cwd: request.cwd,
      schemaPath: request.schemaPath,
      proxy: request.proxy,
      keyringHealthProbe: request.keyringHealthProbe,
      loginEvents: { kind: "qali-codex-login-events" },
    } as never)).rejects.toMatchObject({ code: "CODEX_LOGIN_EVENT_SINK_CLOSED" });
    const authority = await createCodexRuntimeAuthority({
      codexHome: request.codexHome,
      cwd: request.cwd,
      schemaPath: request.schemaPath,
      proxy: request.proxy,
      keyringHealthProbe: request.keyringHealthProbe,
      loginEvents: createCodexLoginEventChannel(),
    });
    const exposed = resolveCodexRuntimeAuthority(authority);
    (exposed.manifest.capability as { status: string }).status = "ready";
    expect(resolveCodexRuntimeAuthority(authority).manifest.capability.status).toBe("blocked");
  });

  test("release execution rejects raw caller-selected resource paths", async () => {
    let spawned = false;
    await expect(runCodexReleasePhase({
      ...request,
      testProvider: { id: "qali_fixture", baseUrl: request.proxy.url, model: "qali-test-model" },
    } as never, { spawnProcess: (() => { spawned = true; throw new Error("must not spawn"); }) as CodexSpawn })).rejects.toMatchObject({
      code: "CODEX_RELEASE_AUTHORITY_REQUIRED",
    });
    expect(spawned).toBe(false);
  });

  test("public execution rejects forged readiness and release execution rejects profile/proxy mismatches", async () => {
    const blocked = await loadCodexManifest(join(resources, "codex-provider-manifest.json"));
    const ready = {
      ...blocked,
      capability: { status: "ready", toolInventory: [], denials: [], evidenceSha256: capabilityEvidenceHash([]) },
    } as CodexProviderManifest;
    let spawned = false;
    const spawnProcess = (() => { spawned = true; throw new Error("must not spawn"); }) as CodexSpawn;
    await expect(runCodexPhase({
      ...request,
      manifest: ready,
      manifestPath: join(resources, "codex-provider-manifest.json"),
      sandboxProfilePath: join(resources, blocked.sandbox.path),
    } as never, { spawnProcess })).rejects.toMatchObject({ code: "CODEX_BOUNDARY_AUTHORITY_REQUIRED" });
    await expect(verifyCodexRuntimeBoundary({
      ...request,
      manifest: blocked,
      manifestPath: join(resources, "codex-provider-manifest.json"),
      sandboxProfilePath: join(resources, blocked.sandbox.path),
      proxy: { ...request.proxy, policySha256: "0".repeat(64) },
    }, { allowBlockedCapability: true })).rejects.toMatchObject({ code: "CODEX_PROXY_MISMATCH" });
    await expect(verifyCodexRuntimeBoundary({
      ...request,
      manifest: blocked,
      manifestPath: join(resources, "codex-provider-manifest.json"),
      sandboxProfilePath: join(resources, blocked.sandbox.path),
      proxy: request.proxy,
    }, { allowBlockedCapability: true })).rejects.toMatchObject({ code: "CODEX_PROXY_MISMATCH" });

    const copied = await mkdtemp(join(tmpdir(), "qali-codex-boundary-"));
    try {
      const copiedManifest = join(copied, "codex-provider-manifest.json");
      const copiedProfile = join(copied, blocked.sandbox.path);
      await copyFile(join(resources, "codex-provider-manifest.json"), copiedManifest);
      await writeFile(copiedProfile, "(version 1)\n(deny default)\n");
      await expect(verifyCodexRuntimeBoundary({
        ...request,
        manifest: blocked,
        manifestPath: copiedManifest,
        sandboxProfilePath: copiedProfile,
      }, { allowBlockedCapability: true })).rejects.toMatchObject({ code: "CODEX_SANDBOX_MISMATCH" });
    } finally {
      await rm(copied, { recursive: true, force: true });
    }
    expect(spawned).toBe(false);
  });

  test("refuses an unpinned executable before constructing the outer sandbox child", async () => {
    let spawned = false;
    await expect(runTestPhase(
      request,
      {
        spawnProcess: (() => { spawned = true; throw new Error("must not spawn"); }) as CodexSpawn,
        verifyBoundary: async () => ({
          executablePath: "/tmp/codex",
          proxyUrl: request.proxy.url,
          proxyEndpoint: `localhost:${request.proxy.port}`,
        }),
      },
    )).rejects.toMatchObject({ code: "CODEX_BINARY_INCOMPATIBLE" });
    expect(spawned).toBe(false);
  });

  test("keeps prompts on stdin and terminates an owned tool attempt", async () => {
    const child = new FakeChild();
    let stdin = "";
    child.stdin.on("data", (chunk) => { stdin += chunk.toString(); });
    const result = runTestPhase(request, driverFor(child));
    await new Promise((resolve) => child.once("spawn", resolve));
    child.stdout.write(`${JSON.stringify({ type: "item.started", item: { type: "command_execution", command: "id" } })}\n`);
    await expect(result).rejects.toMatchObject({ code: "CODEX_TOOL_ATTEMPT" });
    expect(stdin).toBe("private calendar request\n");
    expect(child.signals).toContain("SIGTERM");
  });

  test("times out, crashes, and cancels without leaking another attempt", async () => {
    const slow = new FakeChild();
    const other = new FakeChild();
    const slowRun = runTestPhase({ ...request, timeoutMs: 10 }, driverFor(slow));
    const otherRun = runTestPhase({ ...request, attemptId: "attempt-b", timeoutMs: 1_000 }, driverFor(other));
    await expect(slowRun).rejects.toMatchObject({ code: "CODEX_TIMEOUT" });
    expect(cancelCodexAttempt("attempt-a")).toBe(false);
    expect(cancelCodexAttempt("attempt-b")).toBe(true);
    await expect(otherRun).rejects.toMatchObject({ code: "CODEX_CANCELLED" });
    expect(slow.signals.length).toBeGreaterThan(0);
    expect(other.signals.length).toBeGreaterThan(0);
  });

  test("classifies an early process crash and drains bounded stderr", async () => {
    const child = new FakeChild();
    const result = runTestPhase(request, driverFor(child));
    await new Promise((resolve) => child.once("spawn", resolve));
    child.stderr.write("sensitive diagnostic".repeat(100));
    child.exitCode = 9;
    child.emit("exit", 9, null);
    child.emit("close", 9, null);
    await expect(result).rejects.toMatchObject({ code: "CODEX_PROCESS_FAILED" });
  });

  test("terminates a diagnostic flood instead of waiting for process exit", async () => {
    const child = new FakeChild();
    const result = runTestPhase(request, driverFor(child));
    await new Promise((resolve) => child.once("spawn", resolve));
    child.stderr.write("x".repeat(70_000));
    await expect(result).rejects.toMatchObject({ code: "CODEX_DIAGNOSTIC_OVERFLOW" });
  });

  test("does not settle a failed attempt until close, group drain, and final auth check", async () => {
    const child = new FakeChild();
    child.kill = (signal: NodeJS.Signals = "SIGTERM") => {
      child.signals.push(signal);
      return true;
    };
    let credentialChecks = 0;
    let settled = false;
    const result = runTestPhase({
      ...request,
      attemptId: "drain-before-settle",
      keyringHealthProbe: async () => { credentialChecks++; return true; },
    }, driverFor(child));
    const observedResult = result.then(
      (value) => { settled = true; return value; },
      (error: unknown) => { settled = true; return error as Error & { code?: string }; },
    );
    await new Promise((resolvePromise) => child.once("spawn", resolvePromise));
    child.stdout.write(`${JSON.stringify({ type: "item.started", item: { type: "command_execution" } })}\n`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    expect(settled).toBe(false);
    expect(credentialChecks).toBe(1);
    child.exitCode = 1;
    child.emit("exit", 1, null);
    child.emit("close", 1, null);
    expect(await observedResult).toMatchObject({ code: "CODEX_TOOL_ATTEMPT" });
    expect(credentialChecks).toBe(2);
  });

  test("a late auth.json appearing during termination overrides the original failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "qali-codex-late-auth-"));
    const home = join(root, "home");
    await mkdir(home);
    const child = new FakeChild();
    child.kill = (signal: NodeJS.Signals = "SIGTERM") => { child.signals.push(signal); return true; };
    try {
      const result = runTestPhase({
        ...request,
        attemptId: "late-auth-file",
        codexHome: home,
      }, driverFor(child));
      const observed = result.catch((error: unknown) => error as Error & { code?: string });
      await new Promise((resolvePromise) => child.once("spawn", resolvePromise));
      child.stdout.write(`${JSON.stringify({ type: "item.started", item: { type: "command_execution" } })}\n`);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
      await writeFile(join(home, "auth.json"), "{}");
      child.exitCode = 1;
      child.emit("exit", 1, null);
      child.emit("close", 1, null);
      expect(await observed).toMatchObject({ code: "CODEX_FILE_CREDENTIALS" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("requires ordered completion, fatal UTF-8, a final validator, and never exposes stderr", async () => {
    const failedTurn = new FakeChild();
    const failed = runTestPhase({
      ...request,
      attemptId: "turn-failed",
      keyringHealthProbe: async () => true,
      validateFinalOutput: () => {},
    } as never, driverFor(failedTurn));
    const failedError = failed.catch((error: unknown) => error as Error & { code?: string });
    await new Promise((resolvePromise) => failedTurn.once("spawn", resolvePromise));
    failedTurn.stderr.write("super-secret-provider-body");
    failedTurn.stdout.write(`${JSON.stringify({ type: "thread.started" })}\n`);
    failedTurn.stdout.write(`${JSON.stringify({ type: "turn.started" })}\n`);
    failedTurn.stdout.write(`${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "{}" } })}\n`);
    failedTurn.stdout.write(`${JSON.stringify({ type: "turn.failed" })}\n`);
    failedTurn.exitCode = 0;
    failedTurn.emit("exit", 0, null);
    failedTurn.emit("close", 0, null);
    const observedFailure = await failedError;
    expect(observedFailure.code).toBe("CODEX_PROTOCOL_INVALID");
    expect(observedFailure.message).not.toContain("super-secret-provider-body");

    const invalidUtf8 = new FakeChild();
    const invalid = runTestPhase({
      ...request,
      attemptId: "fatal-utf8",
      keyringHealthProbe: async () => true,
      validateFinalOutput: () => {},
    } as never, driverFor(invalidUtf8));
    const invalidError = invalid.catch((error: unknown) => error as Error & { code?: string });
    await new Promise((resolvePromise) => invalidUtf8.once("spawn", resolvePromise));
    invalidUtf8.stdout.write(Buffer.from([0xff, 0x0a]));
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    expect(invalidUtf8.signals).toContain("SIGTERM");
    expect(await invalidError).toMatchObject({ code: "CODEX_PROTOCOL_INVALID" });
  });

  test("resolves only after ordered turn completion, descendant drain, final auth, and output validation", async () => {
    const child = new FakeChild();
    const order: string[] = [];
    let groupAlive = true;
    let credentialChecks = 0;
    const result = runTestPhase({
      ...request,
      attemptId: "trusted-success",
      keyringHealthProbe: async () => { credentialChecks++; order.push(`auth-${credentialChecks}`); return true; },
      validateFinalOutput: (text) => { expect(text).toBe('{"answer":"ok"}'); order.push("validate"); },
    }, {
      ...driverFor(child),
      processGroupAlive: () => groupAlive,
      signalOwnedGroup: (_ownedChild, signal) => {
        order.push(`signal-${signal}`);
        groupAlive = false;
      },
    });
    await new Promise((resolvePromise) => child.once("spawn", resolvePromise));
    completeTurn(child, '{"answer":"ok"}');
    await expect(result).resolves.toMatchObject({ finalText: '{"answer":"ok"}' });
    expect(order).toEqual(["auth-1", "signal-SIGTERM", "auth-2", "validate"]);
  });

  test("rejects a completed response when the required closed-output validator fails", async () => {
    const child = new FakeChild();
    const result = runTestPhase({
      ...request,
      attemptId: "invalid-final-output",
      validateFinalOutput: () => { throw new Error("schema mismatch details"); },
    }, driverFor(child));
    await new Promise((resolvePromise) => child.once("spawn", resolvePromise));
    completeTurn(child, "{}");
    await expect(result).rejects.toMatchObject({ code: "CODEX_OUTPUT_INVALID" });
  });
});

describe("loopback CONNECT allowlist", () => {
  test("rejects a proxy policy hash mismatch before binding", async () => {
    await expect(startEgressProxy({
      allowedHosts: ["api.openai.com"],
      allowedPorts: [443],
      expectedPolicySha256: "0".repeat(64),
    } as never)).rejects.toMatchObject({ code: "CODEX_PROXY_MISMATCH" });
  });

  test("close prevents a deferred DNS handler from creating an upstream", async () => {
    let releaseLookup!: () => void;
    let lookupStarted!: () => void;
    const started = new Promise<void>((resolvePromise) => { lookupStarted = resolvePromise; });
    const policySha256 = proxyPolicyHash(["api.openai.com"], [443]);
    let upstreamConnections = 0;
    const proxy = await startEgressProxy({
      allowedHosts: ["api.openai.com"],
      allowedPorts: [443],
      expectedPolicySha256: policySha256,
    } as never, {
      lookup: async () => {
        lookupStarted();
        await new Promise<void>((resolvePromise) => { releaseLookup = resolvePromise; });
        return [{ address: "8.8.8.8", family: 4 }];
      },
      connect: () => { upstreamConnections++; throw new Error("must not connect after close"); },
    } as never);
    const client = connectSocket(proxy.port, "127.0.0.1");
    await new Promise<void>((resolvePromise, rejectPromise) => {
      client.once("connect", resolvePromise);
      client.once("error", rejectPromise);
    });
    client.write("CONNECT api.openai.com:443 HTTP/1.1\r\nHost: api.openai.com:443\r\n\r\n");
    await started;
    const closing = proxy.close();
    releaseLookup();
    await closing;
    client.destroy();
    expect(upstreamConnections).toBe(0);
    expect(proxy.isClosed()).toBe(true);
  });

  test("rejects private, reserved, documentation, and mapped DNS answers", () => {
    for (const address of [
      "0.0.0.0", "10.1.2.3", "100.64.0.1", "127.0.0.1", "169.254.1.1",
      "172.16.0.1", "192.0.2.1", "192.168.0.1", "198.18.0.1", "198.51.100.1",
      "203.0.113.1", "224.0.0.1", "240.0.0.1", "::", "::1", "::ffff:127.0.0.1",
      "fc00::1", "fe80::1", "2001:db8::1",
    ]) expect(isPublicNetworkAddress(address)).toBe(false);
    expect(isPublicNetworkAddress("8.8.8.8")).toBe(true);
    expect(isPublicNetworkAddress("2606:4700:4700::1111")).toBe(true);
  });

  test("accepts only exact committed HTTPS destinations", () => {
    expect(parseConnectAuthority("api.openai.com:443", ["api.openai.com"], [443])).toEqual({
      host: "api.openai.com",
      port: 443,
    });
  });

  test("rejects proxy credentials and host-header ambiguity", () => {
    expect(() => parseConnectRequest(
      "CONNECT api.openai.com:443 HTTP/1.1\r\nProxy-Authorization: Basic secret",
      ["api.openai.com"],
      [443],
    )).toThrow();
    expect(() => parseConnectRequest(
      "CONNECT api.openai.com:443 HTTP/1.1\r\nHost: evil.example:443",
      ["api.openai.com"],
      [443],
    )).toThrow();
  });

  for (const authority of [
    "api.openai.com:80",
    "evil.example:443",
    "api.openai.com.evil.example:443",
    "user@api.openai.com:443",
    "127.0.0.1:443",
    "[::1]:443",
    "api.openai.com:443/path",
  ]) {
    test(`rejects ambiguous or uncommitted destination ${authority}`, () => {
      expect(() => parseConnectAuthority(authority, ["api.openai.com"], [443])).toThrow();
    });
  }
});
