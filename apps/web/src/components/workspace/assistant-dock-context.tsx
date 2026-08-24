import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";

import { useCommand } from "@/commands/command-provider";
import { desktopAssistantFor } from "@/lib/desktop/assistant";

type AssistantDockContextValue = Readonly<{
  available: boolean;
  open: boolean;
  close(): void;
  toggle(): void;
}>;

const AssistantDockContext = createContext<AssistantDockContextValue | null>(
  null,
);

export function AssistantDockProvider({ children }: { children: ReactNode }) {
  const available = useMemo(() => desktopAssistantFor() !== null, []);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const toggle = useCallback(() => setOpen((current) => !current), []);

  useCommand("assistant.toggle", toggle, available);

  const value = useMemo(
    () => ({ available, open, close, toggle }),
    [available, open, close, toggle],
  );
  return <AssistantDockContext value={value}>{children}</AssistantDockContext>;
}

export function useAssistantDock(): AssistantDockContextValue {
  const context = useContext(AssistantDockContext);
  if (!context) {
    throw new Error("useAssistantDock must be used within AssistantDockProvider");
  }
  return context;
}
