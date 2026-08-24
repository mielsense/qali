import type { CommandId } from "@qali/desktop-contracts";

import type { CommandMenuItem } from "./command-menu-items";

type Navigate = (input: { to: CommandMenuItem["action"] extends infer _Action ? string : never }) => Promise<unknown> | unknown;

type CommandMenuActionDependencies = Readonly<{
  dispatch(command: CommandId): boolean;
  navigate: Navigate;
  afterNavigation?: () => Promise<void>;
}>;

function afterRouteCommit(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

/**
 * Runs a palette item without assuming that the current route owns every
 * command handler. Calendar handlers mount with the calendar route, so a
 * command selected from Settings or Insights first navigates home and retries
 * only after that route has committed.
 */
export async function runCommandMenuItem(
  item: CommandMenuItem,
  dependencies: CommandMenuActionDependencies,
): Promise<void> {
  if (item.action.kind === "route") {
    await dependencies.navigate({ to: item.action.to });
    return;
  }

  if (dependencies.dispatch(item.action.command)) return;
  if (!item.action.command.startsWith("calendar.")) return;

  await dependencies.navigate({ to: "/" });
  await (dependencies.afterNavigation ?? afterRouteCommit)();
  dependencies.dispatch(item.action.command);
}
