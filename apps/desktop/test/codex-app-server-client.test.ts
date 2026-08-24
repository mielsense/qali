import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";

import {
  createCodexAppServerClientV2,
  type CodexAppServerClientDeadlines,
} from "../src/main/codex/app-server-client-v2";
import {
  CODEX_APP_SERVER_ARGS,
  createCodexAppServerContainment,
  createCodexAppServerTestHarness,
  type CodexAppServerContainment,
} from "../src/main/codex/app-server-containment";
import { createCodexAppServerTransportGeneration } from "../src/main/codex/app-server-transport";
import {
  runCodexAppServerPhase,
  type CodexAppServerChild,
  type CodexAppServerSpawn,
} from "../src/main/codex/app-server-driver";
import {
  createCodexAppServerContainmentAuthority,
  createCodexRuntimeAuthority,
} from "../src/main/codex/boundary";
import { createCodexLoginEventChannel, subscribeCodexLoginEvents } from "../src/main/codex/events";
import { startEgressProxy } from "../src/main/codex/egress-proxy";
import { loadCodexManifest } from "../src/main/codex/manifest";

class ScriptedChild extends EventEmitter implements CodexAppServerChild {
  pid = undefined;
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  signals: NodeJS.Signals[] = [];
  requests: Record<string, unknown>[] = [];
  private closeQueued = false;

  constructor(handler: (request: Record<string, unknown>, child: ScriptedChild) => void) {
    super();
    let buffered = "";
    this.stdin.on("data", (chunk) => {
      buffered += chunk.toString("utf8");
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (line) {
          const request = JSON.parse(line) as Record<string, unknown>;
          this.requests.push(request);
          handler(request, this);
        }
        newline = buffered.indexOf("\n");
      }
    });
  }

  reply(value: unknown): void {
    this.stdout.emit("data", Buffer.from(`${JSON.stringify(value)}\n`));
  }

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

const deadlines: CodexAppServerClientDeadlines = {
  initializeMs: 1_000,
  accountReadMs: 1_000,
  accountLoginStartMs: 1_000,
  threadStartMs: 1_000,
  turnStartMs: 1_000,
  turnInterruptMs: 1_000,
};

const resources = resolve(import.meta.dir, "../resources");
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function genuineContainmentFor(
  spawnProcess: CodexAppServerSpawn,
): Promise<{ containment: CodexAppServerContainment; cwd: string }> {
  const manifest = await loadCodexManifest(join(resources, "codex-provider-manifest.json"));
  const root = await mkdtemp(join(tmpdir(), "qali-app-server-client-"));
  const home = join(root, "home");
  const cwd = join(root, "cwd");
  await Promise.all([mkdir(home, { mode: 0o700 }), mkdir(cwd, { mode: 0o700 })]);
  const proxy = await startEgressProxy({
    allowedHosts: manifest.proxy.allowedHosts,
    allowedPorts: manifest.proxy.allowedPorts,
    expectedPolicySha256: manifest.proxy.policySha256,
  }, {
    listen: async () => 43_124,
    closeServer: async () => {},
  });
  const events = createCodexLoginEventChannel();
  const unsubscribe = subscribeCodexLoginEvents(events, () => {});
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
  const containment = await createCodexAppServerContainment(authority, {
    testHarness: createCodexAppServerTestHarness(spawnProcess),
  });
  cleanups.push(async () => {
    await containment.close();
    unsubscribe();
    await proxy.close();
    await rm(root, { force: true, recursive: true });
  });
  return { containment, cwd: await realpath(cwd) };
}

function clientFor(child: ScriptedChild) {
  return createCodexAppServerClientV2(
    createCodexAppServerTransportGeneration(child, {
      maxFrameBytes: 2_048,
      maxReceiveBufferBytes: 4_096,
      maxPendingRequests: 8,
      maxQueuedWriteBytes: 4_096,
      maxStderrBytes: 256,
    }),
    { clientInfo: { name: "qali", title: "Qali", version: "0.1.0" }, deadlines },
  );
}

