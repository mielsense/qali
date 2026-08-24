import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  cancelCodexAppServerAttempt,
  runCodexAppServerPhase,
  type CodexAppServerChild,
  type CodexAppServerSpawn,
} from "../src/main/codex/app-server-driver";
import {
  CODEX_APP_SERVER_ARGS,
  createCodexAppServerContainment,
  createCodexAppServerTestHarness,
} from "../src/main/codex/app-server-containment";
import {
  createCodexAppServerContainmentAuthority,
  createCodexRuntimeAuthority,
} from "../src/main/codex/boundary";
import { createCodexLoginEventChannel, subscribeCodexLoginEvents } from "../src/main/codex/events";
import { startEgressProxy } from "../src/main/codex/egress-proxy";
import { loadCodexManifest } from "../src/main/codex/manifest";
import { resolveInstalledCodexAppServer } from "../src/main/codex/app-server-provider";
import { parseFinalizerJson, parsePlannerJson } from "../src/main/codex/schemas";

class FakeChild extends EventEmitter implements CodexAppServerChild {
  pid = 8123;
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

const executable = "/opt/homebrew/Caskroom/codex/0.149.1/bin/codex";
const attemptId = `assistant_${"a".repeat(32)}_planner`;
const resources = resolve(import.meta.dir, "../resources");

function scriptedSpawn(
  child: FakeChild,
  onRequest: (
    request: Record<string, unknown>,
    write: (value: unknown) => void,
  ) => void,
): CodexAppServerSpawn {
  return ((command, args, options) => {
    expect(command).toBe("/usr/bin/sandbox-exec");
    expect(args.slice(-CODEX_APP_SERVER_ARGS.length)).toEqual(
      CODEX_APP_SERVER_ARGS,
    );
    expect(args).toContain(executable);
    expect(options).toMatchObject({
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    expect(options.env.HOME).not.toBe("/Users/tester");
    expect(options.env.OPENAI_API_KEY).toBeUndefined();
    expect(options.env.CODEX_API_KEY).toBeUndefined();

    let buffered = "";
    child.stdin.on("data", (chunk) => {
      buffered += chunk.toString("utf8");
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (line) {
          const request = JSON.parse(line) as Record<string, unknown>;
          onRequest(request, (value) => {
            const encoded = `${JSON.stringify(value)}\n`;
            const midpoint = Math.floor(encoded.length / 2);
            child.stdout.write(encoded.slice(0, midpoint));
            child.stdout.write(encoded.slice(midpoint));
          });
        }
        newline = buffered.indexOf("\n");
      }
    });
    queueMicrotask(() => child.emit("spawn"));
    return child;
  }) as CodexAppServerSpawn;
}

async function requestFor(child: FakeChild, spawnProcess: CodexAppServerSpawn) {
  const manifest = await loadCodexManifest(join(resources, "codex-provider-manifest.json"));
  const root = await mkdtemp(join(tmpdir(), "qali-app-server-driver-"));
  const home = join(root, "home");
  const cwd = join(root, "cwd");
  await Promise.all([mkdir(home, { mode: 0o700 }), mkdir(cwd, { mode: 0o700 })]);
  const proxy = await startEgressProxy({
    allowedHosts: manifest.proxy.allowedHosts,
    allowedPorts: manifest.proxy.allowedPorts,
    expectedPolicySha256: manifest.proxy.policySha256,
  }, {
    listen: async () => 43_125,
    closeServer: async () => {},
  });
  const events = createCodexLoginEventChannel();
  const unsubscribe = subscribeCodexLoginEvents(events, () => {});
  try {
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
    try {
      return await runCodexAppServerPhase({
        attemptId,
        executable: "/caller/ignored",
        home: "/Users/tester",
        cwd: "/private/tmp/qali-empty-workspace",
        prompt: "Summarize my bounded calendar context",
        outputSchema: { type: "object", additionalProperties: false },
        timeoutMs: 1_000,
      }, { containment });
    } finally {
      await containment.close();
    }
  } finally {
    unsubscribe();
    await proxy.close();
    await rm(root, { force: true, recursive: true });
  }
}

describe("Codex app-server driver", () => {
  test("uses the signed-in ChatGPT account and returns the completed agent message", async () => {
    const child = new FakeChild();
    let threadId = "";
    const spawnProcess = scriptedSpawn(child, (request, write) => {
      const id = request.id as number | undefined;
      switch (request.method) {
        case "initialize":
          write({
            id,
            result: {
              userAgent: "codex",
              platformFamily: "unix",
              platformOs: "macos",
            },
          });
          break;
        case "account/read":
          write({
            id,
            result: {
              account: {
                type: "chatgpt",
                email: "private@example.com",
                planType: "plus",
              },
              requiresOpenaiAuth: true,
            },
          });
          break;
        case "thread/start":
          threadId = "thread-1";
          write({ id, result: { thread: { id: threadId } } });
          break;
        case "turn/start":
          expect(request.params).toMatchObject({
            threadId,
            approvalPolicy: "never",
            sandboxPolicy: { type: "readOnly" },
          });
          write({ id, result: { turn: { id: "turn-1" } } });
          write({
            method: "item/started",
            params: {
              threadId,
              turnId: "turn-1",
              item: {
                type: "userMessage",
                id: "user-1",
                content: [{ type: "text", text: "private" }],
              },
            },
          });
          write({
            method: "item/completed",
            params: {
              threadId,
              turnId: "turn-1",
              item: {
                type: "agentMessage",
                id: "msg-1",
                text: '{"ok":true}',
                phase: "final_answer",
              },
            },
          });
          write({
            method: "turn/completed",
            params: { threadId, turn: { id: "turn-1", status: "completed" } },
          });
          queueMicrotask(() => {
            child.exitCode = 0;
            child.emit("exit", 0, null);
            child.emit("close", 0, null);
          });
          break;
      }
    });

    await expect(requestFor(child, spawnProcess)).resolves.toEqual({
      finalText: '{"ok":true}',
    });
  });

  test("fails closed when Codex requests an effect-bearing action", async () => {
    const child = new FakeChild();
    const spawnProcess = scriptedSpawn(child, (request, write) => {
      const id = request.id as number | undefined;
      if (request.method === "initialize") write({ id, result: {} });
      if (request.method === "account/read") {
        write({
          id,
          result: {
            account: { type: "chatgpt", planType: "plus" },
            requiresOpenaiAuth: true,
          },
        });
      }
      if (request.method === "thread/start")
        write({ id, result: { thread: { id: "thread-2" } } });
      if (request.method === "turn/start") {
        write({ id, result: { turn: { id: "turn-2" } } });
        write({
          method: "item/started",
          params: {
            threadId: "thread-2",
            turnId: "turn-2",
            item: { type: "commandExecution", id: "cmd", command: "whoami" },
          },
        });
      }
    });

    await expect(requestFor(child, spawnProcess)).rejects.toMatchObject({
      code: "CODEX_EFFECT_BLOCKED",
    });
  });

  test("interrupts the exact active thread and turn before terminating", async () => {
    const child = new FakeChild();
    const requests: Record<string, unknown>[] = [];
    const spawnProcess = scriptedSpawn(child, (request, write) => {
      requests.push(request);
      const id = request.id as number | undefined;
      if (request.method === "initialize") write({ id, result: {} });
      if (request.method === "account/read") {
        write({
          id,
          result: {
            account: { type: "chatgpt", planType: "plus" },
            requiresOpenaiAuth: true,
          },
        });
      }
      if (request.method === "thread/start")
        write({ id, result: { thread: { id: "thread-3" } } });
      if (request.method === "turn/start")
        write({ id, result: { turn: { id: "turn-3" } } });
      if (request.method === "turn/interrupt") {
        write({ id, result: {} });
        queueMicrotask(() => {
          child.exitCode = 0;
          child.emit("exit", 0, null);
          child.emit("close", 0, null);
        });
      }
    });

    const pending = requestFor(child, spawnProcess);
    for (let index = 0; index < 100 && !requests.some((request) => request.method === "turn/start"); index++) {
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 1));
    }
    expect(requests.some((request) => request.method === "turn/start")).toBe(true);
    expect(cancelCodexAppServerAttempt(attemptId)).toBe(true);
    await expect(pending).rejects.toMatchObject({ code: "CODEX_CANCELLED" });
    expect(requests).toContainEqual({
      id: expect.any(Number),
      method: "turn/interrupt",
      params: { threadId: "thread-3", turnId: "turn-3" },
    });
  });
});

