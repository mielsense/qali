import { LoadingScreen } from "@qali/ui/components/loading-screen";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type {
  QaliSettingsDocument,
  SettingsPatchRequest,
  SettingsResetTarget,
  SettingsSnapshot,
  SettingsWriteResult,
} from "@qali/desktop-contracts";
import { setInterfaceSoundsEnabled } from "@qali/ui/lib/sound";

import { desktopApiFor } from "@/lib/desktop/api";
import {
  buildLegacySettingsMigration,
  createRendererDefaultSettings,
  deriveReduceTransparency,
  legacyRemovalKeys,
  reconcileSettingsSnapshot,
} from "@/lib/desktop/settings";
import { commitSettingsPatch } from "./settings-patch";

export type QaliSettingsContextValue = Readonly<{
  snapshot: SettingsSnapshot;
  patch(changes: SettingsPatchRequest["changes"]): Promise<SettingsWriteResult>;
  reset(target: SettingsResetTarget): Promise<SettingsWriteResult>;
}>;

const QaliSettingsContext = createContext<QaliSettingsContextValue | null>(
  null,
);

function operationId(kind: "patch" | "reset"): string {
  return `renderer-${kind}-${crypto.randomUUID()}`;
}

function hostedPatch(
  snapshot: SettingsSnapshot,
  changes: SettingsPatchRequest["changes"],
): SettingsSnapshot {
  const settings = snapshot.settings;
  return {
    settings: {
      ...settings,
      revision: settings.revision + 1,
      calendar: { ...settings.calendar, ...changes.calendar },
      appearance: { ...settings.appearance, ...changes.appearance },
      keybindings: changes.keybindings
        ? {
            overrides: {
              ...settings.keybindings.overrides,
              ...changes.keybindings.overrides,
            },
          }
        : settings.keybindings,
    },
  };
}

