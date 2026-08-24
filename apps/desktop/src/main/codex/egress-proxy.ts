import { lookup as lookupHost } from "node:dns/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  BlockList,
  createServer as createNetServer,
  connect as connectUpstream,
  isIP,
  type Server,
  type Socket,
} from "node:net";

import { CodexBoundaryError } from "./auth";
import { proxyPolicyHash } from "./manifest";

const MAX_HEADER_BYTES = 8 * 1024;
const MAX_CONNECTIONS = 8;

export type CodexEgressPolicyProbe =
  | Readonly<{ kind: "allowed-provider-endpoint" }>
  | Readonly<{ kind: "controlled-denial" }>;

export function probeCodexEgressPolicy(
  target: string,
  allowedHosts: readonly string[],
  allowedPorts: readonly number[],
): CodexEgressPolicyProbe {
  try {
    const url = new URL(target);
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      isIP(url.hostname) !== 0
    ) return { kind: "controlled-denial" };
    const port = url.port === "" ? 443 : Number(url.port);
    if (
      !Number.isSafeInteger(port) ||
      !allowedHosts.includes(url.hostname.toLowerCase()) ||
      !allowedPorts.includes(port)
    ) return { kind: "controlled-denial" };
    return { kind: "allowed-provider-endpoint" };
  } catch {
    return { kind: "controlled-denial" };
  }
}

export function parseConnectAuthority(
  authority: string,
  allowedHosts: readonly string[],
  allowedPorts: readonly number[],
): { host: string; port: number } {
  if (authority.length > 255 || /[\s\/@\[\]\\?#]/.test(authority)) {
    throw new CodexBoundaryError("CODEX_PROXY_DENIED", "Invalid CONNECT authority");
  }
  const match = /^([a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])):(\d{1,5})$/i.exec(authority);
  if (!match) throw new CodexBoundaryError("CODEX_PROXY_DENIED", "Invalid CONNECT authority");
  const host = (match[1] ?? "").toLowerCase();
  const port = Number(match[2]);
  if (isIP(host) || !allowedHosts.includes(host) || !allowedPorts.includes(port)) {
    throw new CodexBoundaryError("CODEX_PROXY_DENIED", "CONNECT destination is not allowed");
  }
  return { host, port };
}

export function parseConnectRequest(
  request: string,
  allowedHosts: readonly string[],
  allowedPorts: readonly number[],
): { host: string; port: number } {
  const lines = request.split("\r\n");
  const match = /^CONNECT ([^ ]+) HTTP\/1\.[01]$/.exec(lines[0] ?? "");
  if (!match) throw new CodexBoundaryError("CODEX_PROXY_DENIED", "Invalid CONNECT request");
  const destination = parseConnectAuthority(match[1] ?? "", allowedHosts, allowedPorts);
  let observedHost: string | undefined;
  for (const line of lines.slice(1)) {
    const header = /^([A-Za-z0-9-]+): ([\x20-\x7e]*)$/.exec(line);
    if (!header) throw new CodexBoundaryError("CODEX_PROXY_DENIED", "Invalid CONNECT header");
    const name = (header[1] ?? "").toLowerCase();
    const value = header[2] ?? "";
    if (name === "authorization" || name === "proxy-authorization" || name === "cookie") {
      throw new CodexBoundaryError("CODEX_PROXY_DENIED", "Proxy credentials are forbidden");
    }
    if (name === "host") {
      if (observedHost !== undefined || value.toLowerCase() !== `${destination.host}:${destination.port}`) {
        throw new CodexBoundaryError("CODEX_PROXY_DENIED", "CONNECT Host header does not match authority");
      }
      observedHost = value;
    }
  }
  if (observedHost === undefined) throw new CodexBoundaryError("CODEX_PROXY_DENIED", "CONNECT Host header is required");
  return destination;
}

const RESERVED_IPV4 = new BlockList();
const RESERVED_IPV6 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) RESERVED_IPV4.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 128], ["::1", 128], ["::ffff:0:0", 96], ["64:ff9b:1::", 48],
  ["100::", 64], ["2001::", 23], ["2001:db8::", 32], ["2002::", 16],
  ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) RESERVED_IPV6.addSubnet(network, prefix, "ipv6");

export function isPublicNetworkAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !RESERVED_IPV4.check(address, "ipv4");
  if (family === 6) return !RESERVED_IPV6.check(address, "ipv6");
  return false;
}

