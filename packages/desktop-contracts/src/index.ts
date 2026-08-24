export {
  BRIDGE_VERSION,
  MAX_GOOGLE_ACCOUNTS,
  assistantAttemptIdSchema,
  assistantCoordinatorAttemptIdSchema,
  assistantLoginAttemptIdSchema,
  defaultCommandKeybindings,
  type AssistantAttemptId,
  type AssistantCoordinatorAttemptId,
  type AssistantLoginAttemptId,
  type AssistantProviderStatus,
  type AssistantLoginEvent,
  type AssistantLoginResult,
  type AssistantOpenLoginRequest,
  type AssistantSendRequest,
  type AssistantSendResult,
  type DesktopBootstrap,
  type DesktopStatusEvent,
  type DesktopUpdateState,
  type GoogleAccountId,
  type GoogleAccountStatus,
  type GoogleAccountsSnapshot,
  type GoogleAddAccountResult,
  type GoogleReconnectAccountResult,
  type IpcChannel,
  type CommandId,
  type Keybinding,
  type KeybindingModifier,
  type LegacySettingsImportRequest,
  type QaliSettingsDocument,
  type RecoveryBackupSummary,
  type RecoveryExportResult,
  type SettingsPatchRequest,
  type SettingsResetRequest,
  type SettingsResetTarget,
  type SettingsSnapshot,
  type SettingsWriteResult,
  type UpdateInstallResult,
  parseIpcRequest,
  parseIpcResult,
} from "./schemas";

import type {
  AssistantAttemptId,
  AssistantProviderStatus,
  AssistantLoginResult,
  AssistantOpenLoginRequest,
  AssistantSendRequest,
  AssistantSendResult,
  DesktopBootstrap,
  DesktopStatusEvent,
  DesktopUpdateState,
  GoogleAccountId,
  GoogleAccountsSnapshot,
  GoogleAddAccountResult,
  GoogleReconnectAccountResult,
  LegacySettingsImportRequest,
  RecoveryBackupSummary,
  RecoveryExportResult,
  SettingsPatchRequest,
  SettingsResetRequest,
  SettingsSnapshot,
  SettingsWriteResult,
  UpdateInstallResult,
} from "./schemas";

export interface QaliDesktopApi {
  runtime: { bootstrap(): Promise<DesktopBootstrap> };
  google: {
    status(): Promise<GoogleAccountsSnapshot>;
    addAccount(): Promise<GoogleAddAccountResult>;
    reconnectAccount(
      accountId: GoogleAccountId,
    ): Promise<GoogleReconnectAccountResult>;
    disconnectAccount(
      accountId: GoogleAccountId,
    ): Promise<GoogleAccountsSnapshot>;
    syncAccount(accountId: GoogleAccountId): Promise<GoogleAccountsSnapshot>;
    syncAll(): Promise<GoogleAccountsSnapshot>;
    clearLegacyCredentials(): Promise<GoogleAccountsSnapshot>;
  };
  assistant: {
    status(): Promise<AssistantProviderStatus>;
    login(): Promise<AssistantLoginResult>;
    openLoginUrl(request: AssistantOpenLoginRequest): Promise<void>;
    send(request: AssistantSendRequest): Promise<AssistantSendResult>;
    cancel(attemptId: AssistantAttemptId): Promise<void>;
  };
  settings: {
    get(): Promise<SettingsSnapshot>;
    patch(request: SettingsPatchRequest): Promise<SettingsWriteResult>;
    reset(request: SettingsResetRequest): Promise<SettingsWriteResult>;
    importLegacy(
      request: LegacySettingsImportRequest,
    ): Promise<SettingsWriteResult>;
  };
  updates: {
    status(): Promise<DesktopUpdateState>;
    check(): Promise<DesktopUpdateState>;
    install(): Promise<UpdateInstallResult>;
  };
  recovery: {
    exportData(): Promise<RecoveryExportResult>;
    listBackups(): Promise<RecoveryBackupSummary[]>;
    restore(backupId: string): Promise<{
      kind: "restored";
      backupId: string;
      restartRequired: true;
    }>;
    reset(): Promise<{ kind: "reset"; restartRequired: true }>;
  };
  events: {
    subscribe(listener: (event: DesktopStatusEvent) => void): () => void;
  };
}