function resetChanges(
  defaults: QaliSettingsDocument,
  target: SettingsResetTarget,
): SettingsPatchRequest["changes"] {
  if (target === "calendar") return { calendar: defaults.calendar };
  if (target === "appearance") return { appearance: defaults.appearance };
  if (target === "keybindings") return { keybindings: { overrides: {} } };
  const [section, key] = target.split(".") as [
    "calendar" | "appearance",
    string,
  ];
  if (section === "calendar") {
    const calendarKey = key as keyof QaliSettingsDocument["calendar"];
    return { calendar: { [calendarKey]: defaults.calendar[calendarKey] } };
  }
  const appearanceKey = key as keyof QaliSettingsDocument["appearance"];
  return {
    appearance: { [appearanceKey]: defaults.appearance[appearanceKey] },
  };
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  const api = useMemo(() => desktopApiFor(), []);
  const defaults = useMemo(
    () =>
      createRendererDefaultSettings(
        Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      ),
    [],
  );
  const [snapshot, setSnapshot] = useState<SettingsSnapshot | null>(
    api ? null : defaults,
  );
  const snapshotRef = useRef(snapshot);
  const migrationStarted = useRef(false);
  const [systemReducedTransparency, setSystemReducedTransparency] = useState(
    () => window.matchMedia("(prefers-reduced-transparency: reduce)").matches,
  );

  const acceptSnapshot = useCallback((incoming: SettingsSnapshot) => {
    const current = snapshotRef.current;
    const next = current
      ? reconcileSettingsSnapshot(current, incoming)
      : incoming;
    snapshotRef.current = next;
    setSnapshot(next);
    return next;
  }, []);

  useEffect(() => {
    if (!api) return;
    let active = true;
    const unsubscribe = api.subscribe((event) => {
      if (active && event.type === "settings-changed") {
        acceptSnapshot(event.snapshot);
      }
    });
    void api
      .bootstrap()
      .then((bootstrap) => {
        if (active) acceptSnapshot(bootstrap.settings);
      })
      .catch(() => {});
    return () => {
      active = false;
      unsubscribe();
    };
  }, [acceptSnapshot, api]);

  useEffect(() => {
    if (!api || snapshot === null || migrationStarted.current) return;
    migrationStarted.current = true;
    let migration;
    try {
      migration = buildLegacySettingsMigration((key) =>
        window.localStorage.getItem(key),
      );
    } catch {
      return;
    }
    if (!migration) return;
    void api
      .settingsImportLegacy(migration.request)
      .then((result) => {
        acceptSnapshot(result.snapshot);
        for (const key of legacyRemovalKeys({ migration, result })) {
          try {
            window.localStorage.removeItem(key);
          } catch {
            // A replay on the next launch returns the durable receipt again.
          }
        }
      })
      .catch(() => {});
  }, [acceptSnapshot, api, snapshot]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-transparency: reduce)");
    const update = () => setSystemReducedTransparency(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  const reduceTransparency = deriveReduceTransparency(
    systemReducedTransparency,
    snapshot?.settings.appearance.transparency ?? "follow-system",
  );
  useLayoutEffect(() => {
    document.documentElement.toggleAttribute(
      "data-qali-reduce-transparency",
      reduceTransparency,
    );
  }, [reduceTransparency]);

  const interfaceSounds = snapshot?.settings.appearance.interfaceSounds ?? true;
  useLayoutEffect(() => {
    setInterfaceSoundsEnabled(interfaceSounds);
  }, [interfaceSounds]);

  const patch = useCallback(
    async (
      changes: SettingsPatchRequest["changes"],
    ): Promise<SettingsWriteResult> => {
      const current = snapshotRef.current;
      if (!current) throw new Error("Settings bootstrap is not ready");
      const requestedInterfaceSounds = changes.appearance?.interfaceSounds;
      if (!api) {
        if (requestedInterfaceSounds !== undefined) {
          setInterfaceSoundsEnabled(requestedInterfaceSounds);
        }
        const next = hostedPatch(current, changes);
        acceptSnapshot(next);
        setInterfaceSoundsEnabled(next.settings.appearance.interfaceSounds);
        return { kind: "committed", snapshot: next };
      }
      return commitSettingsPatch({
        current,
        changes,
        operationId: operationId("patch"),
        patchRemote: (request) => api.settingsPatch(request),
        acceptSnapshot,
        latestSnapshot: () => snapshotRef.current,
        setInterfaceSounds: setInterfaceSoundsEnabled,
      });
    },
    [acceptSnapshot, api],
  );

  const reset = useCallback(
    async (target: SettingsResetTarget): Promise<SettingsWriteResult> => {
      const current = snapshotRef.current;
      if (!current) throw new Error("Settings bootstrap is not ready");
      if (!api) {
        const next = hostedPatch(
          current,
          resetChanges(defaults.settings, target),
        );
        acceptSnapshot(next);
        return { kind: "committed", snapshot: next };
      }
      const requestId = operationId("reset");
      let result = await api.settingsReset({
        baseRevision: current.settings.revision,
        operationId: requestId,
        target,
      });
      acceptSnapshot(result.snapshot);
      if (result.kind === "revision-conflict") {
        result = await api.settingsReset({
          baseRevision: result.snapshot.settings.revision,
          operationId: requestId,
          target,
        });
        acceptSnapshot(result.snapshot);
      }
      return result;
    },
    [acceptSnapshot, api, defaults.settings],
  );

  const value = useMemo<QaliSettingsContextValue | null>(
    () => (snapshot ? { snapshot, patch, reset } : null),
    [patch, reset, snapshot],
  );
  if (!value) return <LoadingScreen />;
  return (
    <QaliSettingsContext.Provider value={value}>
      {children}
    </QaliSettingsContext.Provider>
  );
}

export function useQaliSettings(): QaliSettingsContextValue {
  const context = useContext(QaliSettingsContext);
  if (!context) throw new Error("Qali settings require SettingsProvider");
  return context;
}