export type EgressProxy = Readonly<{
  url: string;
  port: number;
  allowedHosts: readonly string[];
  allowedPorts: readonly number[];
  policySha256: string;
  isClosed(): boolean;
  close(): Promise<void>;
}>;
export type CodexCapabilityCanaryTargets = Readonly<{
  filePath: string;
  processExecutable: string;
  processMarkerPath: string;
  networkUrl: string;
}>;
export type CodexCapabilityCanaries = Readonly<{
  fileIntact: boolean;
  processAbsent: boolean;
  networkUnreached: boolean;
}>;
export type CodexCapabilityCanary = Readonly<{
  targets: CodexCapabilityCanaryTargets;
  verify(): Promise<CodexCapabilityCanaries>;
  close(): Promise<void>;
}>;
export type CodexCapabilityProviderControls = Readonly<{
  testProvider: Readonly<{ id: "qali_fixture"; model: "qali-test-model" }>;
  inventory(): readonly string[];
  armToolAttempt(tool: string, targets: CodexCapabilityCanaryTargets): Promise<Readonly<{ prompt: string }>>;
  createCanary(tool: string): Promise<CodexCapabilityCanary>;
}>;
const OWNED_PROXIES = new WeakSet<object>();
const OWNED_CAPABILITY_PROVIDERS = new WeakSet<object>();
const CAPABILITY_PROVIDER_CONTROLS = new WeakMap<object, CodexCapabilityProviderControls>();

export function isQaliEgressProxy(value: unknown): boolean {
  return typeof value === "object" && value !== null && OWNED_PROXIES.has(value);
}

export function isQaliCapabilityProvider(value: unknown): boolean {
  return typeof value === "object" && value !== null && OWNED_CAPABILITY_PROVIDERS.has(value);
}

export function resolveQaliCapabilityProviderControls(value: unknown): CodexCapabilityProviderControls {
  const controls = typeof value === "object" && value !== null
    ? CAPABILITY_PROVIDER_CONTROLS.get(value)
    : undefined;
  if (!controls) {
    throw new CodexBoundaryError("CODEX_RELEASE_AUTHORITY_REQUIRED", "Qali-owned capability controls are required");
  }
  return controls;
}

type ProxyDependencies = Readonly<{
  lookup: typeof lookupHost;
  connect: typeof connectUpstream;
  listen(server: Server): Promise<number>;
  closeServer(server: Server): Promise<void>;
}>;

export async function startEgressProxy(input: {
  allowedHosts: readonly string[];
  allowedPorts: readonly number[];
  expectedPolicySha256: string;
  timeoutMs?: number;
}, dependencyOverrides: Partial<ProxyDependencies> = {}): Promise<EgressProxy> {
  const allowedHosts = Object.freeze(
    [...input.allowedHosts].map((host) => host.toLowerCase()).sort(),
  );
  const allowedPorts = Object.freeze(
    [...input.allowedPorts].sort((a, b) => a - b),
  );
  const policySha256 = proxyPolicyHash(allowedHosts, allowedPorts);
  if (policySha256 !== input.expectedPolicySha256) {
    throw new CodexBoundaryError("CODEX_PROXY_MISMATCH", "Proxy policy hash changed");
  }
  const dependencies: ProxyDependencies = {
    lookup: dependencyOverrides.lookup ?? lookupHost,
    connect: dependencyOverrides.connect ?? connectUpstream,
    listen: dependencyOverrides.listen ?? ((server) =>
      new Promise<number>((resolvePromise, rejectPromise) => {
        server.once("error", rejectPromise);
        server.listen(0, "127.0.0.1", () => {
          server.off("error", rejectPromise);
          const address = server.address();
          if (!address || typeof address === "string") {
            rejectPromise(new Error("Proxy did not bind loopback"));
            return;
          }
          resolvePromise(address.port);
        });
      })),
    closeServer: dependencyOverrides.closeServer ?? ((server) =>
      new Promise<void>((resolvePromise) => server.close(() => resolvePromise()))),
  };
  let active = 0;
  let closed = false;
  let closePromise: Promise<void> | undefined;
  const sockets = new Set<Socket>();
  const handlers = new Set<Promise<void>>();
  const server: Server = createNetServer((client) => {
    if (closed || ++active > MAX_CONNECTIONS) {
      client.destroy();
      if (active > 0) active--;
      return;
    }
    sockets.add(client);
    client.setTimeout(input.timeoutMs ?? 10_000, () => client.destroy());
    let header = Buffer.alloc(0);
    let handling = false;
    const finish = () => { active--; sockets.delete(client); };
    client.once("close", finish);
    const onData = (chunk: Buffer) => {
      if (handling || closed) { client.destroy(); return; }
      header = Buffer.concat([header, chunk]);
      if (header.byteLength > MAX_HEADER_BYTES) { client.destroy(); return; }
      const end = header.indexOf("\r\n\r\n");
      if (end < 0) return;
      handling = true;
      client.off("data", onData);
      const handler = (async () => {
        try {
          const request = header.subarray(0, end).toString("ascii");
          const destination = parseConnectRequest(request, allowedHosts, allowedPorts);
          const addresses = await dependencies.lookup(destination.host, { all: true, verbatim: true });
          if (closed) return;
          if (addresses.length === 0 || addresses.some(({ address }) => !isPublicNetworkAddress(address))) {
            throw new Error("unsafe DNS answer");
          }
          const upstream = dependencies.connect({ host: addresses[0]!.address, port: destination.port });
          if (closed) { upstream.destroy(); return; }
          sockets.add(upstream);
          upstream.setTimeout(input.timeoutMs ?? 10_000, () => upstream.destroy());
          upstream.once("connect", () => {
            if (closed) { upstream.destroy(); client.destroy(); return; }
            client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
            const remainder = header.subarray(end + 4);
            if (remainder.byteLength) upstream.write(remainder);
            client.pipe(upstream).pipe(client);
          });
          upstream.once("error", () => client.destroy());
          upstream.once("close", () => sockets.delete(upstream));
        } catch {
          client.destroy();
        }
      })();
      handlers.add(handler);
      void handler.finally(() => handlers.delete(handler));
    };
    client.on("data", onData);
  });
  const port = await dependencies.listen(server);
  const proxy: EgressProxy = Object.freeze({
    port,
    url: `http://127.0.0.1:${port}`,
    allowedHosts,
    allowedPorts,
    policySha256,
    isClosed: () => closed,
    close() {
      if (closePromise) return closePromise;
      closed = true;
      closePromise = (async () => {
        for (const socket of sockets) socket.destroy();
        await dependencies.closeServer(server);
        await Promise.allSettled([...handlers]);
        for (const socket of sockets) socket.destroy();
      })();
      return closePromise;
    },
  });
  OWNED_PROXIES.add(proxy);
  return proxy;
}

