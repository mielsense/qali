import type { CommandId } from "@qali/desktop-contracts";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";

import { useQaliSettings } from "@/components/settings/settings-provider";

import { formatKeybindingLabel, resolveCommand } from "./keybinding";
import {
  COMMANDS,
  COMMAND_BY_ID,
  effectiveKeybinding,
  type CommandDispatcher,
  type CommandHandler,
} from "./registry";

type CommandContextValue = CommandDispatcher & {
  register(command: CommandId, handler: CommandHandler): () => void;
  label(command: CommandId): string | null;
};

const CommandContext = createContext<CommandContextValue | null>(null);

export function CommandProvider({ children }: { children: ReactNode }) {
  const { snapshot } = useQaliSettings();
  const overrides = snapshot.settings.keybindings.overrides;
  const handlersRef = useRef(
    new Map<CommandId, Set<CommandHandler>>(),
  );

  const register = useCallback((command: CommandId, handler: CommandHandler) => {
    const handlers = handlersRef.current;
    const commandHandlers = handlers.get(command) ?? new Set<CommandHandler>();
    commandHandlers.add(handler);
    handlers.set(command, commandHandlers);
    return () => {
      commandHandlers.delete(handler);
      if (commandHandlers.size === 0) handlers.delete(command);
    };
  }, []);

  const dispatch = useCallback((command: CommandId): boolean => {
    const handlers = handlersRef.current.get(command);
    if (!handlers?.size) return false;
    const handler = Array.from(handlers).at(-1);
    return handler ? handler() !== false : false;
  }, []);

  const label = useCallback(
    (command: CommandId): string | null => {
      const binding = effectiveKeybinding(command, overrides);
      return binding ? formatKeybindingLabel(binding) : null;
    },
    [overrides],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const handlers = handlersRef.current;
      const calendar = COMMANDS.some(
        (definition) =>
          definition.context === "calendar" && handlers.has(definition.id),
      );
      const command = resolveCommand(
        event,
        {
          calendar,
          recording:
            document.querySelector(
              "[data-keybinding-recorder][data-recording='true']",
            ) !== null,
          menuOpen:
            document.querySelector("[role='menu']:not([hidden])") !== null,
          dialogOpen:
            document.querySelector(
              "[role='dialog']:not([hidden]), [aria-modal='true']:not([hidden])",
            ) !== null,
        },
        overrides,
      );
      if (!command || !dispatch(command)) return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dispatch, overrides]);

  const value = useMemo<CommandContextValue>(
    () => ({ dispatch, register, label }),
    [dispatch, label, register],
  );
  return <CommandContext value={value}>{children}</CommandContext>;
}

export function useCommand(
  command: CommandId,
  handler?: CommandHandler,
  enabled = true,
): () => boolean {
  const context = useContext(CommandContext);
  if (!context) throw new Error("Commands require CommandProvider");
  const handlerRef = useRef(handler);
  const hasHandler = handler !== undefined;
  useLayoutEffect(() => {
    handlerRef.current = handler;
  }, [handler]);
  useEffect(() => {
    if (!enabled || !hasHandler) return;
    return context.register(command, () => handlerRef.current?.());
  }, [command, context, enabled, hasHandler]);
  return useCallback(() => context.dispatch(command), [command, context]);
}

export function useCommandLabel(command: CommandId): string | null {
  const context = useContext(CommandContext);
  if (!context) throw new Error("Command labels require CommandProvider");
  return context.label(command);
}

export function useCommandDispatcher(): CommandDispatcher["dispatch"] {
  const context = useContext(CommandContext);
  if (!context) throw new Error("Command dispatch requires CommandProvider");
  return context.dispatch;
}

export function commandLabel(command: CommandId): string {
  return COMMAND_BY_ID[command].label;
}
