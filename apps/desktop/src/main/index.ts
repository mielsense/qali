import {
  assistantAttemptIdSchema,
  assistantLoginAttemptIdSchema,
  BRIDGE_VERSION,
  type GoogleAccountStatus,
  type GoogleAccountsSnapshot,
} from "@qali/desktop-contracts";
import { desktopStatusEventSchema } from "@qali/desktop-contracts/schemas";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  net,
  protocol,
  shell,
} from "electron";
import electronUpdater from "electron-updater";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync as originalReadFileSync } from "original-fs";

import {
  localAuthIssuerForChannel,
  startLocalAuthIssuer,
  type LocalAuthIssuer,
} from "./auth/issuer";
import {
  createConvexLifecycleDriver,
  invalidateBuildMarker,
} from "./convex/bootstrap";
import { ConvexCalendarBrokerClient } from "./convex/broker-client";
import { ConvexSupervisor } from "./convex/supervisor";
import { createApplicationCalendarReader } from "./codex/calendar-reader";
import {
  AssistantCoordinator,
  createProductionCodexPhaseRunner,
} from "./codex/coordinator";
import {
  createCodexAppServerHost,
  createCodexAppServerHostPhaseRunner,
  createCodexInstallationSelection,
  createContainedCodexAppServerClient,
} from "./codex/app-server-provider";
import {
  resolveCodexInstallation,
  type CodexInstallationEvidence,
} from "./codex/app-server-compatibility";
import { createCodexRuntimeAuthority } from "./codex/boundary";
import { startEgressProxy } from "./codex/egress-proxy";
import { loadCodexManifest } from "./codex/manifest";
import {
  createCodexLoginEventChannel,
  subscribeCodexLoginEvents,
} from "./codex/events";
import {
  isAllowedAssistantLoginUrl,
  registerExternalProductLinks,
} from "./external-links";
import {
  createAppIdentity,
  selectAppChannel,
  type AppIdentity,
} from "./identity";
import { qaliDockIconPath, refreshMacDockIcon } from "./dock-icon";
import {
  type DesktopStartupStage,
  recordStartupFailure,
} from "./diagnostics/startup-failure";
import {
  createAssistantIpcHandlers,
  createAssistantLoginChallengeRegistry,
  createCodexLoginEventForwarder,
  createCodexInstallationChooser,
  createDesktopIpcHandlers,
  createGoogleSyncIpcHandlers,
  createRecoveryIpcHandlers,
  createRendererIpcRegistry,
  createSettingsIpcHandlers,
  registerDesktopIpc,
  subscribeSettingsChanges,
} from "./ipc/router";
import { resolveQaliPaths } from "./paths";
import {
  beginOwnedSpawnObservation,
  finishOwnedSpawnObservation,
} from "./processes/owned-spawn-observer";
import { loadPackagedSmokeAuthority } from "./packaged-smoke-authority";
import { runPackagedSmokeScenario } from "./packaged-smoke-scenario";
import { KeychainStore } from "./keychain/keychain";
import { GoogleCalendarClient } from "./google/calendar-client";
import { loadPackagedGoogleClient } from "./google/oauth-client-config";
import { GoogleOAuthBroker } from "./google/oauth-broker";
import { verifyGoogleAccounts } from "./google/account-reconciliation";
import { GoogleSyncSupervisor } from "./google/sync-supervisor";
import {
  GoogleSyncWorker,
  shutdownSyncBeforeBackend,
} from "./google/sync-worker";
import { RENDERER_SCHEME, registerRendererProtocol } from "./protocol";
import { acquireWriterLock } from "./single-instance";
import { openSettingsStore, type SettingsStore } from "./settings/store";
import { createMainWindow } from "./window";
import {
  completeUpdateAwareShutdown,
  createDesktopUpdateCoordinator,
  type DesktopUpdateCoordinator,
} from "./updates/coordinator";
import {
  desktopUpdatesEnabled,
  loadDesktopUpdatePolicy,
} from "./updates/policy";
import { exportLocalData } from "./recovery/export";
import {
  createGoogleIpcDrainStep,
  createOwnedResourceDrain,
  RecoveryLifecycle,
} from "./recovery/lifecycle";
import { resetLocalData } from "./recovery/reset";
import {
  createRecoveryAuthority,
  finalizePendingRestore,
  listRecoveryBackups,
  recoverInterruptedRestore,
  rollbackPendingRestore,
  restoreLocalBackup,
  type RecoveryAuthority,
} from "./recovery/restore";

// electron-updater ships CommonJS, so the ESM main bundle can only reach
// autoUpdater through the default export.
const { autoUpdater } = electronUpdater;

const packagedSmokeAuthorityPath = join(
  process.resourcesPath,
  "packaged-smoke-authority.json",
);
const packagedSmokeBuildIdentityPath = join(
  process.resourcesPath,
  "packaged-smoke-build-identity.json",
);
let packagedSmoke: Awaited<ReturnType<typeof loadPackagedSmokeAuthority>> =
  null;
