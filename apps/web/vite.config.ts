import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { readdir } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";

async function listPublicFiles(root: string, directory = root): Promise<string[]> {
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

  return {
    name: "qali:desktop-renderer-manifest",
    configResolved(config) {
      publicDir = config.publicDir;
    },
    async generateBundle(_options, bundle) {
      this.emitFile({
        fileName: "renderer-assets.json",
        source: JSON.stringify(
          ["index.html", ...Object.keys(bundle), ...(await listPublicFiles(publicDir))].sort(),
        ),
        type: "asset",
      });
    },
  };
}

export default defineConfig({
  server: {
    port: 3001,
  },
  resolve: {
    tsconfigPaths: true,
  },
  plugins: [
    tailwindcss(),
    tanstackRouter({
      target: "react",
      autoCodeSplitting: true,
    }),
    react(),
    desktopRendererManifest(),
  ],
});
