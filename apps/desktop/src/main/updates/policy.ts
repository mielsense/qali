import { readFile } from "node:fs/promises";
import { z } from "zod";

const desktopUpdatePolicySchema = z
  .object({
    formatVersion: z.literal(1),
    enabled: z.boolean(),
    channel: z.literal("latest"),
    repository: z.literal("mielsense/qali"),
  })
  .strict();

export type DesktopUpdatePolicy = z.infer<typeof desktopUpdatePolicySchema>;

export async function loadDesktopUpdatePolicy(
  path: string,
): Promise<DesktopUpdatePolicy | null> {
  try {
    return desktopUpdatePolicySchema.parse(
      JSON.parse(await readFile(path, "utf8")),
    );
  } catch {
    return null;
  }
}

export function desktopUpdatesEnabled(
  options: Readonly<{
    isPackaged: boolean;
    packagedSmoke: boolean;
    platform: NodeJS.Platform;
    policy: DesktopUpdatePolicy | null;
  }>,
): boolean {
  return (
    options.isPackaged &&
    !options.packagedSmoke &&
    options.platform === "darwin" &&
    options.policy?.enabled === true
  );
}
