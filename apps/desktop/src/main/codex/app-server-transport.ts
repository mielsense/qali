import { Buffer } from "node:buffer";

import {
  CodexAppServerFramingError,
  CodexAppServerJsonlFramer,
  type NativeMessage,
} from "./app-server-framing";
import type { CodexAppServerChild } from "./app-server-driver";

export type { NativeMessage } from "./app-server-framing";

export type Deadline = Readonly<{
  operation: string;
  timeoutMs: number;
}>;

export type CodexAppServerTransportLimits = Readonly<{
  maxFrameBytes: number;
  maxReceiveBufferBytes: number;
  maxPendingRequests: number;
  maxQueuedWriteBytes: number;
  maxStderrBytes: number;
}>;

export interface CodexAppServerTransportGeneration {
  request(method: string, params: unknown, deadline: Deadline): Promise<unknown>;
  notify(method: string, params: unknown): Promise<void>;
  subscribe(listener: (message: NativeMessage) => void): () => void;
  subscribeTermination(listener: () => void): () => void;
  terminateOwned(reason: string): Promise<void>;
  close(): Promise<void>;
}

export type CodexAppServerTransportLifecycleDependencies = Readonly<{
  processGroupAlive?(pid: number): boolean;
  signalOwnedGroup?(child: CodexAppServerChild, signal: NodeJS.Signals): void;
  wait?(milliseconds: number): Promise<void>;
  gracefulMs?: number;
  terminateMs?: number;
  killMs?: number;
}>;

type Pending = {
  method: string;
  timer: ReturnType<typeof setTimeout>;
  resolve(value: unknown): void;
  reject(error: unknown): void;
};

type QueuedWrite = {
  bytes: number;
  frame: string;
  resolve(): void;
  reject(error: unknown): void;
};

export class CodexAppServerTransportError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CodexAppServerTransportError";
    this.code = code;
  }
}

function codedError(code: string, message: string): CodexAppServerTransportError {
  return new CodexAppServerTransportError(code, message);
}

function requestId(value: unknown): value is string | number {
  return typeof value === "string" ||
    (typeof value === "number" && Number.isSafeInteger(value));
}

function validateLimits(limits: CodexAppServerTransportLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError(`${name} must be a positive safe integer`);
    }
  }
  if (limits.maxReceiveBufferBytes < limits.maxFrameBytes) {
    throw new TypeError("maxReceiveBufferBytes must cover maxFrameBytes");
  }
}

