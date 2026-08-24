import { api } from "@qali/backend/convex/_generated/api";
import type { Id } from "@qali/backend/convex/_generated/dataModel";
import { Button } from "@qali/ui/components/button";
import { Spinner } from "@qali/ui/components/spinner";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  Component,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { useStableQuery } from "@/components/calendar/use-stable-query";
import {
  desktopAssistantFor,
  desktopAssistantSessionFor,
  type DesktopAssistant,
  type DesktopAssistantSession,
  type DesktopAssistantSessionSnapshot,
} from "@/lib/desktop/assistant";
import { useDesktopStatus } from "@/lib/desktop/status";
import { useAssistantDock } from "./assistant-dock-context";
import { MascotGlyph } from "./mascot-glyph";

type Threads = FunctionReturnType<typeof api.assistantData.listThreads>;
type Messages = FunctionReturnType<typeof api.assistantData.listMessages>;
type Actions = FunctionReturnType<typeof api.assistantData.listPendingActions>;
type Quota = FunctionReturnType<typeof api.assistantData.monthlyQuota>;

/**
 * The assistant is an attached workspace drawer rather than another menu.
 * Conversation data stays warm while the panel itself lazy-loads. The drawer
 * owns layout space, so opening it pushes the workspace left instead of
 * covering the calendar.
 *
 * The panel brings a markdown renderer with it — ~47 kB gzipped — for a feature
 * that is optional and, on a deployment with no API key, never reachable at
 * all. It only mounts when the dock opens it, so it can arrive then too.
 */
const loadAssistantPanel = () =>
  import("./assistant-panel").then((m) => ({ default: m.AssistantPanel }));

// Created once at module scope so React keeps its resolved value: reopening the
// dock reuses it instead of re-suspending on a fresh lazy each time. A retry
// (after a load failure) swaps in a new one to re-run the import.
const AssistantPanelLazy = lazy(loadAssistantPanel);

