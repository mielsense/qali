import { api } from "@qali/backend/convex/_generated/api";
import type { Id } from "@qali/backend/convex/_generated/dataModel";
import type { AssistantProviderStatus } from "@qali/desktop-contracts";
import type { FunctionReturnType } from "convex/server";
import { Button } from "@qali/ui/components/button";
import { ConfirmationDialog } from "@qali/ui/components/confirmation-dialog";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  assistantSendError,
  type DesktopAssistant,
  type DesktopAssistantSession,
  type DesktopAssistantSessionSnapshot,
} from "@/lib/desktop/assistant";
import { notify } from "@/lib/notices";

import { AssistantComposer } from "./assistant-composer";
import {
  assistantAttemptSettled,
  freshAssistantThreadId,
} from "./assistant-interactions";
import {
  AssistantReadiness,
  assistantCanSend,
  assistantRemediation,
} from "./assistant-readiness";
import { AssistantShell } from "./assistant-shell";
import { AssistantTimeline } from "./assistant-timeline";
import { type AssistantAction } from "./assistant-proposal-card";

const SUGGESTIONS = [
  "What's on my calendar tomorrow?",
  "Find 30 minutes for a call this week",
  "Move my next meeting an hour later",
];
const DRAFT_STORAGE_KEY = "qali.assistant.draft.v1";

type AcceptedAttempt = {
  attemptId: string;
  text: string;
  previousUserMessageId: Id<"assistantMessages"> | null;
  previousThreadId: Id<"assistantThreads"> | null;
};