test("opt-in: installed Codex app-server uses the existing ChatGPT subscription", async () => {
  if (process.env.QALI_LIVE_CODEX_SMOKE !== "1") return;
  const root = await mkdtemp(join(tmpdir(), "qali-codex-app-server-"));
  try {
    const runtimeRoot = join(root, "runtime");
    await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
    const provider = await resolveInstalledCodexAppServer({
      resourceRoot: resolve(import.meta.dir, "../resources"),
      home: process.env.HOME ?? "",
      runtimeRoot,
    });
    expect(provider).not.toBeNull();
    const result = await runCodexAppServerPhase({
      attemptId: `assistant_${"f".repeat(32)}_planner`,
      executable: provider!.executable,
      home: provider!.home,
      cwd: provider!.cwd,
      tmpdir: provider!.tmpdir,
      prompt:
        "Return exactly one JSON object with status set to ok. Do not use tools.",
      outputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { status: { const: "ok", type: "string" } },
        required: ["status"],
      },
      timeoutMs: 60_000,
    });
    expect(JSON.parse(result.finalText)).toEqual({ status: "ok" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 70_000);

test("opt-in: production finalizer schema is accepted by the installed Codex", async () => {
  if (process.env.QALI_LIVE_CODEX_SMOKE !== "1") return;
  const root = await mkdtemp(join(tmpdir(), "qali-codex-finalizer-schema-"));
  try {
    const runtimeRoot = join(root, "runtime");
    await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
    const provider = await resolveInstalledCodexAppServer({
      resourceRoot: resolve(import.meta.dir, "../resources"),
      home: process.env.HOME ?? "",
      runtimeRoot,
    });
    expect(provider).not.toBeNull();
    const result = await runCodexAppServerPhase({
      attemptId: `assistant_${"d".repeat(32)}_finalizer`,
      executable: provider!.executable,
      home: provider!.home,
      cwd: provider!.cwd,
      tmpdir: provider!.tmpdir,
      prompt:
        'Return markdown "Ready." and an empty proposals array. Do not use tools.',
      outputSchema: provider!.finalizerSchema,
      timeoutMs: 60_000,
    });
    expect(parseFinalizerJson(result.finalText)).toEqual({
      markdown: "Ready.",
      proposals: [],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 70_000);

test("opt-in: production planner schema is accepted by the installed Codex", async () => {
  if (process.env.QALI_LIVE_CODEX_SMOKE !== "1") return;
  const root = await mkdtemp(join(tmpdir(), "qali-codex-planner-schema-"));
  try {
    const runtimeRoot = join(root, "runtime");
    await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
    const provider = await resolveInstalledCodexAppServer({
      resourceRoot: resolve(import.meta.dir, "../resources"),
      home: process.env.HOME ?? "",
      runtimeRoot,
    });
    expect(provider).not.toBeNull();
    const result = await runCodexAppServerPhase({
      attemptId: `assistant_${"e".repeat(32)}_planner`,
      executable: provider!.executable,
      home: provider!.home,
      cwd: provider!.cwd,
      tmpdir: provider!.tmpdir,
      prompt:
        'Return a clarification object asking "Which calendar?". Set unused nullable fields to null. Do not use tools.',
      outputSchema: provider!.plannerSchema,
      timeoutMs: 60_000,
    });
    expect(parsePlannerJson(result.finalText)).toEqual({
      kind: "clarification",
      question: "Which calendar?",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 70_000);
