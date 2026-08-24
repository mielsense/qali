import { ChromaLoader } from "@qali/ui/components/chroma-loader";
import { ConvexProviderWithAuth, ConvexReactClient } from "convex/react";
import {
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import type { DesktopBootstrap } from "@qali/desktop-contracts";

import type { DesktopRendererApi } from "./api";
import { DesktopStatusProvider } from "./status";

type SessionSnapshot = Readonly<{
  bootstrap: DesktopBootstrap | null;
  isAuthenticated: boolean;
  isLoading: boolean;
}>;

type DesktopAccessTokenFetcher = (options: {
  forceRefreshToken: boolean;
}) => Promise<string | null>;

type DesktopSessionOptions = Readonly<{
  schedule?(
    delayMs: number,
    task: () => Promise<void>,
  ): () => void;
}>;

export type DesktopSession = Readonly<{
  bootstrap(): Promise<DesktopBootstrap>;
  dispose(): void;
  fetchAccessToken: DesktopAccessTokenFetcher;
  getAuthFetcher(): DesktopAccessTokenFetcher;
  getSnapshot(): SessionSnapshot;
  subscribe(listener: () => void): () => void;
}>;

const RECOVERY_BASE_DELAY_MS = 1_000;
const RECOVERY_MAX_DELAY_MS = 30_000;

export function createDesktopSession(
  api: DesktopRendererApi,
  options: DesktopSessionOptions = {},
): DesktopSession {
  let current: DesktopBootstrap | null = null;
  let pending: Promise<DesktopBootstrap> | null = null;
  let recoveryAttempt = 0;
  let recoveryCancel: (() => void) | null = null;
  let lifecycleGeneration = 0;
  let disposed = false;
  let snapshot: SessionSnapshot = Object.freeze({
    bootstrap: null,
    isAuthenticated: false,
    isLoading: true,
  });
  const listeners = new Set<() => void>();
  const schedule =
    options.schedule ??
    ((delayMs: number, task: () => Promise<void>) => {
      const timer = setTimeout(() => {
        void task();
      }, delayMs);
      return () => clearTimeout(timer);
    });

  const isActive = (generation: number) =>
    !disposed && generation === lifecycleGeneration;
  const disposedError = new Error("Desktop session is disposed");

  const publish = (
    next: SessionSnapshot,
    generation = lifecycleGeneration,
  ) => {
    if (!isActive(generation)) return;
    snapshot = Object.freeze(next);
    for (const listener of listeners) listener();
  };

  const requestBootstrap = async (attempts: number, generation: number) => {
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (!isActive(generation)) throw disposedError;
      try {
        const value = await api.bootstrap();
        if (!isActive(generation)) throw disposedError;
        return value;
      } catch (error) {
        if (!isActive(generation)) throw disposedError;
        lastError = error;
      }
    }
    throw lastError;
  };

  const cancelRecovery = () => {
    recoveryCancel?.();
    recoveryCancel = null;
    recoveryAttempt = 0;
  };

  let authFetcher: DesktopAccessTokenFetcher;

  const scheduleRecovery = () => {
    if (disposed || recoveryCancel !== null || current === null) return;
    const generation = lifecycleGeneration;
    const delayMs = Math.min(
      RECOVERY_BASE_DELAY_MS * 2 ** Math.min(recoveryAttempt, 5),
      RECOVERY_MAX_DELAY_MS,
    );
    recoveryCancel = schedule(delayMs, async () => {
      recoveryCancel = null;
      if (generation !== lifecycleGeneration || current === null) return;
      try {
        const value = await requestBootstrap(1, generation);
        if (!isActive(generation)) return;
        recoveryAttempt = 0;
        current = value;
        authFetcher = (authOptions) => fetchAccessToken(authOptions);
        publish(
          { bootstrap: value, isAuthenticated: true, isLoading: false },
          generation,
        );
      } catch {
        if (!isActive(generation)) return;
        recoveryAttempt += 1;
        scheduleRecovery();
      }
    });
  };

  const load = async (forceRefreshToken: boolean): Promise<DesktopBootstrap> => {
    const generation = lifecycleGeneration;
    if (!isActive(generation)) throw disposedError;
    if (!forceRefreshToken && current !== null) return current;
    if (!forceRefreshToken && pending !== null) return pending;

    if (current === null) publish({ ...snapshot, isLoading: true }, generation);
    const attempts = forceRefreshToken ? 2 : 1;
    const request = requestBootstrap(attempts, generation);
    if (!forceRefreshToken) pending = request;
    try {
      const value = await request;
      if (!isActive(generation)) throw disposedError;
      cancelRecovery();
      current = value;
      publish(
        { bootstrap: value, isAuthenticated: true, isLoading: false },
        generation,
      );
      return value;
    } catch (error) {
      if (isActive(generation) && current === null) {
        publish(
          { bootstrap: null, isAuthenticated: false, isLoading: false },
          generation,
        );
      }
      throw error;
    } finally {
      if (isActive(generation) && pending === request) pending = null;
    }
  };

  const fetchAccessToken: DesktopAccessTokenFetcher = async ({
    forceRefreshToken,
  }) => {
    const generation = lifecycleGeneration;
    if (!isActive(generation)) return null;
    try {
      const value = await load(forceRefreshToken);
      return isActive(generation) ? value.rendererAuthToken : null;
    } catch {
      if (isActive(generation) && current !== null && forceRefreshToken) {
        scheduleRecovery();
      }
      return null;
    }
  };
  authFetcher = fetchAccessToken;

  return Object.freeze({
    bootstrap: () => load(false),
    dispose() {
      if (disposed) return;
      disposed = true;
      lifecycleGeneration += 1;
      cancelRecovery();
    },
    fetchAccessToken,
    getAuthFetcher: () => authFetcher,
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
}

function createUseDesktopAuth(session: DesktopSession) {
  return function useDesktopAuth() {
    const snapshot = useSyncExternalStore(
      session.subscribe,
      session.getSnapshot,
      session.getSnapshot,
    );
    const fetchAccessToken = session.getAuthFetcher();
    return useMemo(
      () => ({
        isLoading: snapshot.isLoading,
        isAuthenticated: snapshot.isAuthenticated,
        fetchAccessToken,
      }),
      [snapshot.isLoading, snapshot.isAuthenticated, fetchAccessToken],
    );
  };
}

function ReadyDesktopProvider({
  api,
  bootstrap,
  children,
  session,
}: {
  api: DesktopRendererApi;
  bootstrap: DesktopBootstrap;
  children: ReactNode;
  session: DesktopSession;
}) {
  const client = useMemo(
    () => new ConvexReactClient(bootstrap.convexUrl),
    [bootstrap.convexUrl],
  );
  const useDesktopAuth = useMemo(() => createUseDesktopAuth(session), [session]);

  return (
    <DesktopStatusProvider api={api} initial={bootstrap}>
      <ConvexProviderWithAuth client={client} useAuth={useDesktopAuth}>
        {children}
      </ConvexProviderWithAuth>
    </DesktopStatusProvider>
  );
}

export function DesktopRendererProvider({
  api,
  children,
}: {
  api: DesktopRendererApi;
  children: ReactNode;
}) {
  const [session] = useState(() => createDesktopSession(api));
  const snapshot = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    session.getSnapshot,
  );

  useEffect(() => {
    void session.bootstrap().catch(() => {
      // Main owns startup recovery. Remaining on the branded loader prevents
      // malformed bootstrap data from falling through to hosted auth.
    });
    return () => session.dispose();
  }, [session]);

  if (snapshot.bootstrap === null) return <ChromaLoader />;
  return (
    <ReadyDesktopProvider
      api={api}
      bootstrap={snapshot.bootstrap}
      session={session}
    >
      {children}
    </ReadyDesktopProvider>
  );
}
