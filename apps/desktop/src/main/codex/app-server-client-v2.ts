import type {
  CodexAppServerTransportGeneration,
  Deadline,
  NativeMessage,
} from "./app-server-transport";

export type InitializeResult = Record<string, unknown> & {
  userAgent?: string;
  platformFamily?: string;
  platformOs?: string;
};
export type AccountReadResult = Record<string, unknown> & {
  account: (Record<string, unknown> & { type: string }) | null;
  requiresOpenaiAuth: boolean;
};
export type AccountLoginStartResult = Record<string, unknown> & {
  type: "chatgptDeviceCode";
  loginId: string;
  verificationUrl: string;
  userCode: string;
};
export type ThreadStartInput = Readonly<Record<string, unknown> & {
  cwd: string;
  approvalPolicy: "never";
  sandbox: "read-only";
  ephemeral: true;
}>;
export type ThreadStartResult = Record<string, unknown> & {
  thread: Record<string, unknown> & { id: string };
};
export type TurnStartInput = Readonly<Record<string, unknown> & {
  threadId: string;
  input: readonly unknown[];
  approvalPolicy: "never";
  sandboxPolicy: Readonly<{ type: "readOnly" }>;
  outputSchema: unknown;
}>;
export type TurnStartResult = Record<string, unknown> & {
  turn: Record<string, unknown> & { id: string };
};
export type TurnInterruptInput = Readonly<{
  threadId: string;
  turnId: string;
}>;

export type CodexAppServerClientDeadlines = Readonly<{
  initializeMs: number;
  accountReadMs: number;
  accountLoginStartMs: number;
  threadStartMs: number;
  turnStartMs: number;
  turnInterruptMs: number;
}>;

export interface CodexAppServerClientV2 {
  initialize(): Promise<InitializeResult>;
  accountRead(): Promise<AccountReadResult>;
  accountLoginStart(): Promise<AccountLoginStartResult>;
  threadStart(input: ThreadStartInput): Promise<ThreadStartResult>;
  turnStart(input: TurnStartInput): Promise<TurnStartResult>;
  turnInterrupt(input: TurnInterruptInput): Promise<void>;
  subscribe(listener: (message: NativeMessage) => void): () => void;
  subscribeTermination?(listener: () => void): () => void;
  close(): Promise<void>;
}

export type CodexAppServerClientOptions = Readonly<{
  clientInfo: Readonly<{ name: string; title: string; version: string }>;
  deadlines: CodexAppServerClientDeadlines;
}>;

class CodexAppServerClientError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CodexAppServerClientError";
    this.code = code;
  }
}

const DEFAULT_OPTIONS: CodexAppServerClientOptions = {
  clientInfo: { name: "qali", title: "Qali", version: "0.1.0" },
  deadlines: {
    initializeMs: 5_000,
    accountReadMs: 3_000,
    accountLoginStartMs: 5_000,
    threadStartMs: 5_000,
    turnStartMs: 5_000,
    turnInterruptMs: 3_000,
  },
};

function error(code: string, message: string): CodexAppServerClientError {
  return new CodexAppServerClientError(code, message);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deadline(operation: string, timeoutMs: number): Deadline {
  return { operation, timeoutMs };
}

export function createCodexAppServerClientV2(
  transport: CodexAppServerTransportGeneration,
  options: CodexAppServerClientOptions = DEFAULT_OPTIONS,
): CodexAppServerClientV2 {
  let state: "new" | "initializing" | "ready" | "failed" | "closed" = "new";

  const ready = () => {
    if (state !== "ready") {
      throw error(
        state === "closed" ? "CODEX_CLIENT_CLOSED" : "CODEX_NOT_INITIALIZED",
        "Codex app-server client is not initialized",
      );
    }
  };

  const client: CodexAppServerClientV2 = {
    async initialize() {
      if (state !== "new") {
        throw error(
          state === "ready" || state === "initializing"
            ? "CODEX_ALREADY_INITIALIZED"
            : "CODEX_CLIENT_CLOSED",
          "Codex app-server initialization is not available",
        );
      }
      state = "initializing";
      try {
        const result = await transport.request("initialize", {
          clientInfo: options.clientInfo,
          capabilities: { experimentalApi: false },
        }, deadline("initialize", options.deadlines.initializeMs));
        if (!record(result)) {
          throw error("CODEX_PROTOCOL_INVALID_RESULT", "Codex initialize result is invalid");
        }
        await transport.notify("initialized", {});
        state = "ready";
        return result as InitializeResult;
      } catch (failure) {
        state = "failed";
        throw failure;
      }
    },
    async accountRead() {
      ready();
      const result = await transport.request(
        "account/read",
        { refreshToken: false },
        deadline("account-read", options.deadlines.accountReadMs),
      );
      if (
        !record(result) ||
        typeof result.requiresOpenaiAuth !== "boolean" ||
        !(result.account === null || (record(result.account) && typeof result.account.type === "string"))
      ) {
        throw error("CODEX_PROTOCOL_INVALID_RESULT", "Codex account result is invalid");
      }
      return result as AccountReadResult;
    },
    async accountLoginStart() {
      ready();
      const result = await transport.request(
        "account/login/start",
        { type: "chatgptDeviceCode" },
        deadline("account-login-start", options.deadlines.accountLoginStartMs),
      );
      if (
        !record(result) ||
        result.type !== "chatgptDeviceCode" ||
        typeof result.loginId !== "string" ||
        typeof result.verificationUrl !== "string" ||
        typeof result.userCode !== "string"
      ) {
        throw error("CODEX_PROTOCOL_INVALID_RESULT", "Codex login result is invalid");
      }
      return result as AccountLoginStartResult;
    },
    async threadStart(input) {
      ready();
      const result = await transport.request(
        "thread/start",
        input,
        deadline("thread-start", options.deadlines.threadStartMs),
      );
      if (!record(result) || !record(result.thread) || typeof result.thread.id !== "string") {
        throw error("CODEX_PROTOCOL_INVALID_RESULT", "Codex thread result is invalid");
      }
      return result as ThreadStartResult;
    },
    async turnStart(input) {
      ready();
      const result = await transport.request(
        "turn/start",
        input,
        deadline("turn-start", options.deadlines.turnStartMs),
      );
      if (!record(result) || !record(result.turn) || typeof result.turn.id !== "string") {
        throw error("CODEX_PROTOCOL_INVALID_RESULT", "Codex turn result is invalid");
      }
      return result as TurnStartResult;
    },
    async turnInterrupt(input) {
      ready();
      const result = await transport.request(
        "turn/interrupt",
        input,
        deadline("turn-interrupt", options.deadlines.turnInterruptMs),
      );
      if (!record(result)) {
        throw error("CODEX_PROTOCOL_INVALID_RESULT", "Codex interrupt result is invalid");
      }
    },
    subscribe(listener) {
      return transport.subscribe(listener);
    },
    subscribeTermination(listener) {
      return transport.subscribeTermination(listener);
    },
    async close() {
      if (state === "closed") return;
      state = "closed";
      await transport.close();
    },
  };
  return client;
}
