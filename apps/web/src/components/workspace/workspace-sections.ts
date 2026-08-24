import type { CommandId } from "@qali/desktop-contracts";

export const WORKSPACE_SECTION_IDS = [
  "calendar",
  "insights",
  "settings",
] as const;

export type WorkspaceSectionId = (typeof WORKSPACE_SECTION_IDS)[number];

export const DEFAULT_WORKSPACE_SECTION_ORDER: readonly WorkspaceSectionId[] =
  WORKSPACE_SECTION_IDS;

export const WORKSPACE_SECTION_COMMANDS = [
  "workspace.section.1",
  "workspace.section.2",
  "workspace.section.3",
  "workspace.section.4",
  "workspace.section.5",
  "workspace.section.6",
  "workspace.section.7",
  "workspace.section.8",
  "workspace.section.9",
] as const satisfies readonly CommandId[];

export const WORKSPACE_SECTION_ORDER_STORAGE_KEY =
  "qali.workspace.section-order.v1";

export function normalizeWorkspaceSectionOrder(
  value: unknown,
): WorkspaceSectionId[] {
  const known = new Set<WorkspaceSectionId>(WORKSPACE_SECTION_IDS);
  const ordered: WorkspaceSectionId[] = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      if (
        typeof item === "string" &&
        known.has(item as WorkspaceSectionId) &&
        !ordered.includes(item as WorkspaceSectionId)
      ) {
        ordered.push(item as WorkspaceSectionId);
      }
    }
  }
  for (const id of DEFAULT_WORKSPACE_SECTION_ORDER) {
    if (!ordered.includes(id)) ordered.push(id);
  }
  return ordered;
}

export function readWorkspaceSectionOrder(
  storage: Pick<Storage, "getItem">,
): WorkspaceSectionId[] {
  try {
    const stored = storage.getItem(WORKSPACE_SECTION_ORDER_STORAGE_KEY);
    return normalizeWorkspaceSectionOrder(stored ? JSON.parse(stored) : null);
  } catch {
    return [...DEFAULT_WORKSPACE_SECTION_ORDER];
  }
}

export function writeWorkspaceSectionOrder(
  storage: Pick<Storage, "setItem">,
  order: readonly WorkspaceSectionId[],
): void {
  storage.setItem(
    WORKSPACE_SECTION_ORDER_STORAGE_KEY,
    JSON.stringify(normalizeWorkspaceSectionOrder(order)),
  );
}

export function sectionCommandId(index: number): CommandId {
  const command = WORKSPACE_SECTION_COMMANDS[index];
  if (!command) throw new RangeError(`No workspace section command at ${index}`);
  return command;
}
