import { readFile, realpath } from "node:fs/promises";
import { relative, resolve } from "node:path";

import type { Protocol } from "electron";

export const RENDERER_ORIGIN = "qali-app://renderer";
export const RENDERER_SCHEME = "qali-app";

export interface RendererAsset {
  fileName: string;
  mimeType: string;
}

export type RendererAssetManifest = ReadonlyMap<string, RendererAsset>;

const MIME_TYPES: Readonly<Record<string, string>> = {
  ".avif": "image/avif",
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const RENDERER_CSP_PREFIX = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "form-action 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self'",
  "worker-src 'self' blob:",
] as const;

export function buildRendererCsp(convexOrigins: readonly string[]): string {
  const exactOrigins = convexOrigins.map((origin) => {
    if (!/^(?:http|ws):\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(origin)) {
      throw new Error("Convex origin must be an exact loopback HTTP or WebSocket origin");
    }

    const port = Number(new URL(origin).port);
    if (port > 65_535) {
      throw new Error("Convex origin port is invalid");
    }

    return origin;
  });

  return [
    ...RENDERER_CSP_PREFIX,
    `connect-src 'self' ${[...new Set(exactOrigins)].join(" ")}`,
  ].join("; ");
}

function extensionFor(fileName: string): string | undefined {
  const lastDot = fileName.lastIndexOf(".");
  return lastDot === -1 ? undefined : fileName.slice(lastDot).toLowerCase();
}

function isSafeManifestFileName(fileName: string): boolean {
  return (
    fileName.length > 0 &&
    !fileName.startsWith("/") &&
    !fileName.split("/").some((part) => part === ".." || part.length === 0)
  );
}

function assetPath(fileName: string): string {
  return fileName === "index.html" ? "/" : `/${fileName}`;
}

function isRendererUrl(url: URL): boolean {
  return (
    url.protocol === `${RENDERER_SCHEME}:` &&
    url.hostname === "renderer" &&
    url.port === "" &&
    url.username === "" &&
    url.password === ""
  );
}

export function resolveRendererAsset(
  requestUrl: string,
  manifest: RendererAssetManifest,
): RendererAsset | null {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }

  if (!isRendererUrl(url)) return null;

  const path = decodeURIComponent(url.pathname);
  if (path.split("/").includes("..")) return null;

  return manifest.get(path) ?? null;
}

export async function loadRendererAssetManifest(
  rendererRoot: string,
): Promise<RendererAssetManifest> {
  const rawManifest = JSON.parse(
    await readFile(resolve(rendererRoot, "renderer-assets.json"), "utf8"),
  ) as unknown;

  if (!Array.isArray(rawManifest) || !rawManifest.every((file) => typeof file === "string")) {
    throw new Error("Renderer asset manifest is invalid");
  }

  const assets = new Map<string, RendererAsset>();
  for (const fileName of rawManifest) {
    if (!isSafeManifestFileName(fileName)) {
      throw new Error("Renderer asset manifest contains an unsafe path");
    }

    const extension = extensionFor(fileName);
    const mimeType = extension === undefined ? undefined : MIME_TYPES[extension];
    if (mimeType === undefined) {
      throw new Error(`Renderer asset has no approved MIME type: ${fileName}`);
    }

    assets.set(assetPath(fileName), { fileName, mimeType });
  }

  if (!assets.has("/")) {
    throw new Error("Renderer asset manifest does not include index.html");
  }

  return assets;
}

async function responseForAsset(
  rendererRoot: string,
  asset: RendererAsset,
  csp: string,
): Promise<Response> {
  const resolvedRoot = await realpath(rendererRoot);
  const resolvedAsset = await realpath(resolve(resolvedRoot, asset.fileName));
  const relativeAsset = relative(resolvedRoot, resolvedAsset);
  if (
    relativeAsset === "" ||
    relativeAsset.startsWith("..") ||
    relativeAsset.startsWith("/")
  ) {
    return new Response("Not found", { status: 404 });
  }

  return new Response(await readFile(resolvedAsset), {
    headers: {
      "Content-Security-Policy": csp,
      "Content-Type": asset.mimeType,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function registerRendererProtocol(
  electronProtocol: Pick<Protocol, "handle">,
  rendererRoot: string,
  convexOrigins: readonly string[],
): Promise<void> {
  const manifest = await loadRendererAssetManifest(rendererRoot);
  const csp = buildRendererCsp(convexOrigins);
  electronProtocol.handle(
    RENDERER_SCHEME,
    createRendererRequestHandler(rendererRoot, manifest, csp),
  );
}

function createRendererRequestHandler(
  rendererRoot: string,
  manifest: RendererAssetManifest,
  csp: string,
): Parameters<Protocol["handle"]>[1] {
  return async (request) => {
    if (request.method !== "GET") {
      return new Response("Method not allowed", { status: 405 });
    }

    const asset = resolveRendererAsset(request.url, manifest);
    if (asset === null) return new Response("Not found", { status: 404 });

    try {
      return await responseForAsset(rendererRoot, asset, csp);
    } catch {
      return new Response("Not found", { status: 404 });
    }
  };
}
