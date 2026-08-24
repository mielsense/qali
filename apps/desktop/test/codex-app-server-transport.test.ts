import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { once } from "node:events";
import { PassThrough } from "node:stream";

import {
  createCodexAppServerTransportGeneration,
  type CodexAppServerTransportLimits,
} from "../src/main/codex/app-server-transport";
import type { CodexAppServerChild } from "../src/main/codex/app-server-driver";

class ControlledInput extends EventEmitter {
  readonly writes: string[] = [];
  blocked = false;
  ended = false;

  constructor(private readonly onEnd: () => void = () => {}) {
    super();
  }

  write(chunk: string | Buffer): boolean {
    this.writes.push(chunk.toString());
    return !this.blocked;
  }

  end(): void {
    this.ended = true;
    this.onEnd();
  }
}

class FakeChild extends EventEmitter implements CodexAppServerChild {
  pid = undefined;
  stdin: never;
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly signals: NodeJS.Signals[] = [];
  private closeQueued = false;

  constructor() {
    super();
    this.stdin = new ControlledInput(() => {
      this.exitCode = 0;
      this.queueClose();
    }) as never;
  }

  private queueClose(): void {
    if (this.closeQueued) return;
    this.closeQueued = true;
    queueMicrotask(() => this.emit("close"));
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    this.exitCode = null;
    this.signalCode = signal;
    this.queueClose();
    return true;
  }

  input(): ControlledInput {
    return this.stdin as unknown as ControlledInput;
  }
}

const limits: CodexAppServerTransportLimits = {
  maxFrameBytes: 256,
  maxReceiveBufferBytes: 512,
  maxPendingRequests: 2,
  maxQueuedWriteBytes: 512,
  maxStderrBytes: 32,
};

function responseId(child: FakeChild, index = 0): number {
  return JSON.parse(child.input().writes[index]!)?.id as number;
}