export function AssistantPanel({
  onClose,
  threadId,
  onThreadChange,
  startFresh,
  onNewChat,
  threads,
  messages,
  actions,
  quota,
  desktopAssistant,
  assistantStatus,
  desktopSession,
  desktopSessionSnapshot,
}: {
  onClose: () => void;
  threadId: Id<"assistantThreads"> | null;
  onThreadChange: (threadId: Id<"assistantThreads">) => void;
  startFresh: boolean;
  onNewChat: () => void;
  threads: FunctionReturnType<typeof api.assistantData.listThreads> | undefined;
  messages:
    FunctionReturnType<typeof api.assistantData.listMessages> | undefined;
  actions:
    FunctionReturnType<typeof api.assistantData.listPendingActions> | undefined;
  quota: FunctionReturnType<typeof api.assistantData.monthlyQuota> | undefined;
  desktopAssistant: DesktopAssistant | null;
  assistantStatus: AssistantProviderStatus | undefined;
  desktopSession: DesktopAssistantSession | null;
  desktopSessionSnapshot: DesktopAssistantSessionSnapshot | null;
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const openedLoginChallengeRef = useRef<string | null>(null);
  const [draft, setDraft] = useState(() => readDraft());
  const [sending, setSending] = useState(false);
  const [confirmNewChatOpen, setConfirmNewChatOpen] = useState(false);
  const [acceptedAttempt, setAcceptedAttempt] =
    useState<AcceptedAttempt | null>(null);
  const effectiveStatus: AssistantProviderStatus =
    desktopSessionSnapshot?.status ?? assistantStatus ?? { kind: "probing" };
  const streaming =
    messages?.some((message) => message.status === "streaming") ?? false;
  const limitReached = quota !== undefined && quota.remaining <= 0;
  const blocked = !desktopAssistant || !assistantCanSend(effectiveStatus);
  const acceptedAttemptSettled = acceptedAttempt
    ? assistantAttemptSettled(
        messages,
        acceptedAttempt.previousUserMessageId,
        acceptedAttempt.text,
      )
    : false;
  const busy = sending || streaming || acceptedAttempt !== null;
  const actionsById = useMemo(
    () =>
      new Map(
        (actions ?? []).map((action) => [
          action._id,
          action as AssistantAction,
        ]),
      ),
    [actions],
  );

  useEffect(() => {
    if (typeof sessionStorage !== "undefined")
      sessionStorage.setItem(DRAFT_STORAGE_KEY, draft);
  }, [draft]);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEffect(() => {
    const attemptId = desktopSessionSnapshot?.attemptId;
    const challenge = desktopSessionSnapshot?.challenge;
    if (!desktopSession || !attemptId || !challenge) return;

    const challengeKey = `${attemptId}:${challenge.url}:${challenge.code}`;
    if (openedLoginChallengeRef.current === challengeKey) return;
    openedLoginChallengeRef.current = challengeKey;

    void desktopSession.openChallenge().catch(() => {
      openedLoginChallengeRef.current = null;
      notify({ kind: "assistant-sign-in-failed" });
    });
  }, [
    desktopSession,
    desktopSessionSnapshot?.attemptId,
    desktopSessionSnapshot?.challenge,
  ]);
  useEffect(() => {
    if (acceptedAttempt && acceptedAttemptSettled) {
      setAcceptedAttempt(null);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [acceptedAttempt, acceptedAttemptSettled]);
  useEffect(() => {
    const nextThreadId = freshAssistantThreadId({
      startFresh,
      currentThreadId: threadId,
      latestThreadId: threads?.[0]?._id ?? null,
      acceptedPreviousThreadId: acceptedAttempt?.previousThreadId,
    });
    if (nextThreadId) onThreadChange(nextThreadId);
  }, [
    acceptedAttempt?.previousThreadId,
    onThreadChange,
    startFresh,
    threadId,
    threads,
  ]);

  const send = async (value = draft) => {
    const text = value.trim();
    if (!text || busy || limitReached || blocked || !desktopAssistant) return;
    let previousUserMessageId: Id<"assistantMessages"> | null = null;
    for (let index = (messages?.length ?? 0) - 1; index >= 0; index -= 1) {
      const message = messages?.[index];
      if (message?.role === "user") {
        previousUserMessageId = message._id;
        break;
      }
    }
    const previousThreadId = threadId ?? threads?.[0]?._id ?? null;
    setSending(true);
    try {
      const result = await desktopAssistant.send(
        text,
        Intl.DateTimeFormat().resolvedOptions().timeZone,
      );
      const error = assistantSendError(result);
      if (error) throw new Error(error);
      setDraft("");
      if (result.kind === "accepted") {
        setAcceptedAttempt({
          attemptId: result.attemptId,
          text,
          previousUserMessageId,
          previousThreadId,
        });
      }
    } catch {
      // The renderer deliberately does not surface native/provider error text.
      // Typed readiness stays actionable above the composer and the draft remains.
      notify({ kind: "assistant-reply-failed" });
      requestAnimationFrame(() => inputRef.current?.focus());
    } finally {
      setSending(false);
    }
  };

  const stop = async () => {
    if (!acceptedAttempt || !desktopAssistant) return;
    try {
      await desktopAssistant.cancel(acceptedAttempt.attemptId);
    } catch {
      notify({ kind: "assistant-reply-failed" });
    }
  };
  const remediate = async (action: ReturnType<typeof assistantRemediation>) => {
    try {
      if (action === "sign-in") {
        openedLoginChallengeRef.current = null;
        await desktopSession?.login();
        const loginSnapshot = desktopSession?.getSnapshot();
        if (
          desktopSession &&
          loginSnapshot?.attemptId &&
          loginSnapshot.challenge
        ) {
          openedLoginChallengeRef.current = `${loginSnapshot.attemptId}:${loginSnapshot.challenge.url}:${loginSnapshot.challenge.code}`;
          await desktopSession.openChallenge();
        }
      }
      else if (action === "choose-installation")
        await desktopAssistant?.chooseCodexInstallation();
      else if (action === "reprobe" || action === "retry")
        await desktopSession?.refreshStatus();
    } catch {
      notify({ kind: "assistant-sign-in-failed" });
    }
  };
  const newChat = () => {
    if (busy) return;
    if (draft.trim()) {
      setConfirmNewChatOpen(true);
      return;
    }
    confirmNewChat();
  };
  const confirmNewChat = () => {
    setDraft("");
    setConfirmNewChatOpen(false);
    onNewChat();
    requestAnimationFrame(() => inputRef.current?.focus());
  };
  const empty =
    !messages?.length && !threadId && (startFresh || threads?.length === 0);

  return (
    <>
      <AssistantShell
        onClose={onClose}
        onNewChat={newChat}
        newChatDisabled={busy}
      >
        <div className="flex min-h-0 flex-1 flex-col gap-3 pt-3">
          <AssistantReadiness
            status={effectiveStatus}
            onRemediate={(action) => void remediate(action)}
          />
          {empty ? (
            <div className="flex min-h-0 flex-1 flex-col justify-end gap-1.5">
              {SUGGESTIONS.map((suggestion) => (
                <Button
                  key={suggestion}
                  type="button"
                  variant="quiet"
                  disabled={blocked || limitReached}
                  onClick={() => void send(suggestion)}
                  className="h-auto justify-start px-3 py-2 text-left text-sm font-normal text-muted-foreground hover:text-foreground"
                >
                  {suggestion}
                </Button>
              ))}
            </div>
          ) : (
            <AssistantTimeline
              messages={messages}
              actionsById={actionsById}
              onSend={(text) => void send(text)}
              busy={busy}
            />
          )}
          {limitReached && (
            <p role="status" className="text-xs text-muted-foreground">
              You’ve used all {quota?.limit} messages this month.
            </p>
          )}
          <AssistantComposer
            draft={draft}
            disabled={blocked || limitReached}
            busy={busy}
            onDraftChange={setDraft}
            onSend={() => void send()}
            onStop={() => void stop()}
            inputRef={inputRef}
          />
        </div>
      </AssistantShell>
      <ConfirmationDialog
        open={confirmNewChatOpen}
        onOpenChange={setConfirmNewChatOpen}
        eyebrow="Assistant"
        title="Start a new chat?"
        description="Your unsent draft will be cleared. The current conversation remains available until Qali cleans up inactive threads."
        confirmLabel="Start new chat"
        onConfirm={confirmNewChat}
      />
    </>
  );
}

function readDraft() {
  if (typeof sessionStorage === "undefined") return "";
  return sessionStorage.getItem(DRAFT_STORAGE_KEY) ?? "";
}
