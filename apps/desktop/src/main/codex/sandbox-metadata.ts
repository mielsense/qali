import { isAbsolute, normalize, resolve } from "node:path";

export const CODEX_SANDBOX_METADATA_PATH_COUNT = 16;
export const CODEX_SYSTEM_REQUIREMENTS_PATH = "/etc/codex/requirements.toml";

/**
 * Bind Seatbelt metadata reads to the exact canonical roots and ancestors that
 * path resolution needs, plus Codex's fixed optional system-requirements probe
 * so an absent file is reported as ENOENT instead of a fatal EPERM. Unused
 * slots repeat `/`, preserving one static, hashable profile without widening
 * metadata access to a directory subtree.
 */
export function codexSandboxMetadataPathArguments(
  paths: readonly string[],
): string[] {
  const ancestors = new Set<string>();
  for (const path of [...paths, CODEX_SYSTEM_REQUIREMENTS_PATH]) {
    if (!isAbsolute(path) || normalize(path) !== path) {
      throw new RangeError(
        "Codex sandbox metadata paths must be normalized absolutes",
      );
    }
    let current = path;
    for (;;) {
      ancestors.add(current);
      const parent = resolve(current, "..");
      if (parent === current) break;
      current = parent;
    }
  }
  if (ancestors.size > CODEX_SANDBOX_METADATA_PATH_COUNT) {
    throw new RangeError("Codex sandbox metadata ancestor chain is too deep");
  }
  const values = [...ancestors];
  while (values.length < CODEX_SANDBOX_METADATA_PATH_COUNT) values.push("/");
  return values.flatMap((path, index) => [
    "-D",
    `CODEX_METADATA_PATH_${index}=${path}`,
  ]);
}