export function createCodexAppServerTransportGeneration(
  child: CodexAppServerChild,
  limits: CodexAppServerTransportLimits,
  lifecycle: CodexAppServerTransportLifecycleDependencies = {},
): CodexAppServerTransportGeneration {
  validateLimits(limits);
  const framer = new CodexAppServerJsonlFramer(limits);
  const listeners = new Set<(message: NativeMessage) => void>();
  const terminationListeners = new Set<() => void>();
  const pending = new Map<number, Pending>();
  const writeQueue: QueuedWrite[] = [];
  const drainRejectors = new Set<(error: unknown) => void>();
  let nextId = 1;
  let stderrBytes = 0;
  let queuedWriteBytes = 0;
  let writing = false;
  let closed = false;
  let closePromise: Promise<void> | undefined;
  let receiveChain = Promise.resolve();
  let childCloseObserved = false;
  let terminationPublished = false;

  const wait = lifecycle.wait ?? ((milliseconds: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const processGroupAlive = lifecycle.processGroupAlive ?? ((pid: number) => {
    try {
      process.kill(-pid, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      throw error;
    }
  });
  const signalOwnedGroup = lifecycle.signalOwnedGroup ??
    ((ownedChild: CodexAppServerChild, signal: NodeJS.Signals) => {
      if (ownedChild.killOwnedGroup) {
        ownedChild.killOwnedGroup(signal);
        return;
      }
      const pid = ownedChild.pid;
      if (pid && pid > 1) {
        try {
          process.kill(-pid, signal);
          return;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
      ownedChild.kill(signal);
    });
  const gracefulMs = lifecycle.gracefulMs ?? 100;
  const terminateMs = lifecycle.terminateMs ?? 500;
  const killMs = lifecycle.killMs ?? 500;

  for (const [name, value] of Object.entries({ gracefulMs, terminateMs, killMs })) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError(`${name} must be a positive safe integer`);
    }
  }

  const ownedGroupAlive = () => {
    const pid = child.pid;
    return Boolean(pid && pid > 1 && processGroupAlive(pid));
  };

  const stopped = () => childCloseObserved && !ownedGroupAlive();

  const waitUntilStopped = async (timeoutMs: number): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    do {
      if (stopped()) return true;
      await wait(Math.min(20, Math.max(1, deadline - Date.now())));
    } while (Date.now() < deadline);
    return stopped();
  };

  const publishTermination = () => {
    if (terminationPublished) return;
    terminationPublished = true;
    for (const listener of terminationListeners) listener();
    terminationListeners.clear();
  };

  const removeListeners = (awaitObservedClose = false) => {
    child.stdout.off("data", onStdout);
    child.stdout.off("end", onStdoutEnd);
    child.stderr.off("data", onStderr);
    child.off("error", onChildError);
    if (!awaitObservedClose) child.off("close", onChildClose);
  };

  const settleAll = (error: unknown) => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    pending.clear();
    for (const queued of writeQueue.splice(0)) queued.reject(error);
    queuedWriteBytes = 0;
    for (const reject of drainRejectors) reject(error);
    drainRejectors.clear();
  };

  const finish = (error: unknown, terminate: boolean): Promise<void> => {
    if (closePromise) return closePromise;
    closed = true;
    // The close observer stays installed until both the leader exit and the
    // captured process-group drain have been proven.
    removeListeners(true);
    settleAll(error);
    closePromise = (async () => {
      child.stdin.end();
      if (!terminate && await waitUntilStopped(gracefulMs)) {
        child.off("close", onChildClose);
        publishTermination();
        return;
      }
      if (ownedGroupAlive() || !childCloseObserved) {
        signalOwnedGroup(child, "SIGTERM");
      }
      if (await waitUntilStopped(terminateMs)) {
        child.off("close", onChildClose);
        publishTermination();
        return;
      }
      signalOwnedGroup(child, "SIGKILL");
      if (!(await waitUntilStopped(killMs))) {
        throw codedError(
          "CODEX_TERMINATION_TIMEOUT",
          "Codex owned process group did not terminate",
        );
      }
      child.off("close", onChildClose);
      publishTermination();
    })();
    return closePromise;
  };

  const fail = (error: unknown): Promise<void> => finish(error, true);

  const waitForDrain = (): Promise<void> => new Promise((resolve, reject) => {
    const rejectOnce = (error: unknown) => {
      cleanup();
      reject(error);
    };
    const resolveOnce = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      child.stdin.off("drain", resolveOnce);
      child.stdin.off("error", rejectOnce);
      drainRejectors.delete(rejectOnce);
    };
    drainRejectors.add(rejectOnce);
    child.stdin.once("drain", resolveOnce);
    child.stdin.once("error", rejectOnce);
  });

  const pumpWrites = async (): Promise<void> => {
    if (writing || closed) return;
    writing = true;
    try {
      while (!closed && writeQueue.length > 0) {
        const next = writeQueue.shift()!;
        try {
          const writable = child.stdin.write(next.frame);
          if (!writable) await waitForDrain();
          queuedWriteBytes -= next.bytes;
          next.resolve();
        } catch (error) {
          queuedWriteBytes -= next.bytes;
          next.reject(error);
          await fail(codedError("CODEX_STDIN_FAILED", "Codex protocol input failed"));
        }
      }
    } finally {
      writing = false;
    }
  };

  const enqueue = (value: unknown, control = false): Promise<void> => {
    if (closed) {
      return Promise.reject(codedError("CODEX_TRANSPORT_CLOSED", "Codex app-server transport is closed"));
    }
    let frame: string;
    try {
      frame = `${JSON.stringify(value)}\n`;
    } catch {
      return Promise.reject(codedError("CODEX_PROTOCOL_INVALID_OUTBOUND", "Codex request is not JSON serializable"));
    }
    const bytes = Buffer.byteLength(frame);
    if (bytes > limits.maxFrameBytes) {
      return Promise.reject(codedError("CODEX_FRAME_TOO_LARGE", "Codex outbound frame exceeded its byte limit"));
    }
    const writeBudget = limits.maxQueuedWriteBytes +
      (control ? limits.maxFrameBytes : 0);
    if (queuedWriteBytes + bytes > writeBudget) {
      return Promise.reject(codedError("CODEX_WRITE_QUEUE_LIMIT", "Codex write queue is full"));
    }
    queuedWriteBytes += bytes;
    const queued = new Promise<void>((resolve, reject) => {
      writeQueue.push({ bytes, frame, resolve, reject });
    });
    void pumpWrites();
    return queued;
  };

  const dispatch = async (message: NativeMessage): Promise<void> => {
    if (closed) return;
    const hasMethod = typeof message.method === "string";
    const hasId = Object.prototype.hasOwnProperty.call(message, "id");
    const hasResult = Object.prototype.hasOwnProperty.call(message, "result");
    const hasError = Object.prototype.hasOwnProperty.call(message, "error");

    if (hasMethod && hasId) {
      if (!requestId(message.id)) {
        await fail(codedError("CODEX_PROTOCOL_INVALID", "Codex server request has an invalid id"));
        return;
      }
      await enqueue({
        id: message.id,
        error: {
          code: -32601,
          message: "Qali does not support native server requests",
        },
      }, true);
      await fail(codedError(
        "CODEX_SERVER_REQUEST_UNSUPPORTED",
        "Codex requested an unsupported native operation",
      ));
      return;
    }

    if (!hasMethod && hasId && (hasResult || hasError)) {
      if (!requestId(message.id) || typeof message.id !== "number" || hasResult === hasError) {
        await fail(codedError("CODEX_PROTOCOL_INVALID", "Codex response envelope is invalid"));
        return;
      }
      const waiter = pending.get(message.id);
      if (!waiter) {
        await fail(codedError("CODEX_UNKNOWN_RESPONSE", "Codex returned an unknown or duplicate response id"));
        return;
      }
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (hasError && message.error !== null) {
        waiter.reject(codedError("CODEX_NATIVE_ERROR", `Codex rejected ${waiter.method}`));
      } else {
        waiter.resolve(message.result);
      }
      return;
    }

    if (hasMethod && !hasId && !hasResult && !hasError) {
      for (const listener of listeners) listener(message);
      return;
    }

    await fail(codedError("CODEX_PROTOCOL_INVALID", "Codex protocol envelope is invalid"));
  };

  function onStdout(chunk: Buffer | string): void {
    if (closed) return;
    let messages: NativeMessage[];
    try {
      messages = framer.push(
        typeof chunk === "string" ? Buffer.from(chunk) : chunk,
      );
    } catch (error) {
      const failure = error instanceof CodexAppServerFramingError
        ? codedError(error.code, error.message)
        : codedError("CODEX_PROTOCOL_INVALID", "Codex framing failed");
      void fail(failure).catch(() => {});
      return;
    }
    for (const message of messages) {
      receiveChain = receiveChain
        .then(() => dispatch(message))
        .catch(async (failure) => {
          await fail(
            failure instanceof Error
              ? failure
              : codedError("CODEX_PROTOCOL_INVALID", "Codex receive dispatch failed"),
          );
        });
    }
  }

  function onStdoutEnd(): void {
    if (closed) return;
    try {
      framer.end();
    } catch (error) {
      const failure = error instanceof CodexAppServerFramingError
        ? codedError(error.code, error.message)
        : codedError("CODEX_PROTOCOL_TRUNCATED", "Codex protocol ended unexpectedly");
      void fail(failure).catch(() => {});
    }
  }

  function onStderr(chunk: Buffer | string): void {
    if (closed) return;
    stderrBytes += Buffer.byteLength(chunk);
    if (stderrBytes > limits.maxStderrBytes) {
      void fail(
        codedError("CODEX_STDERR_TOO_LARGE", "Codex diagnostics exceeded their byte limit"),
      ).catch(() => {});
    }
  }

  function onChildError(): void {
    void fail(codedError("CODEX_PROCESS_FAILED", "Codex app-server process failed")).catch(() => {});
  }

  function onChildClose(): void {
    childCloseObserved = true;
    receiveChain = receiveChain.then(async () => {
      if (!closed) {
        await finish(
          codedError("CODEX_PROCESS_CLOSED", "Codex app-server process closed"),
          false,
        );
      }
    });
  }

  child.stdout.on("data", onStdout);
  child.stdout.once("end", onStdoutEnd);
  child.stderr.on("data", onStderr);
  child.once("error", onChildError);
  child.once("close", onChildClose);

  const transport: CodexAppServerTransportGeneration = {
    request(method, params, deadline) {
      if (closed) {
        return Promise.reject(codedError("CODEX_TRANSPORT_CLOSED", "Codex app-server transport is closed"));
      }
      if (typeof method !== "string" || method.length === 0 || Buffer.byteLength(method) > 128) {
        return Promise.reject(codedError("CODEX_PROTOCOL_INVALID_OUTBOUND", "Codex request method is invalid"));
      }
      if (!Number.isSafeInteger(deadline.timeoutMs) || deadline.timeoutMs <= 0) {
        return Promise.reject(codedError("CODEX_DEADLINE_EXCEEDED", `${deadline.operation} deadline expired`));
      }
      if (pending.size >= limits.maxPendingRequests) {
        return Promise.reject(codedError("CODEX_PENDING_LIMIT", "Codex pending request limit reached"));
      }
      const id = nextId++;
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (!pending.has(id)) return;
          void fail(
            codedError("CODEX_DEADLINE_EXCEEDED", `${deadline.operation} deadline expired`),
          ).catch(() => {});
        }, deadline.timeoutMs);
        pending.set(id, { method, timer, resolve, reject });
        void enqueue({ id, method, params }).catch((error) => {
          const waiter = pending.get(id);
          if (!waiter) return;
          pending.delete(id);
          clearTimeout(waiter.timer);
          waiter.reject(error);
        });
      });
    },
    notify(method, params) {
      if (typeof method !== "string" || method.length === 0 || Buffer.byteLength(method) > 128) {
        return Promise.reject(codedError("CODEX_PROTOCOL_INVALID_OUTBOUND", "Codex notification method is invalid"));
      }
      return enqueue({ method, params });
    },
    subscribe(listener) {
      if (closed) return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeTermination(listener) {
      if (closed) return () => {};
      terminationListeners.add(listener);
      return () => terminationListeners.delete(listener);
    },
    terminateOwned(reason) {
      return fail(codedError("CODEX_TRANSPORT_TERMINATED", reason));
    },
    close() {
      return finish(codedError("CODEX_TRANSPORT_CLOSED", "Codex app-server transport closed"), false);
    },
  };
  return transport;
}
