import type {
  SettingsPatchRequest,
  SettingsSnapshot,
  SettingsWriteResult,
} from "@qali/desktop-contracts";

type CommitSettingsPatchOptions = Readonly<{
  current: SettingsSnapshot;
  changes: SettingsPatchRequest["changes"];
  operationId: string;
  patchRemote(request: SettingsPatchRequest): Promise<SettingsWriteResult>;
  acceptSnapshot(snapshot: SettingsSnapshot): SettingsSnapshot;
  latestSnapshot(): SettingsSnapshot | null | undefined;
  setInterfaceSounds(enabled: boolean): void;
}>;

export async function commitSettingsPatch({
  current,
  changes,
  operationId,
  patchRemote,
  acceptSnapshot,
  latestSnapshot,
  setInterfaceSounds,
}: CommitSettingsPatchOptions): Promise<SettingsWriteResult> {
  const requestedInterfaceSounds = changes.appearance?.interfaceSounds;
  if (requestedInterfaceSounds !== undefined) {
    setInterfaceSounds(requestedInterfaceSounds);
  }

  const acceptAuthoritative = (result: SettingsWriteResult) => {
    const accepted = acceptSnapshot(result.snapshot);
    setInterfaceSounds(accepted.settings.appearance.interfaceSounds);
  };

  try {
    let result = await patchRemote({
      baseRevision: current.settings.revision,
      operationId,
      changes,
    });
    acceptAuthoritative(result);
    if (result.kind === "revision-conflict") {
      result = await patchRemote({
        baseRevision: result.snapshot.settings.revision,
        operationId,
        changes,
      });
      acceptAuthoritative(result);
    }
    return result;
  } catch (error) {
    const latest = latestSnapshot() ?? current;
    setInterfaceSounds(latest.settings.appearance.interfaceSounds);
    throw error;
  }
}
