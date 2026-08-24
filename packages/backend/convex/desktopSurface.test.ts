import { describe, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const CONVEX_ROOT = import.meta.dir;
const REPOSITORY_ROOT = join(CONVEX_ROOT, "../../..");

async function runtimeSources(root: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === "_generated" || entry.name.endsWith(".test.ts") || entry.name.endsWith(".itest.ts")) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && /\.(?:ts|tsx|json)$/.test(entry.name)) files.push(path);
    }
  };
  await visit(root);
  return files.sort();
}

async function sourceText(paths: readonly string[]): Promise<string> {
  return (await Promise.all(paths.map(async (path) =>
    `\n/* ${relative(REPOSITORY_ROOT, path)} */\n${await readFile(path, "utf8")}`))).join("\n");
}

describe("packaged desktop backend surface", () => {
  test("contains no hosted assistant, backend Google, Contacts, or People provider capability", async () => {
    const backend = await sourceText((await runtimeSources(CONVEX_ROOT)).filter((path) =>
      !path.endsWith("/schema.ts") && !path.endsWith("/domains/people/tables.ts"),
    ));
    const webAssistant = await sourceText([
      join(REPOSITORY_ROOT, "apps/web/src/components/workspace/assistant-dock.tsx"),
      join(REPOSITORY_ROOT, "apps/web/src/components/workspace/assistant-panel.tsx"),
    ]);
    const packageManifest = await readFile(join(CONVEX_ROOT, "../package.json"), "utf8");
    const serverEnv = await readFile(join(REPOSITORY_ROOT, "packages/env/src/server.ts"), "utf8");

    for (const forbidden of [
      /DEEPSEEK(?:_API_KEY|_BASE_URL)/,
      /api\.deepseek\.com/,
      /from ["']openai["']/,
      /people\.googleapis\.com/,
      /fetch(?:Other)?ContactsPage/,
      /getGoogleAccessToken/,
      /googleCredentials/,
      /contactsSyncToken|otherContactsSyncToken/,
      /defineTable\(\{[\s\S]{0,800}?resourceName:[\s\S]{0,800}?emails:/,
      /registerRoutes\(http/,
    ]) {
      expect(backend).not.toMatch(forbidden);
    }
    expect(backend).not.toMatch(/export const sendMessage\s*=\s*action/);
    expect(backend).not.toMatch(
      /export const (?:startTurn|getHistory|flushText|appendBlock|finishTurn|failTurn)\s*=/,
    );
    expect(backend).not.toMatch(/"sync google data"|"refresh people ranking"|"prune old assistant threads"/);
    expect(webAssistant).not.toMatch(/api\.assistant\.sendMessage|assistantData\.isAvailable/);
    expect(packageManifest).not.toMatch(/"openai"\s*:/);
    expect(serverEnv).not.toMatch(/DEEPSEEK_API_KEY|GOOGLE_CLIENT_ID|GOOGLE_CLIENT_SECRET/);
  });

  test("keeps calendar-derived attendee data without Contacts provider sources", async () => {
    const tables = await readFile(join(CONVEX_ROOT, "domains/people/tables.ts"), "utf8");
    const contractTables = tables.split("export const legacyPeopleTables")[0]!;
    expect(contractTables).toContain('v.literal("attendee")');
    expect(contractTables).not.toMatch(/v\.literal\("connection"\)|v\.literal\("other"\)|contacts:\s*defineTable/);
    expect(tables).toContain("Transitional validators used only by the pre-contraction deployment");
  });
});
