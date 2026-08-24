import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

import type {
  AssistantProviderStatus,
  DesktopBootstrap,
  GoogleAccountId,
  GoogleAccountsSnapshot,
  GoogleAddAccountResult,
  GoogleReconnectAccountResult,
} from "@qali/desktop-contracts";

import type { DesktopRendererApi } from "./api";

export type QaliUser = Readonly<{
  email?: string;
  image?: string | null;
  name?: string;
}>;

export type DesktopStatus = Readonly<{
  assistant: AssistantProviderStatus;
  addGoogleAccount(): Promise<GoogleAddAccountResult>;
  reconnectGoogleAccount(
    accountId: GoogleAccountId,
  ): Promise<GoogleReconnectAccountResult>;
  disconnectGoogleAccount(
    accountId: GoogleAccountId,
  ): Promise<GoogleAccountsSnapshot>;
  google: GoogleAccountsSnapshot;
  syncGoogleAccount(
    accountId: GoogleAccountId,
  ): Promise<GoogleAccountsSnapshot>;
  syncAllGoogleAccounts(): Promise<GoogleAccountsSnapshot>;
  clearLegacyGoogleCredentials(): Promise<GoogleAccountsSnapshot>;
}>;

const DesktopStatusContext = createContext<DesktopStatus | null>(null);
const QaliUserContext = createContext<QaliUser | null>(null);

export function HostedUserProvider({
  children,
  user,
}: {
  children: ReactNode;
  user: QaliUser | null;
}) {
  return createElement(QaliUserContext.Provider, { value: user }, children);
}

export function DesktopStatusProvider({
  api,
  children,
  initial,
}: {
  api: DesktopRendererApi;
  children: ReactNode;
  initial: DesktopBootstrap;
}) {
  const [google, setGoogle] = useState(initial.google);
  const [assistant, setAssistant] = useState(initial.assistant);

  useEffect(
    () =>
      api.subscribe((event) => {
        if (event.type === "google-status") setGoogle(event.status);
        if (event.type === "assistant-status") setAssistant(event.status);
      }),
    [api],
  );

  const addGoogleAccount = useCallback(async () => {
    const result = await api.addGoogleAccount();
    setGoogle(result.snapshot);
    return result;
  }, [api]);
  const reconnectGoogleAccount = useCallback(
    async (accountId: GoogleAccountId) => {
      const result = await api.reconnectGoogleAccount(accountId);
      setGoogle(result.snapshot);
      return result;
    },
    [api],
  );
  const disconnectGoogleAccount = useCallback(
    async (accountId: GoogleAccountId) => {
      const snapshot = await api.disconnectGoogleAccount(accountId);
      setGoogle(snapshot);
      return snapshot;
    },
    [api],
  );
  const syncGoogleAccount = useCallback(
    async (accountId: GoogleAccountId) => {
      const snapshot = await api.syncGoogleAccount(accountId);
      setGoogle(snapshot);
      return snapshot;
    },
    [api],
  );
  const syncAllGoogleAccounts = useCallback(async () => {
    const snapshot = await api.syncAllGoogleAccounts();
    setGoogle(snapshot);
    return snapshot;
  }, [api]);
  const clearLegacyGoogleCredentials = useCallback(async () => {
    const snapshot = await api.clearLegacyGoogleCredentials();
    setGoogle(snapshot);
    return snapshot;
  }, [api]);
  const value: DesktopStatus = {
    assistant,
    addGoogleAccount,
    reconnectGoogleAccount,
    disconnectGoogleAccount,
    google,
    syncGoogleAccount,
    syncAllGoogleAccounts,
    clearLegacyGoogleCredentials,
  };

  return createElement(
    QaliUserContext.Provider,
    { value: null },
    createElement(DesktopStatusContext.Provider, { value }, children),
  );
}

export function useDesktopStatus(): DesktopStatus | null {
  return useContext(DesktopStatusContext);
}

export function useQaliUser(): QaliUser | null {
  return useContext(QaliUserContext);
}