/**
 * Creates the disposable, Qali-owned loopback Responses provider used only by
 * the release capability verifier. Public assistant execution never accepts
 * this boundary kind.
 */
export async function startCapabilityProviderBoundary(input: {
  allowedHosts: readonly string[];
  allowedPorts: readonly number[];
  expectedPolicySha256: string;
  handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void>;
  releaseControls: Omit<CodexCapabilityProviderControls, "testProvider">;
}): Promise<EgressProxy> {
  const allowedHosts = [...input.allowedHosts].map((host) => host.toLowerCase()).sort();
  const allowedPorts = [...input.allowedPorts].sort((a, b) => a - b);
  const policySha256 = proxyPolicyHash(allowedHosts, allowedPorts);
  if (policySha256 !== input.expectedPolicySha256) {
    throw new CodexBoundaryError("CODEX_PROXY_MISMATCH", "Capability provider policy hash changed");
  }
  let closed = false;
  let closePromise: Promise<void> | undefined;
  const sockets = new Set<Socket>();
  const handlers = new Set<Promise<void>>();
  const server = createHttpServer((request, response) => {
    if (closed) {
      response.destroy();
      return;
    }
    const handler = input.handleRequest(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(400);
      response.end();
    });
    handlers.add(handler);
    void handler.finally(() => handlers.delete(handler));
  });
  server.maxConnections = MAX_CONNECTIONS;
  server.on("connection", (socket) => {
    if (closed) { socket.destroy(); return; }
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => { server.off("error", rejectPromise); resolvePromise(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Capability provider did not bind loopback");
  const provider: EgressProxy = {
    port: address.port,
    url: `http://127.0.0.1:${address.port}`,
    allowedHosts,
    allowedPorts,
    policySha256,
    isClosed: () => closed,
    close() {
      if (closePromise) return closePromise;
      closed = true;
      closePromise = (async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
        await Promise.allSettled([...handlers]);
        for (const socket of sockets) socket.destroy();
      })();
      return closePromise;
    },
  };
  OWNED_CAPABILITY_PROVIDERS.add(provider);
  CAPABILITY_PROVIDER_CONTROLS.set(provider, Object.freeze({
    testProvider: Object.freeze({ id: "qali_fixture", model: "qali-test-model" }),
    inventory: input.releaseControls.inventory,
    armToolAttempt: input.releaseControls.armToolAttempt,
    createCanary: input.releaseControls.createCanary,
  }));
  return provider;
}
