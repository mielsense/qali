import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:net";

import {
  startCapabilityProviderBoundary,
  type CodexCapabilityCanary,
  type CodexCapabilityCanaryTargets,
  type EgressProxy,
} from "../../src/main/codex/egress-proxy";

const MAX_REQUEST_BYTES = 1024 * 1024;

async function createCapabilityCanary(root: string, tool: string): Promise<CodexCapabilityCanary> {
  const name = tool.replace(/[^a-zA-Z0-9_-]/g, "_");
  const canaryRoot = join(root, `canary-${name}`);
  await mkdir(canaryRoot, { recursive: true, mode: 0o700 });
  const filePath = join(canaryRoot, "file-canary");
  const processExecutable = join(canaryRoot, "process-canary");
  const processMarkerPath = join(canaryRoot, "process-ran");
  await writeFile(filePath, "intact", { mode: 0o600 });
  await writeFile(processExecutable, `#!/bin/sh\n/usr/bin/touch '${processMarkerPath}'\n`, { mode: 0o700 });
  let networkConnections = 0;
  const server = createServer((socket) => { networkConnections++; socket.destroy(); });
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => { server.off("error", rejectPromise); resolvePromise(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("network canary did not bind");
  return {
    targets: {
      filePath,
      processExecutable,
      processMarkerPath,
      networkUrl: `http://127.0.0.1:${address.port}/canary`,
    },
    async verify() {
      const fileIntact = await readFile(filePath, "utf8").then((value) => value === "intact").catch(() => false);
      const processAbsent = await readFile(processMarkerPath).then(() => false).catch(() => true);
      return { fileIntact, processAbsent, networkUnreached: networkConnections === 0 };
    },
    close: () => new Promise<void>((resolvePromise) => server.close(() => resolvePromise())),
  };
}

function toolIdentity(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid tool declaration");
  const tool = value as Record<string, unknown>;
  if (typeof tool.type !== "string" || !/^[a-z0-9_.-]+$/i.test(tool.type)) throw new Error("invalid tool declaration type");
  if (typeof tool.name === "string") {
    if (!/^[a-z0-9_.-]+$/i.test(tool.name)) throw new Error("invalid tool declaration name");
    return `${tool.type}:${tool.name}`;
  }
  if (tool.function && typeof tool.function === "object" && typeof (tool.function as Record<string, unknown>).name === "string") {
    const name = (tool.function as Record<string, unknown>).name as string;
    if (!/^[a-z0-9_.-]+$/i.test(name)) throw new Error("invalid tool declaration name");
    return `${tool.type}:${name}`;
  }
  return tool.type;
}

const KNOWN_TOOL_FIELDS = new Set([
  "tools", "additional_tools", "tool_choice", "parallel_tool_calls", "max_tool_calls",
]);

export function extractPinnedToolInventory(requests: readonly Record<string, unknown>[]): string[] {
  const inventory: string[] = [];
  for (const request of requests) {
    for (const key of Object.keys(request)) {
      if (/(?:^|_)tools?(?:_|$)|tool_declarations/i.test(key) && !KNOWN_TOOL_FIELDS.has(key)) {
        throw new Error(`unknown tool declaration field: ${key}`);
      }
    }
    for (const field of ["tools", "additional_tools"] as const) {
      const declarations = request[field];
      if (declarations === undefined) continue;
      if (!Array.isArray(declarations)) throw new Error(`invalid ${field} declaration field`);
      for (const declaration of declarations) inventory.push(`${field}:${toolIdentity(declaration)}`);
    }
  }
  return [...new Set(inventory)].sort();
}

function responseEnvelope(id: string, model: string, status: "in_progress" | "completed", output: unknown[]) {
  return {
    id,
    object: "response",
    created_at: 1,
    status,
    background: false,
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    max_tool_calls: null,
    model,
    output,
    parallel_tool_calls: false,
    previous_response_id: null,
    prompt_cache_key: null,
    prompt_cache_retention: null,
    reasoning: { effort: "low", summary: null },
    safety_identifier: null,
    service_tier: "default",
    store: false,
    temperature: 1,
    text: { format: { type: "json_schema", name: "qali_output", strict: true, schema: {} }, verbosity: "medium" },
    tool_choice: "auto",
    tools: [],
    top_logprobs: 0,
    top_p: 1,
    truncation: "disabled",
    usage: status === "completed" ? { input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 2 } : null,
    user: null,
    metadata: {},
  };
}

function writeEvent(response: ServerResponse, event: unknown): void {
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_REQUEST_BYTES) throw new Error("request too large");
    chunks.push(buffer);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid request");
  return value as Record<string, unknown>;
}

export async function startFakeResponsesServer(input: {
  allowedHosts: readonly string[];
  allowedPorts: readonly number[];
  expectedPolicySha256: string;
  canaryRoot: string;
}): Promise<{
  url: string;
  proxy: EgressProxy;
  close(): Promise<void>;
}> {
  const captured: Record<string, unknown>[] = [];
  let armedTool: string | undefined;
  let armedTargets: CodexCapabilityCanaryTargets | undefined;
  const handleRequest = async (request: IncomingMessage, response: ServerResponse) => {
    if (request.method !== "POST" || request.url !== "/responses") {
      response.writeHead(404).end();
      return;
    }
    try {
      const body = await readJson(request);
      captured.push(body);
      const serializedInput = JSON.stringify(body.input ?? "");
      const phase = serializedInput.includes("finalizer") ? "finalizer" : "planner";
      const model = typeof body.model === "string" ? body.model : "qali-test-model";
      const id = `resp_qali_${captured.length}`;
      if (armedTool) {
        const forced = armedTool;
        const targets = armedTargets;
        armedTool = undefined;
        armedTargets = undefined;
        if (!targets) throw new Error("tool canaries were not armed");
        const [_source, type, name] = forced.split(":", 3);
        const item = type === "function"
          ? { id: `call_qali_${captured.length}`, type: "function_call", status: "completed", call_id: `call_qali_${captured.length}`, name: name ?? "qali_canary", arguments: JSON.stringify(targets) }
          : type === "custom"
            ? { id: `call_qali_${captured.length}`, type: "custom_tool_call", status: "completed", call_id: `call_qali_${captured.length}`, name: name ?? "qali_canary", input: JSON.stringify(targets) }
            : type === "local_shell"
              ? { id: `call_qali_${captured.length}`, type: "local_shell_call", status: "completed", call_id: `call_qali_${captured.length}`, action: { type: "exec", command: [targets.processExecutable], timeout_ms: 1_000 } }
              : { id: `call_qali_${captured.length}`, type: `${type}_call`, status: "completed", action: { type: "search", query: JSON.stringify(targets) } };
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "close" });
        writeEvent(response, { type: "response.created", sequence_number: 0, response: responseEnvelope(id, model, "in_progress", []) });
        writeEvent(response, { type: "response.output_item.added", sequence_number: 1, output_index: 0, item: { ...item, status: "in_progress" } });
        writeEvent(response, { type: "response.output_item.done", sequence_number: 2, output_index: 0, item });
        writeEvent(response, { type: "response.completed", sequence_number: 3, response: responseEnvelope(id, model, "completed", [item]) });
        response.end("data: [DONE]\n\n");
        return;
      }
      const itemId = `msg_qali_${captured.length}`;
      const text = JSON.stringify({ answer: phase });
      const item = { id: itemId, type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", annotations: [], logprobs: [], text }] };
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "close" });
      writeEvent(response, { type: "response.created", sequence_number: 0, response: responseEnvelope(id, model, "in_progress", []) });
      writeEvent(response, { type: "response.output_item.added", sequence_number: 1, output_index: 0, item: { ...item, status: "in_progress", content: [] } });
      writeEvent(response, { type: "response.content_part.added", sequence_number: 2, item_id: itemId, output_index: 0, content_index: 0, part: { type: "output_text", annotations: [], logprobs: [], text: "" } });
      writeEvent(response, { type: "response.output_text.delta", sequence_number: 3, item_id: itemId, output_index: 0, content_index: 0, delta: text, logprobs: [] });
      writeEvent(response, { type: "response.output_text.done", sequence_number: 4, item_id: itemId, output_index: 0, content_index: 0, text, logprobs: [] });
      writeEvent(response, { type: "response.content_part.done", sequence_number: 5, item_id: itemId, output_index: 0, content_index: 0, part: item.content[0] });
      writeEvent(response, { type: "response.output_item.done", sequence_number: 6, output_index: 0, item });
      writeEvent(response, { type: "response.completed", sequence_number: 7, response: responseEnvelope(id, model, "completed", [item]) });
      response.end("data: [DONE]\n\n");
    } catch {
      response.writeHead(400).end();
    }
  };
  const inventory = () => extractPinnedToolInventory(captured);
  const armToolAttempt = async (tool: string, targets: CodexCapabilityCanaryTargets) => {
    if (!inventory().includes(tool)) throw new Error("tool was not advertised by pinned Codex");
    armedTool = tool;
    armedTargets = targets;
    return { prompt: `Exercise the advertised ${armedTool} capability exactly once.` };
  };
  const provider = await startCapabilityProviderBoundary({
    allowedHosts: input.allowedHosts,
    allowedPorts: input.allowedPorts,
    expectedPolicySha256: input.expectedPolicySha256,
    handleRequest,
    releaseControls: {
      inventory,
      armToolAttempt,
      createCanary: (tool) => createCapabilityCanary(input.canaryRoot, tool),
    },
  });
  return {
    url: provider.url,
    proxy: provider,
    close: provider.close,
  };
}