describe("Codex app-server JSONL transport generation", () => {
  test("normal close awaits observed exit of a real owned process group", async () => {
    const child = spawn(
      process.execPath,
      [
        "-e",
        "process.on('SIGTERM', () => {}); process.stdin.resume(); setInterval(() => {}, 1000)",
      ],
      { detached: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    await once(child, "spawn");
    const pid = child.pid!;
    const transport = createCodexAppServerTransportGeneration(child, limits);
    let observed = 0;
    transport.subscribeTermination(() => {
      observed += 1;
    });

    try {
      await transport.close();
      expect(observed).toBe(1);
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      expect(() => process.kill(-pid, 0)).toThrow();
    } finally {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // The successful path has already drained the captured process group.
      }
    }
  });

  test("reports owned termination only after the child close event", async () => {
    const child = new FakeChild();
    const transport = createCodexAppServerTransportGeneration(child, limits);
    let observed = 0;
    transport.subscribeTermination(() => {
      observed += 1;
    });

    const terminating = transport.terminateOwned("test termination");
    expect(observed).toBe(0);
    child.emit("close");
    await terminating;
    expect(observed).toBe(1);
  });

  test("decodes fragmented and combined UTF-8 frames without losing receive order", async () => {
    const child = new FakeChild();
    const transport = createCodexAppServerTransportGeneration(child, limits);
    const events: unknown[] = [];
    transport.subscribe((message) => events.push(message));

    const pending = transport.request("initialize", { clientInfo: { name: "qali" } }, {
      operation: "initialize",
      timeoutMs: 1_000,
    });
    const id = responseId(child);
    const encoded = Buffer.from(
      `${JSON.stringify({ id, result: {} })}\n${JSON.stringify({ method: "turn/started", params: { label: "café 🗓️" } })}\n`,
    );
    const split = encoded.indexOf(Buffer.from("🗓️")) + 2;
    child.stdout.emit("data", encoded.subarray(0, split));
    child.stdout.emit("data", encoded.subarray(split));

    await expect(pending).resolves.toEqual({});
    expect(events).toEqual([
      { method: "turn/started", params: { label: "café 🗓️" } },
    ]);
    await transport.close();
  });

  for (const fixture of [
    { name: "banner output", bytes: Buffer.from("Codex ready\n"), code: "CODEX_PROTOCOL_INVALID" },
    { name: "invalid UTF-8", bytes: Buffer.from([0xc3, 0x28, 0x0a]), code: "CODEX_PROTOCOL_INVALID_UTF8" },
    { name: "oversized frame", bytes: Buffer.from(`${"x".repeat(257)}\n`), code: "CODEX_FRAME_TOO_LARGE" },
  ]) {
    test(`terminates the owned generation on ${fixture.name}`, async () => {
      const child = new FakeChild();
      const transport = createCodexAppServerTransportGeneration(child, limits);
      const pending = transport.request("initialize", {}, { operation: "initialize", timeoutMs: 1_000 });

      child.stdout.emit("data", fixture.bytes);

      await expect(pending).rejects.toMatchObject({ code: fixture.code });
      expect(child.signals).toEqual(["SIGTERM"]);
      await transport.close();
    });
  }

  test("caps diagnostic stderr independently from protocol stdout", async () => {
    const child = new FakeChild();
    const transport = createCodexAppServerTransportGeneration(child, limits);
    const pending = transport.request("initialize", {}, { operation: "initialize", timeoutMs: 1_000 });

    child.stderr.emit("data", Buffer.alloc(33, 0x78));

    await expect(pending).rejects.toMatchObject({ code: "CODEX_STDERR_TOO_LARGE" });
    expect(child.signals).toEqual(["SIGTERM"]);
    await transport.close();
  });

  test("serializes writes, waits for drain, and rejects work beyond the pending bound", async () => {
    const child = new FakeChild();
    child.input().blocked = true;
    const transport = createCodexAppServerTransportGeneration(child, limits);

    const first = transport.request("first", {}, { operation: "first", timeoutMs: 1_000 });
    const second = transport.request("second", {}, { operation: "second", timeoutMs: 1_000 });
    await expect(
      transport.request("third", {}, { operation: "third", timeoutMs: 1_000 }),
    ).rejects.toMatchObject({ code: "CODEX_PENDING_LIMIT" });
    expect(child.input().writes).toHaveLength(1);

    child.input().blocked = false;
    child.input().emit("drain");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(child.input().writes).toHaveLength(2);
    const [firstId, secondId] = [responseId(child, 0), responseId(child, 1)];
    child.stdout.emit("data", Buffer.from(`${JSON.stringify({ id: firstId, result: 1 })}\n${JSON.stringify({ id: secondId, result: 2 })}\n`));
    await expect(first).resolves.toBe(1);
    await expect(second).resolves.toBe(2);
    await transport.close();
  });

  test("rejects zero-budget operations before writing", async () => {
    const child = new FakeChild();
    const transport = createCodexAppServerTransportGeneration(child, limits);

    await expect(
      transport.request("account/read", {}, { operation: "account-read", timeoutMs: 0 }),
    ).rejects.toMatchObject({ code: "CODEX_DEADLINE_EXCEEDED" });
    expect(child.input().writes).toEqual([]);
    await transport.close();
  });

  test("does not cross-settle unknown or duplicate response ids", async () => {
    const child = new FakeChild();
    const transport = createCodexAppServerTransportGeneration(child, limits);
    const pending = transport.request("initialize", {}, { operation: "initialize", timeoutMs: 1_000 });
    const id = responseId(child);

    child.stdout.emit("data", Buffer.from(`${JSON.stringify({ id: id + 100, result: {} })}\n`));

    await expect(pending).rejects.toMatchObject({ code: "CODEX_UNKNOWN_RESPONSE" });
    expect(child.signals).toEqual(["SIGTERM"]);
    await transport.close();

    const duplicateChild = new FakeChild();
    const duplicateTransport = createCodexAppServerTransportGeneration(duplicateChild, limits);
    const settled = duplicateTransport.request("initialize", {}, { operation: "initialize", timeoutMs: 1_000 });
    const settledId = responseId(duplicateChild);
    duplicateChild.stdout.emit("data", Buffer.from(`${JSON.stringify({ id: settledId, result: {} })}\n`));
    await settled;
    duplicateChild.stdout.emit("data", Buffer.from(`${JSON.stringify({ id: settledId, result: {} })}\n`));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(duplicateChild.signals).toEqual(["SIGTERM"]);
    await duplicateTransport.close();
  });

  test("sends an unsupported-request denial before typed termination", async () => {
    const child = new FakeChild();
    const transport = createCodexAppServerTransportGeneration(child, limits);
    const pending = transport.request("turn/start", {}, { operation: "turn-start", timeoutMs: 1_000 });

    child.stdout.emit("data", Buffer.from(`${JSON.stringify({ id: "server-1", method: "item/commandExecution/requestApproval", params: {} })}\n`));
    await expect(pending).rejects.toMatchObject({ code: "CODEX_SERVER_REQUEST_UNSUPPORTED" });

    expect(child.input().writes.map((frame) => JSON.parse(frame))).toContainEqual({
      id: "server-1",
      error: { code: -32601, message: "Qali does not support native server requests" },
    });
    expect(child.signals).toEqual(["SIGTERM"]);
    await transport.close();
  });

  test("reserves bounded control capacity for denial while ordinary writes are backpressured", async () => {
    const child = new FakeChild();
    child.input().blocked = true;
    const transport = createCodexAppServerTransportGeneration(child, {
      ...limits,
      maxQueuedWriteBytes: 96,
    });
    const pending = transport.request("turn/start", {}, { operation: "turn-start", timeoutMs: 100 });
    child.stdout.emit("data", Buffer.from(`${JSON.stringify({ id: "server-2", method: "item/tool/request", params: {} })}\n`));

    child.input().blocked = false;
    child.input().emit("drain");

    await expect(pending).rejects.toMatchObject({ code: "CODEX_SERVER_REQUEST_UNSUPPORTED" });
    expect(child.input().writes.map((frame) => JSON.parse(frame))).toContainEqual({
      id: "server-2",
      error: { code: -32601, message: "Qali does not support native server requests" },
    });
    await transport.close();
  });

  test("close is idempotent and settles every pending waiter once", async () => {
    const child = new FakeChild();
    const transport = createCodexAppServerTransportGeneration(child, limits);
    let settlements = 0;
    const first = transport.request("first", {}, { operation: "first", timeoutMs: 1_000 }).catch((error) => {
      settlements++;
      throw error;
    });
    const second = transport.request("second", {}, { operation: "second", timeoutMs: 1_000 }).catch((error) => {
      settlements++;
      throw error;
    });

    const firstSettlement = first.then(
      () => null,
      (error) => error as { code?: string },
    );
    const secondSettlement = second.then(
      () => null,
      (error) => error as { code?: string },
    );
    await Promise.all([transport.close(), transport.close()]);
    expect(await firstSettlement).toMatchObject({ code: "CODEX_TRANSPORT_CLOSED" });
    expect(await secondSettlement).toMatchObject({ code: "CODEX_TRANSPORT_CLOSED" });
    expect(settlements).toBe(2);
    expect(child.input().ended).toBe(true);
    expect(child.signals).toEqual([]);
  });
});