if (app.isPackaged && existsSync(packagedSmokeAuthorityPath)) {
  packagedSmoke = await loadPackagedSmokeAuthority({
    applicationAsarSha256: createHash("sha256")
      .update(originalReadFileSync(join(process.resourcesPath, "app.asar")))
      .digest("hex"),
    isPackaged: app.isPackaged,
    readAuthority: () => readFileSync(packagedSmokeAuthorityPath, "utf8"),
    readBuildIdentity: () =>
      readFileSync(packagedSmokeBuildIdentityPath, "utf8"),
    repositoryRoot: process.resourcesPath,
  });
}
const appChannel = packagedSmoke?.channel ?? selectAppChannel(app.isPackaged);
const identity = createAppIdentity(
  appChannel,
  packagedSmoke?.appData ?? app.getPath("appData"),
) as AppIdentity;
const paths = resolveQaliPaths(identity);
app.setName(identity.name);
async function recordPackagedSmokeStage(stage: string): Promise<void> {
  if (!packagedSmoke) return;
  await writeFile(
    join(packagedSmoke.root, "packaged-smoke-stage.json"),
    `${JSON.stringify({ formatVersion: 1, phase: packagedSmoke.phase, stage })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}
await recordPackagedSmokeStage("authority-accepted");
if (packagedSmoke) beginOwnedSpawnObservation();
const hasWriterLock = acquireWriterLock(paths, app, () =>
  BrowserWindow.getAllWindows(),
);

protocol.registerSchemesAsPrivileged([
  {
    scheme: RENDERER_SCHEME,
    privileges: {
      secure: true,
      standard: true,
      supportFetchAPI: true,
    },
  },
]);

const RENDERER_ROOT = fileURLToPath(new URL("../renderer/", import.meta.url));
const convexPort = {
  stable: 3210,
  development: 3310,
  test: 3410,
}[appChannel];
const CONVEX_LOOPBACK_ORIGINS = [
  `http://127.0.0.1:${convexPort}`,
  `ws://127.0.0.1:${convexPort}`,
] as const;
const rendererRegistry = createRendererIpcRegistry();
const RECOVERY_BUILD_MARKER = "qali-local-calendar-v1";
let convexSupervisor: ConvexSupervisor | null = null;
let localAuthIssuer: LocalAuthIssuer | null = null;
let googleSyncSupervisor: GoogleSyncSupervisor | null = null;
let disposeGoogleIpcHandlers: (() => Promise<void>) | null = null;
let revokeGoogleIpcHandlers: (() => void) | null = null;
let stopAssistantLoginEvents: (() => void) | null = null;
let stopSettingsStatusEvents: (() => void) | null = null;
let settingsStore: SettingsStore | null = null;
let recoveryLifecycle: RecoveryLifecycle | null = null;
let desktopUpdateCoordinator: DesktopUpdateCoordinator | null = null;
let shutdownStarted = false;
let shutdownFinished = false;
let packagedSmokeCodexSpawnAttempts = 0;
let packagedSmokeGoogleNetworkAttempts = 0;

function finishDesktopShutdown(): void {
  const coordinator = desktopUpdateCoordinator;
  desktopUpdateCoordinator = null;
  completeUpdateAwareShutdown({
    coordinator,
    quit: () => app.quit(),
  });
}

function syncStateForStatus(
  status: ReturnType<GoogleSyncSupervisor["statuses"]>[string] | undefined,
): "idle" | "syncing" | "offline" | "error" {
  if (!status || status.kind === "idle") return "idle";
  if (status.kind === "pending" || status.kind === "syncing") {
    return "syncing";
  }
  if (status.kind === "offline" || status.kind === "rate-limit") {
    return "offline";
  }
  return "error";
}

function desktopResourcesRoot(): string {
  return app.isPackaged
    ? process.resourcesPath
    : resolve(app.getAppPath(), "resources");
}

function backendProjectRoot(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "convex-backend-project")
    : resolve(app.getAppPath(), "../../packages/backend");
}

