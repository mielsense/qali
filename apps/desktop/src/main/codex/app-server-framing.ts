export type NativeMessage = Record<string, unknown>;

export type CodexAppServerFramingLimits = Readonly<{
  maxFrameBytes: number;
  maxReceiveBufferBytes: number;
}>;

export class CodexAppServerFramingError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CodexAppServerFramingError";
    this.code = code;
  }
}

function record(value: unknown): value is NativeMessage {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertPositiveLimit(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
}

/** Strict, incremental UTF-8 JSONL decoding for one app-server generation. */
export class CodexAppServerJsonlFramer {
  readonly #limits: CodexAppServerFramingLimits;
  #decoder = new TextDecoder("utf-8", { fatal: true });
  #frameBytes = 0;
  #frameText = "";
  #failed = false;

  constructor(limits: CodexAppServerFramingLimits) {
    assertPositiveLimit(limits.maxFrameBytes, "maxFrameBytes");
    assertPositiveLimit(limits.maxReceiveBufferBytes, "maxReceiveBufferBytes");
    if (limits.maxReceiveBufferBytes < limits.maxFrameBytes) {
      throw new TypeError("maxReceiveBufferBytes must cover maxFrameBytes");
    }
    this.#limits = limits;
  }

  push(chunk: Uint8Array): NativeMessage[] {
    if (this.#failed) {
      throw new CodexAppServerFramingError(
        "CODEX_PROTOCOL_CLOSED",
        "Codex protocol framing is already closed",
      );
    }
    const messages: NativeMessage[] = [];
    let offset = 0;
    try {
      for (let index = 0; index < chunk.byteLength; index++) {
        if (chunk[index] !== 0x0a) continue;
        this.#append(chunk.subarray(offset, index));
        messages.push(this.#finishFrame());
        offset = index + 1;
      }
      if (offset < chunk.byteLength) this.#append(chunk.subarray(offset));
      return messages;
    } catch (error) {
      this.#failed = true;
      if (error instanceof CodexAppServerFramingError) throw error;
      throw new CodexAppServerFramingError(
        "CODEX_PROTOCOL_INVALID_UTF8",
        "Codex protocol output is not valid UTF-8",
      );
    }
  }

  end(): void {
    if (this.#failed) return;
    if (this.#frameBytes !== 0 || this.#frameText.length !== 0) {
      this.#failed = true;
      throw new CodexAppServerFramingError(
        "CODEX_PROTOCOL_TRUNCATED",
        "Codex protocol ended with an incomplete frame",
      );
    }
    this.#decoder.decode();
  }

  #append(bytes: Uint8Array): void {
    this.#frameBytes += bytes.byteLength;
    if (this.#frameBytes > this.#limits.maxFrameBytes) {
      throw new CodexAppServerFramingError(
        "CODEX_FRAME_TOO_LARGE",
        "Codex protocol frame exceeded its byte limit",
      );
    }
    if (this.#frameBytes > this.#limits.maxReceiveBufferBytes) {
      throw new CodexAppServerFramingError(
        "CODEX_RECEIVE_BUFFER_TOO_LARGE",
        "Codex protocol receive buffer exceeded its byte limit",
      );
    }
    this.#frameText += this.#decoder.decode(bytes, { stream: true });
  }

  #finishFrame(): NativeMessage {
    this.#frameText += this.#decoder.decode();
    const text = this.#frameText.endsWith("\r")
      ? this.#frameText.slice(0, -1)
      : this.#frameText;
    this.#decoder = new TextDecoder("utf-8", { fatal: true });
    this.#frameBytes = 0;
    this.#frameText = "";
    if (text.length === 0) {
      throw new CodexAppServerFramingError(
        "CODEX_PROTOCOL_INVALID",
        "Codex protocol emitted an empty frame",
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new CodexAppServerFramingError(
        "CODEX_PROTOCOL_INVALID",
        "Codex protocol emitted malformed JSON",
      );
    }
    if (!record(parsed)) {
      throw new CodexAppServerFramingError(
        "CODEX_PROTOCOL_INVALID",
        "Codex protocol frame must be an object",
      );
    }
    return parsed;
  }
}