export function AssistantDock() {
  // The assistant is optional: with no API key configured its dock is not
  // rendered at all. `undefined` (still loading) counts as unavailable so the
  // button doesn't pop into the corner a beat after first paint.
  const desktopStatus = useDesktopStatus();
  const desktopAssistant = useMemo(() => desktopAssistantFor(), []);
  const { available: assistantAvailable, open, close, toggle } = useAssistantDock();
  const [desktopSession, setDesktopSession] =
    useState<DesktopAssistantSession | null>(null);
  const [desktopSessionSnapshot, setDesktopSessionSnapshot] =
    useState<DesktopAssistantSessionSnapshot | null>(null);

  useEffect(() => {
    const session = desktopAssistantSessionFor();
    if (!session) return;
    setDesktopSession(session);
    setDesktopSessionSnapshot(session.getSnapshot());
    const unsubscribe = session.subscribe(setDesktopSessionSnapshot);
    void session.refreshStatus().catch(() => {
      // Native/provider text remains behind the typed desktop boundary. A
      // later manual remediation can retry without losing the user's draft.
    });
    return () => {
      unsubscribe();
      session.dispose();
    };
  }, []);

  // The thread id is local to the dock so creating a thread on the first message
  // never remounts the panel mid-conversation.
  const [threadId, setThreadId] = useState<Id<"assistantThreads"> | null>(null);
  const [startingFresh, setStartingFresh] = useState(false);
  const reduceMotion = useReducedMotion();

  // The dock — always mounted — owns the conversation subscriptions, so the
  // panel opens onto warm data instead of reloading each time (the panel itself
  // only mounts while open). Thread-specific queries deliberately do not retain
  // results across argument changes: an old conversation is worse than a brief
  // loading state while a newly created thread subscribes.
  const threads = useStableQuery(
    api.assistantData.listThreads,
    assistantAvailable ? {} : "skip",
  );
  const messages = useQuery(
    api.assistantData.listMessages,
    assistantAvailable && threadId ? { threadId } : "skip",
  );
  const actions = useQuery(
    api.assistantData.listPendingActions,
    assistantAvailable && threadId ? { threadId } : "skip",
  );
  // The rolling-30-day message allowance, so the composer can show what's left
  // and block sending once it's spent. Cheap enough to keep warm with the rest.
  const quota = useQuery(
    api.assistantData.monthlyQuota,
    assistantAvailable ? {} : "skip",
  );
  // Warm the lazy panel as soon as the assistant exists, so opening it never
  // flashes the Suspense spinner.
  useEffect(() => {
    if (assistantAvailable) void loadAssistantPanel();
  }, [assistantAvailable]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [close, open]);

  const selectThread = useCallback((id: Id<"assistantThreads">) => {
    setThreadId(id);
    setStartingFresh(false);
  }, []);

  const deleteThread = useMutation(api.assistantMaintenance.deleteThread);
  const startNewChat = useCallback(() => {
    // Starting fresh discards the conversation just left: at most a handful of
    // threads ever accumulate, and the 30-day cron mops up any stragglers.
    const prior = threadId;
    setThreadId(null);
    setStartingFresh(true);
    if (prior) {
      void deleteThread({ threadId: prior });
    }
  }, [threadId, deleteThread]);

  if (!assistantAvailable) return null;

  return (
    <>
      <motion.div
        className="fixed bottom-4 right-4 z-50"
        initial={reduceMotion ? false : { opacity: 0, scale: 0.92 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={
          reduceMotion
            ? { duration: 0 }
            : { type: "spring", stiffness: 400, damping: 26 }
        }
      >
        <Button
          type="button"
          variant={open ? "raised" : "quiet"}
          size="icon-lg"
          aria-label={open ? "Close assistant" : "Open assistant"}
          aria-pressed={open}
          title={open ? "Close assistant" : "Open assistant"}
          onClick={toggle}
          className="qali-elevation-floating rounded-xl bg-background/95"
        >
          <MascotGlyph className="size-5" />
        </Button>
      </motion.div>

      <AnimatePresence initial={false}>
        {open ? (
          <motion.aside
            key="assistant-layout-pane"
            aria-label="Calendar assistant"
            className="relative z-40 h-full min-h-0 w-[560px] max-w-[40vw] shrink-0 overflow-hidden border-s border-border bg-background"
            initial={reduceMotion ? { width: 0, opacity: 0 } : { width: 0, opacity: 0.72 }}
            animate={{ width: 560, opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={
              reduceMotion
                ? { duration: 0 }
                : { type: "spring", stiffness: 550, damping: 40 }
            }
          >
            <div className="h-full w-full bg-background">
              <AssistantPanelLoader
                threadId={threadId}
                onThreadChange={selectThread}
                startFresh={startingFresh}
                onNewChat={startNewChat}
                onClose={close}
                threads={threads}
                messages={messages}
                actions={actions}
                quota={quota}
                desktopAssistant={desktopAssistant}
                assistantStatus={desktopStatus?.assistant}
                desktopSession={desktopSession}
                desktopSessionSnapshot={desktopSessionSnapshot}
              />
            </div>
          </motion.aside>
        ) : null}
      </AnimatePresence>
    </>
  );
}

function AssistantPanelLoader({
  threadId,
  onThreadChange,
  startFresh,
  onNewChat,
  onClose,
  threads,
  messages,
  actions,
  quota,
  desktopAssistant,
  assistantStatus,
  desktopSession,
  desktopSessionSnapshot,
}: {
  threadId: Id<"assistantThreads"> | null;
  onThreadChange: (threadId: Id<"assistantThreads">) => void;
  startFresh: boolean;
  onNewChat: () => void;
  onClose: () => void;
  threads: Threads | undefined;
  messages: Messages | undefined;
  actions: Actions | undefined;
  quota: Quota | undefined;
  desktopAssistant: DesktopAssistant | null;
  assistantStatus:
    import("@qali/desktop-contracts").AssistantProviderStatus | undefined;
  desktopSession: DesktopAssistantSession | null;
  desktopSessionSnapshot: DesktopAssistantSessionSnapshot | null;
}) {
  const [attempt, setAttempt] = useState(0);
  const Panel = useMemo(
    () => (attempt === 0 ? AssistantPanelLazy : lazy(loadAssistantPanel)),
    [attempt],
  );

  return (
    <AssistantPanelErrorBoundary
      key={attempt}
      onRetry={() => setAttempt((current) => current + 1)}
      onClose={onClose}
    >
      <Suspense
        fallback={
          <div
            role="status"
            aria-label="Loading assistant"
            className="flex h-full items-center justify-center"
          >
            <Spinner />
          </div>
        }
      >
        <Panel
          threadId={threadId}
          onThreadChange={onThreadChange}
          startFresh={startFresh}
          onNewChat={onNewChat}
          onClose={onClose}
          threads={threads}
          messages={messages}
          actions={actions}
          quota={quota}
          desktopAssistant={desktopAssistant}
          assistantStatus={assistantStatus}
          desktopSession={desktopSession}
          desktopSessionSnapshot={desktopSessionSnapshot}
        />
      </Suspense>
    </AssistantPanelErrorBoundary>
  );
}

class AssistantPanelErrorBoundary extends Component<
  { children: ReactNode; onRetry: () => void; onClose: () => void },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert" className="flex flex-col gap-3 py-2">
        <div>
          <p className="text-sm font-medium">Assistant failed to load</p>
          <p className="text-xs text-muted-foreground">
            Check your connection and try again.
          </p>
        </div>
        <div className="flex gap-1.5">
          <Button type="button" size="sm" variant="raised" onClick={this.props.onRetry}>
            Retry
          </Button>
          <Button
            type="button"
            size="sm"
            variant="quiet"
            onClick={this.props.onClose}
          >
            Close
          </Button>
        </div>
      </div>
    );
  }
}