if (!hasWriterLock) {
  app.quit();
} else {
  void app.whenReady().then(async () => {
    refreshMacDockIcon({
      dock: app.dock,
      iconPath: qaliDockIconPath({
        appPath: app.getAppPath(),
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
      }),
      platform: process.platform,
    });
    let startupRecoveryAuthority: RecoveryAuthority | null = null;
    let verifiedRestorePendingHealth = false;
    let lastConvexProgress = "not-created";
    let desktopStartupStage: DesktopStartupStage = "not-created";
    try {
      await recordPackagedSmokeStage("startup-entered");
      desktopStartupStage = "settings";
      const keychain = new KeychainStore(identity, {
        appPath: app.getAppPath(),
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
      });
      const activeSettingsStore = await openSettingsStore({
        configRoot: paths.config,
        systemTimeZone:
          Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      });
      settingsStore = activeSettingsStore;
      desktopStartupStage = "recovery";
      const recoveryAuthority = await createRecoveryAuthority({
        appData: identity.appData,
        namespace: identity.namespace,
        root: paths.root,
        database: paths.database,
        backups: paths.backups,
      });
      startupRecoveryAuthority = recoveryAuthority;
      verifiedRestorePendingHealth =
        (await recoverInterruptedRestore(recoveryAuthority)).kind ===
        "verified-pending";
      desktopStartupStage = "auth";
      const issuerUrl = new URL(localAuthIssuerForChannel(appChannel));
      localAuthIssuer = await startLocalAuthIssuer({
        hostname: "127.0.0.1",
        port: Number(issuerUrl.port),
        keychain,
      });
      await recordPackagedSmokeStage("auth-ready");
      desktopStartupStage = "convex";
      convexSupervisor = new ConvexSupervisor(
        createConvexLifecycleDriver({
          identity,
          paths,
          resourcesRoot: desktopResourcesRoot(),
          backendProjectDirectory: backendProjectRoot(),
          electronExecutable: process.execPath,
          nodeModulesPath: join(app.getAppPath(), "node_modules"),
          requirePackagedResourceManifest: app.isPackaged,
          keychain,
        }),
      );
      convexSupervisor.onState((state) => {
        if (
          state !== "blocked" &&
          state !== "draining" &&
          state !== "stopped"
        ) {
          lastConvexProgress = state;
        }
      });
      const healthyConvex = await convexSupervisor.start();
      await recordPackagedSmokeStage("convex-ready");
      const calendarBroker = new ConvexCalendarBrokerClient({
        deploymentUrl: healthyConvex.deploymentUrl,
        tokenProvider:
          localAuthIssuer.authority.createDesktopBrokerTokenProvider(),
      });
      const observeGoogleFetch: typeof fetch | undefined = packagedSmoke
        ? async () => {
            packagedSmokeGoogleNetworkAttempts += 1;
            throw new Error("PACKAGED_SMOKE_GOOGLE_NETWORK_BLOCKED");
          }
        : undefined;
      const googleOAuth = new GoogleOAuthBroker({
        client: loadPackagedGoogleClient(
          join(desktopResourcesRoot(), "google-oauth-client.json"),
        ),
        keychain,
        ...(observeGoogleFetch ? { fetch: observeGoogleFetch } : {}),
        openExternal: (url) => shell.openExternal(url),
        pendingOperationCount: (accountId) =>
          calendarBroker.pendingOperationCount(accountId),
        confirmDisconnect: async (pendingOperationCount) => {
          const result = await dialog.showMessageBox({
            type: "warning",
            buttons: ["Keep connected", "Disconnect"],
            defaultId: 0,
            cancelId: 0,
            message: "Unsynchronized calendar changes are still queued",
            detail: `${pendingOperationCount} calendar change${pendingOperationCount === 1 ? "" : "s"} will remain only on this Mac until Google is connected again.`,
          });
          return result.response === 1;
        },
        stopSynchronization: async (accountId) => {
          await googleSyncSupervisor?.drain(accountId);
        },
      });
      const googleClient = new GoogleCalendarClient(
        observeGoogleFetch ? { fetch: observeGoogleFetch } : {},
      );
      const readyGoogleAccountIds = new Set<string>();
      let googleSupervisorStarted = false;
      googleSyncSupervisor = new GoogleSyncSupervisor({
        listAccountIds: async () => [...readyGoogleAccountIds],
        createWorker: (accountId, cycleGate) =>
          new GoogleSyncWorker({
            accountId,
            broker: calendarBroker.forAccount(accountId),
            cycleGate,
            google: googleClient,
            oauth: {
              accessToken: () => googleOAuth.accessToken(accountId),
              status: () => googleOAuth.status(accountId),
            },
          }),
      });
      const activeGoogleSyncSupervisor = googleSyncSupervisor;
      const reconcileGoogleAccounts = async (
        onProgress?: Parameters<typeof verifyGoogleAccounts>[2],
      ): Promise<void> => {
        const identities =
          (await googleOAuth.requiresLegacyCredentialRecovery())
            ? []
            : await googleOAuth.listAccountIdentities();
        await verifyGoogleAccounts(calendarBroker, identities, onProgress);
        const verifiedAccountIds = new Set(
          identities.map((account) => account.accountId),
        );
        readyGoogleAccountIds.clear();
        for (const accountId of verifiedAccountIds) {
          readyGoogleAccountIds.add(accountId);
        }
        if (googleSupervisorStarted) {
          await activeGoogleSyncSupervisor.refreshAccounts();
        }
      };
      const googleSnapshot = async (): Promise<GoogleAccountsSnapshot> => {
        try {
          if (await googleOAuth.requiresLegacyCredentialRecovery()) {
            return {
              kind: "unavailable",
              message:
                "Old Google authorization needs to be cleared before connecting.",
              recoveryAction: "clear-legacy-credentials",
              recoveryRequired: "legacy-credentials",
            };
          }
          const accounts = await googleOAuth.listAccounts();
          const workerStatuses = activeGoogleSyncSupervisor.statuses();
          const statuses: GoogleAccountStatus[] = [];
          for (const account of accounts) {
            const oauthStatus = await googleOAuth.status(account.accountId);
            if (oauthStatus.kind === "unavailable") {
              return {
                kind: "unavailable",
                ...(oauthStatus.message
                  ? { message: oauthStatus.message }
                  : {}),
              };
            }
            if (oauthStatus.kind === "disconnected") {
              return {
                kind: "unavailable",
                message: "Google account credentials changed unexpectedly",
              };
            }
            if (oauthStatus.kind === "reconnect-required") {
              statuses.push({
                accountEmail: account.accountEmail,
                accountId: account.accountId,
                reason: oauthStatus.reason,
                state: "reconnect-required",
              });
              continue;
            }
            const workerStatus = workerStatuses[account.accountId];
            if (workerStatus?.kind === "authentication-required") {
              statuses.push({
                accountEmail: account.accountEmail,
                accountId: account.accountId,
                reason: "authentication-expired",
                state: "reconnect-required",
              });
              continue;
            }
            statuses.push({
              accountEmail: account.accountEmail,
              accountId: account.accountId,
              state: "connected",
              syncState: syncStateForStatus(workerStatus),
            });
          }
          return {
            accounts: statuses,
            kind: "ready",
            oauthBusy: googleOAuth.isBusy(),
          };
        } catch {
          return {
            kind: "unavailable",
            message: "Google accounts are unavailable",
          };
        }
      };
      desktopStartupStage = "google-accounts";
      await reconcileGoogleAccounts((stage) => {
        desktopStartupStage = stage;
      });
      desktopStartupStage = "migration";
      await convexSupervisor.completeMigration();
      await recordPackagedSmokeStage("migration-ready");
      desktopStartupStage = "restore-finalization";
      await finalizePendingRestore(recoveryAuthority);
      verifiedRestorePendingHealth = false;
      if (!packagedSmoke) {
        desktopStartupStage = "google-worker";
        googleSupervisorStarted = true;
        await activeGoogleSyncSupervisor.start();
        activeGoogleSyncSupervisor.monitorOnline({
          isOnline: () => net.isOnline(),
        });
      }
      desktopStartupStage = "renderer-protocol";
      await registerRendererProtocol(
        protocol,
        RENDERER_ROOT,
        CONVEX_LOOPBACK_ORIGINS,
      );
      registerExternalProductLinks(
        ipcMain,
        rendererRegistry,
        shell.openExternal,
      );
      const broadcastDesktopEvent = (value: unknown) => {
        const event = desktopStatusEventSchema.parse(value);
        for (const window of BrowserWindow.getAllWindows()) {
          if (!window.isDestroyed())
            window.webContents.send("desktop:status", event);
        }
      };
      desktopStartupStage = "update-policy";
      const updatePolicy = await loadDesktopUpdatePolicy(
        join(desktopResourcesRoot(), "update-policy.json"),
      );
      const updatesEnabled = desktopUpdatesEnabled({
        isPackaged: app.isPackaged,
        packagedSmoke: packagedSmoke !== null,
        platform: process.platform,
        policy: updatePolicy,
      });
      const disabledUpdateReason = !app.isPackaged
        ? "development"
        : packagedSmoke
          ? "packaged-smoke"
          : "release-policy";
      desktopUpdateCoordinator = createDesktopUpdateCoordinator({
        currentVersion: app.getVersion(),
        disabledReason: disabledUpdateReason,
        enabled: updatesEnabled,
        publish: (status) => {
          broadcastDesktopEvent({ type: "update-status", status });
        },
        requestQuit: () => app.quit(),
        updater: autoUpdater,
      });
      desktopStartupStage = "desktop-handlers";
      const googleHandlers = createGoogleSyncIpcHandlers(
        googleOAuth,
        activeGoogleSyncSupervisor,
        {
          getSnapshot: googleSnapshot,
          publish: (snapshot) => {
            broadcastDesktopEvent({ type: "google-status", status: snapshot });
          },
          reconcileAccounts: reconcileGoogleAccounts,
          subscribeStatus: (listener) =>
            activeGoogleSyncSupervisor.onStatus(listener),
        },
      );
      stopSettingsStatusEvents = subscribeSettingsChanges(
        activeSettingsStore,
        broadcastDesktopEvent,
      );
      const loginEvents = createCodexLoginEventChannel();
      const loginChallenges = createAssistantLoginChallengeRegistry();
      stopAssistantLoginEvents = subscribeCodexLoginEvents(
        loginEvents,
        createCodexLoginEventForwarder({
          challenges: loginChallenges,
          broadcast: broadcastDesktopEvent,
        }),
      );
      // The production assistant owns one retained, contained App Server
      // generation. The old phase runners remain only as fail-closed packaged
      // smoke artifacts until the later removal gate.
      desktopStartupStage = "assistant";
      const codexIntegration = packagedSmoke
        ? null
        : await (async () => {
            let sessionRoot: string | null = null;
            let proxy: Awaited<ReturnType<typeof startEgressProxy>> | null =
              null;
            try {
              const resourceRoot = desktopResourcesRoot();
              const manifest = await loadCodexManifest(
                join(resourceRoot, "codex-provider-manifest.json"),
              );
              sessionRoot = await mkdtemp(
                join(paths.runtime, "codex-app-server-"),
              );
              // Keep one Qali-owned Codex home stable so the App Server's
              // Keychain record has a stable identity across launches. The
              // working directory remains disposable and empty on every run.
              const codexHome = paths.codexHome;
              const workRoot = join(sessionRoot, "work");
              await mkdir(workRoot, { mode: 0o700 });
              proxy = await startEgressProxy({
                allowedHosts: manifest.proxy.allowedHosts,
                allowedPorts: manifest.proxy.allowedPorts,
                expectedPolicySha256: manifest.proxy.policySha256,
              });
              const runtimeAuthority = await createCodexRuntimeAuthority({
                codexHome,
                cwd: workRoot,
                proxy,
                keyringHealthProbe: async () => false,
                loginEvents,
              });
              let selectedPath:
                CodexInstallationEvidence["executablePath"] | null = null;
              const host = createCodexAppServerHost({
                resolveInstallation: async () =>
                  resolveCodexInstallation({
                    manifest,
                    ...(selectedPath ? { selectedPath } : {}),
                  }),
                createClient: (evidence) =>
                  createContainedCodexAppServerClient(
                    runtimeAuthority,
                    evidence,
                  ),
                probeReadiness: async () => ({ kind: "ready-degraded" }),
                async waitForLoginCompletion(client, { signal }) {
                  const deadline = Date.now() + 15 * 60 * 1_000;
                  while (Date.now() < deadline) {
                    if (signal.aborted) {
                      throw Object.assign(new Error("cancelled"), {
                        code: "CODEX_CANCELLED",
                      });
                    }
                    const account = await client.accountRead();
                    if (account.account?.type === "chatgpt") return;
                    await new Promise<void>((resolve, reject) => {
                      let timer: ReturnType<typeof setTimeout>;
                      const onAbort = () => {
                        clearTimeout(timer);
                        reject(
                          Object.assign(new Error("cancelled"), {
                            code: "CODEX_CANCELLED",
                          }),
                        );
                      };
                      timer = setTimeout(() => {
                        signal.removeEventListener("abort", onAbort);
                        resolve();
                      }, 1_000);
                      signal.addEventListener("abort", onAbort, {
                        once: true,
                      });
                      if (signal.aborted) onAbort();
                    });
                  }
                  throw Object.assign(new Error("login timed out"), {
                    code: "CODEX_LOGIN_TIMEOUT",
                  });
                },
                loginEvents,
                workRoot,
              });
              const selection = createCodexInstallationSelection({
                manifest,
                async onSelected(evidence) {
                  selectedPath = evidence.executablePath;
                  const status = await host.status();
                  return status.kind === "offline"
                    ? { kind: "unavailable" }
                    : status;
                },
              });
              let closePromise: Promise<void> | null = null;
              const runtime = Object.freeze({
                status: () => host.status(),
                login: (attemptId: string, signal: AbortSignal) =>
                  host.login(
                    assistantLoginAttemptIdSchema.parse(attemptId),
                    signal,
                  ),
                cancel: (attemptId: string) =>
                  host.cancel(assistantAttemptIdSchema.parse(attemptId)),
                close() {
                  if (closePromise) return closePromise;
                  closePromise = (async () => {
                    try {
                      await host.close();
                    } finally {
                      await proxy!.close();
                      await rm(sessionRoot!, { force: true, recursive: true });
                    }
                  })();
                  return closePromise;
                },
              });
              return {
                runtime,
                phaseRunner: createCodexAppServerHostPhaseRunner(host, {
                  planner: JSON.parse(
                    await readFile(
                      join(resourceRoot, "codex-planner-output.schema.json"),
                      "utf8",
                    ),
                  ) as unknown,
                  finalizer: JSON.parse(
                    await readFile(
                      join(resourceRoot, "codex-finalizer-output.schema.json"),
                      "utf8",
                    ),
                  ) as unknown,
                }),
                chooseInstallation: createCodexInstallationChooser({
                  showOpenDialog: (options) =>
                    dialog.showOpenDialog({
                      title: options.title,
                      properties: [...options.properties],
                    }),
                  selection,
                }),
              };
            } catch {
              await proxy?.close().catch(() => {});
              if (sessionRoot) {
                await rm(sessionRoot, { force: true, recursive: true }).catch(
                  () => {},
                );
              }
              return null;
            }
          })();
      const assistantRuntime = codexIntegration?.runtime;
      const assistantCoordinator = new AssistantCoordinator({
        broker: calendarBroker,
        calendarReader: createApplicationCalendarReader(calendarBroker),
        phaseRunner: codexIntegration
          ? codexIntegration.phaseRunner
          : createProductionCodexPhaseRunner(
              undefined,
              packagedSmoke
                ? {
                    runCodexPhase: async () => {
                      packagedSmokeCodexSpawnAttempts += 1;
                      throw new Error("PACKAGED_SMOKE_CODEX_SPAWN_BLOCKED");
                    },
                  }
                : {},
            ),
      });
      const assistantHandlers = createAssistantIpcHandlers(
        assistantCoordinator,
        assistantRuntime,
        {
          challenges: loginChallenges,
          openUrl: async (url) => {
            if (!isAllowedAssistantLoginUrl(url)) {
              throw new Error("Assistant login URL is not trusted");
            }
            await shell.openExternal(url);
          },
        },
        codexIntegration?.chooseInstallation,
      );
      disposeGoogleIpcHandlers = googleHandlers.dispose;
      revokeGoogleIpcHandlers = googleHandlers.revoke;
      const rendererTokenProvider =
        localAuthIssuer.authority.createRendererTokenProvider();
      const packagedSmokeResult = packagedSmoke
        ? await runPackagedSmokeScenario({
            broker: calendarBroker,
            deploymentUrl: healthyConvex.deploymentUrl,
            phase: packagedSmoke.phase,
            tokenProvider: rendererTokenProvider,
          })
        : null;
      await recordPackagedSmokeStage("scenario-ready");
      desktopStartupStage = "recovery-handlers";
      recoveryLifecycle = new RecoveryLifecycle(
        createOwnedResourceDrain({
          revokeIpcProducers: () => {
            googleHandlers.revoke();
            assistantHandlers.revoke();
          },
          stopProviderMigration: async () => {},
          stopOnlineMonitor: () => {},
          disposeGoogleIpc: createGoogleIpcDrainStep({
            dispose: async () => {
              await disposeGoogleIpcHandlers?.();
            },
            afterDispose: () => {
              disposeGoogleIpcHandlers = null;
            },
          }),
          disposeAssistant: async () => {
            stopAssistantLoginEvents?.();
            stopAssistantLoginEvents = null;
            await assistantHandlers.dispose();
            stopSettingsStatusEvents?.();
            stopSettingsStatusEvents = null;
            await activeSettingsStore.close();
            if (settingsStore === activeSettingsStore) settingsStore = null;
          },
          stopGoogleWorker: async () => {
            await googleSyncSupervisor?.stop();
            googleSyncSupervisor = null;
          },
          closeCalendarBroker: () => calendarBroker.close(),
          drainConvex: async () => {
            await convexSupervisor?.drain();
          },
          stopConvex: async () => {
            await convexSupervisor?.stop();
          },
          closeAuthIssuer: async () => {
            await localAuthIssuer?.close();
            localAuthIssuer = null;
          },
        }),
      );
      const recoveryHandlers = createRecoveryIpcHandlers({
        exportData: () =>
          exportLocalData({
            authority: recoveryAuthority,
            chooseDestination: async () => {
              const result = await dialog.showSaveDialog({
                title: "Export Qali calendar data",
                defaultPath: join(paths.exports, "Qali Calendar Export.json"),
                filters: [{ name: "JSON", extensions: ["json"] }],
              });
              return result.canceled ? null : result.filePath;
            },
            loadSnapshot: () => calendarBroker.exportLocalSnapshot(),
          }),
        listBackups: () => listRecoveryBackups(recoveryAuthority),
        restore: async (backupId) => {
          const confirmation = await dialog.showMessageBox({
            type: "warning",
            buttons: ["Cancel", "Restore backup"],
            defaultId: 0,
            cancelId: 0,
            message: "Restore this local Qali backup?",
            detail:
              "Qali will stop its local calendar service and must be restarted after the restore.",
          });
          if (confirmation.response !== 1)
            throw new Error("RECOVERY_CANCELLED");
          await recoveryLifecycle!.run("restore", async () => {
            await restoreLocalBackup({
              authority: recoveryAuthority,
              backupId,
              expectedBuildMarker: RECOVERY_BUILD_MARKER,
              verifyRestoredDatabase: async () => {
                await invalidateBuildMarker(paths);
                const restoredIssuer = await startLocalAuthIssuer({
                  hostname: "127.0.0.1",
                  port: Number(issuerUrl.port),
                  keychain,
                });
                localAuthIssuer = restoredIssuer;
                let restoredBroker: ConvexCalendarBrokerClient | null = null;
                try {
                  const restoredConvex = await convexSupervisor!.start();
                  restoredBroker = new ConvexCalendarBrokerClient({
                    deploymentUrl: restoredConvex.deploymentUrl,
                    tokenProvider:
                      restoredIssuer.authority.createDesktopBrokerTokenProvider(),
                  });
                  const identities = await googleOAuth.listAccountIdentities();
                  await verifyGoogleAccounts(restoredBroker, identities);
                  await convexSupervisor!.completeMigration();
                } finally {
                  const cleanup = await Promise.allSettled([
                    restoredBroker?.close() ?? Promise.resolve(),
                    (async () => {
                      try {
                        await convexSupervisor!.drain();
                      } finally {
                        await convexSupervisor!.stop();
                      }
                    })(),
                    restoredIssuer.close(),
                  ]);
                  if (localAuthIssuer === restoredIssuer)
                    localAuthIssuer = null;
                  const failure = cleanup.find(
                    (result): result is PromiseRejectedResult =>
                      result.status === "rejected",
                  );
                  if (failure) throw failure.reason;
                }
              },
            });
          });
        },
        reset: async () => {
          const confirmation = await dialog.showMessageBox({
            type: "warning",
            buttons: ["Cancel", "Back up and reset"],
            defaultId: 0,
            cancelId: 0,
            message: "Reset all local Qali data?",
            detail:
              "A verified backup will be created first. Only Qali's own local data and Keychain records are affected.",
          });
          if (confirmation.response !== 1)
            throw new Error("RECOVERY_CANCELLED");
          await recoveryLifecycle!.run("reset", async () => {
            await resetLocalData({
              authority: recoveryAuthority,
              buildMarker: RECOVERY_BUILD_MARKER,
              readKeychainRecord: (record) => keychain.get(record),
              writeKeychainRecord: (record, value) =>
                keychain.set(record, value),
              deleteKeychainRecord: (record) => keychain.delete(record),
            });
          });
        },
      });
      desktopStartupStage = "ipc";
      registerDesktopIpc(
        ipcMain,
        createDesktopIpcHandlers({
          bootstrap: async () => ({
            bridgeVersion: BRIDGE_VERSION,
            convexUrl: healthyConvex.deploymentUrl,
            rendererAuthToken: await rendererTokenProvider.getToken({
              forceRefreshToken: true,
            }),
            google: await googleSnapshot(),
            assistant: assistantRuntime
              ? await assistantRuntime.status()
              : { kind: "unavailable" },
            settings: activeSettingsStore.snapshot(),
          }),
          google: googleHandlers,
          assistant: assistantHandlers,
          settings: createSettingsIpcHandlers(activeSettingsStore),
          updates: {
            "updates:status": () => desktopUpdateCoordinator!.snapshot(),
            "updates:check": () => desktopUpdateCoordinator!.check(),
            "updates:install": () => desktopUpdateCoordinator!.install(),
          },
          recovery: recoveryHandlers,
        }),
        rendererRegistry,
      );
      desktopStartupStage = "window";
      const mainWindow = createMainWindow(rendererRegistry);
      desktopUpdateCoordinator.scheduleAutomaticCheck();
      desktopStartupStage = "healthy";
      const packagedRendererDiagnostics: string[] = [];
      if (packagedSmoke) {
        mainWindow.webContents.on(
          "console-message",
          (_event, level, message) => {
            if (packagedRendererDiagnostics.length < 20) {
              packagedRendererDiagnostics.push(
                `console:${level}:${message.slice(0, 240)}`,
              );
            }
          },
        );
        mainWindow.webContents.on(
          "did-fail-load",
          (_event, code, description, url) => {
            if (packagedRendererDiagnostics.length < 20) {
              packagedRendererDiagnostics.push(
                `load:${code}:${description}:${url}`,
              );
            }
          },
        );
      }
      await recordPackagedSmokeStage("window-created");
      if (packagedSmoke) {
        mainWindow.webContents.once("did-finish-load", () => {
          void (async () => {
            let renderer: {
              bodyTextLength: number;
              localStorage: unknown[];
              rootChildCount: number;
              sessionStorage: unknown[];
              title: string;
              url: string;
            } | null = null;
            const rendererDeadline = Date.now() + 15_000;
            while (Date.now() < rendererDeadline) {
              const candidate: {
                bodyTextLength: number;
                localStorage: unknown[];
                rootChildCount: number;
                sessionStorage: unknown[];
                title: string;
                url: string;
              } | null = await mainWindow.webContents
                .executeJavaScript(`(() => {
                const root = document.getElementById("app");
                return {
                  bodyTextLength: document.body.innerText.length,
                  localStorage: Object.entries(localStorage),
                  rootChildCount: root?.childElementCount ?? 0,
                  sessionStorage: Object.entries(sessionStorage),
                  title: document.title,
                  url: location.href,
                };
              })()`);
              if (candidate) renderer = candidate;
              if (
                candidate &&
                candidate.rootChildCount > 0 &&
                candidate.bodyTextLength > 0
              )
                break;
              await new Promise((resolvePromise) =>
                setTimeout(resolvePromise, 100),
              );
            }
            if (
              !renderer ||
              renderer.rootChildCount < 1 ||
              renderer.bodyTextLength < 1
            ) {
              throw new Error("PACKAGED_SMOKE_RENDERER_NOT_MOUNTED");
            }
            const screenshot = (
              await mainWindow.webContents.capturePage()
            ).toPNG();
            const screenshotPath = join(
              packagedSmoke.root,
              "packaged-smoke-renderer.png",
            );
            await writeFile(screenshotPath, screenshot, { mode: 0o600 });
            const exportedSnapshot = `${JSON.stringify(
              await calendarBroker.exportLocalSnapshot(),
            )}\n`;
            const exportPath = join(
              packagedSmoke.root,
              "packaged-smoke-export.json",
            );
            await writeFile(exportPath, exportedSnapshot, {
              encoding: "utf8",
              mode: 0o600,
            });
            const ownedSpawnReceipts = finishOwnedSpawnObservation();
            const smokeMarkerTemporary = join(
              dirname(packagedSmoke.readyMarker),
              "packaged-smoke-ready.tmp",
            );
            await writeFile(
              smokeMarkerTemporary,
              `${JSON.stringify({
                assistant: "unavailable",
                bridgeVersion: BRIDGE_VERSION,
                codexSpawnAttempts: packagedSmokeCodexSpawnAttempts,
                eventCount: packagedSmokeResult?.eventCount,
                exportSha256: createHash("sha256")
                  .update(exportedSnapshot)
                  .digest("hex"),
                formatVersion: 2,
                googleNetworkAttempts: packagedSmokeGoogleNetworkAttempts,
                nonce: packagedSmoke.nonce,
                ownedSpawnReceipts,
                pendingCount: packagedSmokeResult?.pendingCount,
                phase: packagedSmoke.phase,
                renderer,
                screenshot: {
                  bytes: screenshot.byteLength,
                  path: screenshotPath,
                  sha256: createHash("sha256").update(screenshot).digest("hex"),
                },
                service: "ready",
              })}\n`,
              { encoding: "utf8", flag: "wx", mode: 0o600 },
            );
            await rename(smokeMarkerTemporary, packagedSmoke.readyMarker);
          })().catch(async (error: unknown) => {
            await recordPackagedSmokeStage(
              `renderer-evidence-failed:${error instanceof Error ? error.message.slice(0, 96) : "unknown"}:${packagedRendererDiagnostics.join("|").slice(0, 512)}`,
            ).catch(() => {});
            app.quit();
          });
        });
      }
    } catch (error) {
      await recordStartupFailure(paths.logs, error, desktopStartupStage).catch(
        () => {},
      );
      revokeGoogleIpcHandlers?.();
      await disposeGoogleIpcHandlers?.();
      disposeGoogleIpcHandlers = null;
      revokeGoogleIpcHandlers = null;
      stopAssistantLoginEvents?.();
      stopAssistantLoginEvents = null;
      stopSettingsStatusEvents?.();
      stopSettingsStatusEvents = null;
      desktopUpdateCoordinator?.dispose();
      desktopUpdateCoordinator = null;
      await settingsStore?.close().catch(() => {});
      settingsStore = null;
      await googleSyncSupervisor?.stop();
      googleSyncSupervisor = null;
      await convexSupervisor?.drain().catch(() => {});
      await convexSupervisor?.stop().catch(() => {});
      await localAuthIssuer?.close();
      localAuthIssuer = null;
      if (verifiedRestorePendingHealth && startupRecoveryAuthority) {
        await rollbackPendingRestore(startupRecoveryAuthority).catch(() => {});
      }
      if (packagedSmoke) {
        await recordPackagedSmokeStage(
          `failed:${lastConvexProgress}:${error instanceof Error ? error.message.slice(0, 96) : "unknown"}`,
        ).catch(() => {});
        await writeFile(
          packagedSmoke.readyMarker,
          `${JSON.stringify({
            failure:
              error instanceof Error
                ? error.message.slice(0, 256)
                : "PACKAGED_SMOKE_STARTUP_FAILED",
            formatVersion: 1,
            nonce: packagedSmoke.nonce,
            phase: packagedSmoke.phase,
          })}\n`,
          { encoding: "utf8", flag: "wx", mode: 0o600 },
        ).catch(() => {});
      }
      dialog.showErrorBox(
        "Qali could not start its local calendar",
        "The verified local calendar service is unavailable. Your database was left in place.",
      );
      app.quit();
      return;
    }

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0)
        createMainWindow(rendererRegistry);
    });
  });
}

