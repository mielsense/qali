import { fileURLToPath } from "node:url";

export function resolvePreloadPath(mainModuleUrl: string): string {
  return fileURLToPath(new URL("../preload/index.cjs", mainModuleUrl));
}
