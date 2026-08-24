import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { readdir, rename } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { type Plugin, version, type UserConfig } from "vite";

export const desktopViteVersion = version;

export interface DesktopRendererPaths {
  rendererEntry: string;
  rendererOutDir: string;
  rendererRoot: string;
  rendererSourceRoot: string;
  desktopAuthClient: string;
}

async function listPublicFiles(
  root: string,
  directory = root,
): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = resolve(directory, entry.name);
      return entry.isDirectory()
        ? listPublicFiles(root, entryPath)
        : [relative(root, entryPath)];
    }),
  );
  return files.flat();
}

function desktopRendererManifest(): Plugin {
  let publicDir = "";
  let outDir = "";

  return {
    name: "qali:desktop-renderer-manifest",
    configResolved(config) {
      publicDir = config.publicDir;
      outDir = config.build.outDir;
    },
    async generateBundle(_options, bundle) {
      this.emitFile({
        fileName: "renderer-assets.json",
        source: JSON.stringify(
          [
            "index.html",
            ...Object.keys(bundle),
            ...(await listPublicFiles(publicDir)),
          ].sort(),
        ),
        type: "asset",
      });
    },
    async closeBundle() {
      await rename(
        resolve(outDir, "index.desktop.html"),
        resolve(outDir, "index.html"),
      );
    },
  };
}

export function createDesktopRendererConfig(
  paths: DesktopRendererPaths,
): UserConfig {
  return {
    root: paths.rendererRoot,
    server: { port: 3001 },
    resolve: {
      alias: [
        { find: /^@\/lib\/auth-client$/, replacement: paths.desktopAuthClient },
        { find: /^@\//, replacement: `${paths.rendererSourceRoot}/` },
      ],
    },
    plugins: [
      tailwindcss(),
      tanstackRouter({ target: "react", autoCodeSplitting: true }),
      react(),
      desktopRendererManifest(),
    ],
    build: {
      emptyOutDir: true,
      outDir: paths.rendererOutDir,
      rollupOptions: {
        input: { index: paths.rendererEntry },
      },
    },
  };
}