app.on("before-quit", (event) => {
  if (shutdownFinished || !convexSupervisor) return;
  event.preventDefault();
  if (shutdownStarted) return;
  shutdownStarted = true;
  void (async () => {
    if (recoveryLifecycle) {
      await recoveryLifecycle.shutdown();
      shutdownFinished = true;
      finishDesktopShutdown();
      return;
    }
    revokeGoogleIpcHandlers?.();
    await disposeGoogleIpcHandlers?.();
    disposeGoogleIpcHandlers = null;
    revokeGoogleIpcHandlers = null;
    stopAssistantLoginEvents?.();
    stopAssistantLoginEvents = null;
    stopSettingsStatusEvents?.();
    stopSettingsStatusEvents = null;
    await settingsStore?.close();
    settingsStore = null;
    await shutdownSyncBeforeBackend({
      sync: googleSyncSupervisor,
      stopBackend: async () => {
        await convexSupervisor?.drain();
        await convexSupervisor?.stop();
      },
    });
    googleSyncSupervisor = null;
    await localAuthIssuer?.close();
    localAuthIssuer = null;
    shutdownFinished = true;
    finishDesktopShutdown();
  })().catch(() => {
    shutdownStarted = false;
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

if (packagedSmoke) {
  process.once("SIGTERM", () => app.quit());
  process.once("SIGINT", () => app.quit());
}