describe("Codex native app-server v2 client", () => {
  test("rejects raw spawn injection at the exported phase boundary", async () => {
    let spawned = false;
    await expect(runCodexAppServerPhase({
      attemptId: "raw-spawn-denied",
      executable: "/caller/controlled",
      home: "/caller/controlled",
      cwd: "/caller/controlled",
      prompt: "bounded",
      outputSchema: { type: "object" },
      timeoutMs: 1_000,
    }, {
      spawnProcess: (() => {
        spawned = true;
        throw new Error("raw spawn must not run");
      }),
    } as never)).rejects.toMatchObject({ code: "CODEX_CONTAINMENT_AUTHORITY_REQUIRED" });
    expect(spawned).toBe(false);
  });

  test("rejects a structurally forged containment at the exported phase boundary", async () => {
    const child = new ScriptedChild(() => {});
    let spawned = false;
    await expect(runCodexAppServerPhase({
      attemptId: "forged-containment-denied",
      executable: "/caller/controlled",
      home: "/caller/controlled",
      cwd: "/caller/controlled",
      prompt: "bounded",
      outputSchema: { type: "object" },
      timeoutMs: 1_000,
    }, {
      containment: {
        spawn() { spawned = true; return child; },
        async close() {},
      },
    } as never)).rejects.toMatchObject({ code: "CODEX_CONTAINMENT_AUTHORITY_REQUIRED" });
    expect(spawned).toBe(false);
  });

  test("the phase driver consumes only the fixed containment spawn surface", async () => {
    const child = new ScriptedChild((request, server) => {
      const id = request.id;
      if (request.method === "initialize") server.reply({ id, result: {} });
      if (request.method === "account/read") server.reply({ id, result: { account: { type: "chatgpt" }, requiresOpenaiAuth: true } });
      if (request.method === "thread/start") server.reply({ id, result: { thread: { id: "thread-contained" } } });
      if (request.method === "turn/start") {
        server.reply({ id, result: { turn: { id: "turn-contained" } } });
        server.reply({ method: "item/completed", params: { item: { type: "agentMessage", text: '{"contained":true}' } } });
        server.reply({ method: "turn/completed", params: { turn: { id: "turn-contained", status: "completed" } } });
      }
    });
    let spawns = 0;
    const { containment, cwd } = await genuineContainmentFor((() => {
      spawns++;
      return child;
    }) as CodexAppServerSpawn);

    await expect(runCodexAppServerPhase({
      attemptId: "contained-driver",
      executable: "/caller/must/not/control",
      home: "/caller/must/not/control",
      cwd: "/caller/must/not/control",
      prompt: "bounded",
      outputSchema: { type: "object" },
      timeoutMs: 1_000,
    }, { containment })).resolves.toEqual({ finalText: '{"contained":true}' });
    expect(spawns).toBe(1);
    expect(child.requests).toContainEqual({
      id: expect.any(Number),
      method: "thread/start",
      params: expect.objectContaining({ cwd }),
    });
    expect(child.signals).toEqual(["SIGTERM"]);
  });

  test("the phase driver settles an initialization rejection without a leaked terminal waiter", async () => {
    const child = new ScriptedChild((request, server) => {
      if (request.method === "initialize") {
        server.reply({ id: request.id, error: { code: -32602, message: "invalid" } });
      }
    });
    const { containment } = await genuineContainmentFor(
      (() => child) as CodexAppServerSpawn,
    );

    await expect(runCodexAppServerPhase({
      attemptId: "contained-initialize-rejection",
      executable: "/unused",
      home: "/unused",
      cwd: "/unused",
      prompt: "bounded",
      outputSchema: { type: "object" },
      timeoutMs: 1_000,
    }, { containment })).rejects.toMatchObject({ code: "CODEX_NATIVE_ERROR" });
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  test("phase cleanup releases only its generation from a shared containment", async () => {
    const sibling = new ScriptedChild(() => {});
    const phase = new ScriptedChild((request, server) => {
      const id = request.id;
      if (request.method === "initialize") server.reply({ id, result: {} });
      if (request.method === "account/read") server.reply({ id, result: { account: { type: "chatgpt" }, requiresOpenaiAuth: true } });
      if (request.method === "thread/start") server.reply({ id, result: { thread: { id: "thread-shared" } } });
      if (request.method === "turn/start") {
        server.reply({ id, result: { turn: { id: "turn-shared" } } });
        server.reply({ method: "item/completed", params: { item: { type: "agentMessage", text: '{"shared":true}' } } });
        server.reply({ method: "turn/completed", params: { turn: { id: "turn-shared", status: "completed" } } });
      }
    });
    const queue = [sibling, phase];
    const { containment } = await genuineContainmentFor(
      (() => queue.shift()!) as CodexAppServerSpawn,
    );
    containment.spawn(CODEX_APP_SERVER_ARGS);

    await expect(runCodexAppServerPhase({
      attemptId: "shared-containment-generation",
      executable: "/unused",
      home: "/unused",
      cwd: "/unused",
      prompt: "bounded",
      outputSchema: { type: "object" },
      timeoutMs: 1_000,
    }, { containment })).resolves.toEqual({ finalText: '{"shared":true}' });

    expect(phase.signals).toEqual(["SIGTERM"]);
    expect(sibling.signals).toEqual([]);
    await containment.close();
    expect(sibling.signals).toEqual(["SIGTERM"]);
  });

  test("performs the v2 handshake and typed account/thread/turn lifecycle", async () => {
    const child = new ScriptedChild((request, server) => {
      const id = request.id;
      switch (request.method) {
        case "initialize":
          server.reply({ id, result: { userAgent: "codex", platformFamily: "unix", platformOs: "macos" } });
          break;
        case "account/read":
          server.reply({ id, result: { account: { type: "chatgpt", planType: "plus" }, requiresOpenaiAuth: true } });
          break;
        case "account/login/start":
          server.reply({ id, result: { type: "chatgptDeviceCode", loginId: "login-1", verificationUrl: "https://auth.openai.com/codex/device", userCode: "ABCD-1234" } });
          break;
        case "thread/start":
          server.reply({ id, result: { thread: { id: "thread-1" } } });
          break;
        case "turn/start":
          server.reply({ id, result: { turn: { id: "turn-1", status: "inProgress", items: [] } } });
          break;
        case "turn/interrupt":
          server.reply({ id, result: {} });
          break;
      }
    });
    const client = clientFor(child);

    await expect(client.initialize()).resolves.toMatchObject({ userAgent: "codex" });
    await expect(client.accountRead()).resolves.toMatchObject({ account: { type: "chatgpt" } });
    await expect(client.accountLoginStart()).resolves.toMatchObject({ type: "chatgptDeviceCode", loginId: "login-1" });
    await expect(client.threadStart({ cwd: "/empty", approvalPolicy: "never", sandbox: "read-only", ephemeral: true })).resolves.toMatchObject({ thread: { id: "thread-1" } });
    await expect(client.turnStart({ threadId: "thread-1", input: [{ type: "text", text: "bounded" }], approvalPolicy: "never", sandboxPolicy: { type: "readOnly" }, outputSchema: { type: "object" } })).resolves.toMatchObject({ turn: { id: "turn-1" } });
    await expect(client.turnInterrupt({ threadId: "thread-1", turnId: "turn-1" })).resolves.toBeUndefined();

    expect(child.requests).toEqual([
      { id: 1, method: "initialize", params: { clientInfo: { name: "qali", title: "Qali", version: "0.1.0" }, capabilities: { experimentalApi: false } } },
      { method: "initialized", params: {} },
      { id: 2, method: "account/read", params: { refreshToken: false } },
      { id: 3, method: "account/login/start", params: { type: "chatgptDeviceCode" } },
      { id: 4, method: "thread/start", params: { cwd: "/empty", approvalPolicy: "never", sandbox: "read-only", ephemeral: true } },
      { id: 5, method: "turn/start", params: { threadId: "thread-1", input: [{ type: "text", text: "bounded" }], approvalPolicy: "never", sandboxPolicy: { type: "readOnly" }, outputSchema: { type: "object" } } },
      { id: 6, method: "turn/interrupt", params: { threadId: "thread-1", turnId: "turn-1" } },
    ]);
    await client.close();
  });

  test("rejects operations before initialization and repeated handshakes", async () => {
    const child = new ScriptedChild((request, server) => {
      if (request.id !== undefined) server.reply({ id: request.id, result: {} });
    });
    const client = clientFor(child);

    await expect(client.accountRead()).rejects.toMatchObject({ code: "CODEX_NOT_INITIALIZED" });
    await client.initialize();
    await expect(client.initialize()).rejects.toMatchObject({ code: "CODEX_ALREADY_INITIALIZED" });
    await client.close();
  });

  test("validates required native result identities instead of guessing", async () => {
    const child = new ScriptedChild((request, server) => {
      if (request.id !== undefined) server.reply({ id: request.id, result: {} });
    });
    const client = clientFor(child);
    await client.initialize();

    await expect(client.threadStart({ cwd: "/empty", approvalPolicy: "never", sandbox: "read-only", ephemeral: true })).rejects.toMatchObject({ code: "CODEX_PROTOCOL_INVALID_RESULT" });
    await client.close();
  });
});
