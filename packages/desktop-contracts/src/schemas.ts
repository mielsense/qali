import { z } from "zod";

export const BRIDGE_VERSION = 2 as const;
export const MAX_GOOGLE_ACCOUNTS = 8 as const;

const MAX_SHORT_STRING_LENGTH = 256;
const MAX_STATUS_MESSAGE_LENGTH = 1_024;
const MAX_ASSISTANT_TEXT_LENGTH = 20_000;
const MAX_AUTH_TOKEN_LENGTH = 8_192;
const MAX_URL_LENGTH = 2_048;
const MAX_RECORD_ENTRIES = 32;
const MAX_SETTINGS_OPERATION_ID_LENGTH = 128;
const MAX_TIME_ZONE_LENGTH = 128;

const shortString = z.string().min(1).max(MAX_SHORT_STRING_LENGTH);
export const assistantLoginAttemptIdSchema = z
  .string()
  .regex(/^login_[0-9a-f]{32}$/);
export const assistantCoordinatorAttemptIdSchema = z
  .string()
  .regex(/^assistant_[0-9a-f]{32}$/);
export const assistantAttemptIdSchema = z.union([
  assistantLoginAttemptIdSchema,
  assistantCoordinatorAttemptIdSchema,
]);
const optionalStatusMessage = z
  .string()
  .max(MAX_STATUS_MESSAGE_LENGTH)
  .optional();
const emptyRequest = z.object({}).strict();
const backupIdSchema = z.string().regex(/^[0-9]{8}T[0-9]{9}Z-[a-f0-9]{12}$/);
const settingsOperationIdSchema = z
  .string()
  .min(1)
  .max(MAX_SETTINGS_OPERATION_ID_LENGTH);
export const googleAccountIdSchema = z
  .string()
  .regex(/^gacc_[A-Za-z0-9_-]{43}$/);
const boundedStringRecord = z
  .record(
    z.string().max(MAX_SHORT_STRING_LENGTH),
    z.string().max(MAX_SHORT_STRING_LENGTH),
  )
  .refine((record) => Object.keys(record).length <= MAX_RECORD_ENTRIES, {
    message: `Records may contain at most ${MAX_RECORD_ENTRIES} entries`,
  });

export type CommandId =
  | "calendar.view.day"
  | "calendar.view.week"
  | "calendar.view.month"
  | "calendar.today"
  | "calendar.navigate.previous"
  | "calendar.navigate.next"
  | "calendar.event.create"
  | "command-palette.open"
  | "assistant.toggle"
  | "settings.open"
  | "workspace.section.1"
  | "workspace.section.2"
  | "workspace.section.3"
  | "workspace.section.4"
  | "workspace.section.5"
  | "workspace.section.6"
  | "workspace.section.7"
  | "workspace.section.8"
  | "workspace.section.9";

export type KeybindingModifier = "meta" | "ctrl" | "alt" | "shift";

export type Keybinding = Readonly<{
  key: string;
  modifiers: readonly KeybindingModifier[];
}>;

export const defaultCommandKeybindings = {
  "calendar.view.day": { key: "d", modifiers: [] },
  "calendar.view.week": { key: "w", modifiers: [] },
  "calendar.view.month": { key: "m", modifiers: [] },
  "calendar.today": { key: "t", modifiers: [] },
  "command-palette.open": { key: "k", modifiers: ["meta"] },
  "assistant.toggle": { key: "k", modifiers: ["meta", "shift"] },
  "calendar.event.create": { key: "n", modifiers: ["meta"] },
  "settings.open": { key: ",", modifiers: ["meta"] },
  "workspace.section.1": { key: "1", modifiers: ["meta"] },
  "workspace.section.2": { key: "2", modifiers: ["meta"] },
  "workspace.section.3": { key: "3", modifiers: ["meta"] },
  "workspace.section.4": { key: "4", modifiers: ["meta"] },
  "workspace.section.5": { key: "5", modifiers: ["meta"] },
  "workspace.section.6": { key: "6", modifiers: ["meta"] },
  "workspace.section.7": { key: "7", modifiers: ["meta"] },
  "workspace.section.8": { key: "8", modifiers: ["meta"] },
  "workspace.section.9": { key: "9", modifiers: ["meta"] },
  "calendar.navigate.previous": { key: "arrowleft", modifiers: ["meta"] },
  "calendar.navigate.next": { key: "arrowright", modifiers: ["meta"] },
} as const satisfies Readonly<Partial<Record<CommandId, Keybinding>>>;

export type QaliSettingsDocument = Readonly<{
  schemaVersion: 2;
  revision: number;
  calendar: Readonly<{
    dayStartHour: number;
    dayEndHour: number;
    hourHeight: 72 | 96 | 120;
    defaultView: "day" | "week" | "month";
    primaryTimeZone: string;
    secondaryTimeZones: readonly string[];
    /** `null` follows the provider primary; otherwise new events prefer this
     * writable provider calendar and fall back safely if it disappears. */
    defaultCalendarId: string | null;
  }>;
  appearance: Readonly<{
    theme: "system" | "light" | "dark";
    glassOpacity: number;
    transparency: "follow-system" | "always-reduce";
    interfaceSounds: boolean;
  }>;
  keybindings: Readonly<{
    overrides: Readonly<Partial<Record<CommandId, Keybinding | null>>>;
  }>;
}>;

export type SettingsSnapshot = Readonly<{
  settings: QaliSettingsDocument;
}>;

export type SettingsWriteResult =
  | Readonly<{ kind: "committed" | "replayed"; snapshot: SettingsSnapshot }>
  | Readonly<{ kind: "revision-conflict"; snapshot: SettingsSnapshot }>;

export type SettingsPatchRequest = Readonly<{
  baseRevision: number;
  operationId: string;
  changes: Readonly<{
    calendar?: Partial<QaliSettingsDocument["calendar"]>;
    appearance?: Partial<QaliSettingsDocument["appearance"]>;
    keybindings?: Readonly<{
      overrides: Readonly<Partial<Record<CommandId, Keybinding | null>>>;
    }>;
  }>;
}>;

export type SettingsResetTarget =
  | "calendar"
  | "appearance"
  | "keybindings"
  | "calendar.dayStartHour"
  | "calendar.dayEndHour"
  | "calendar.hourHeight"
  | "calendar.defaultView"
  | "calendar.primaryTimeZone"
  | "calendar.secondaryTimeZones"
  | "calendar.defaultCalendarId"
  | "appearance.theme"
  | "appearance.glassOpacity"
  | "appearance.transparency"
  | "appearance.interfaceSounds";

export type SettingsResetRequest = Readonly<{
  baseRevision: number;
  operationId: string;
  target: SettingsResetTarget;
}>;

export type LegacySettingsImportRequest = Readonly<{
  operationId: string;
  calendarPreferencesV1?: Readonly<{
    dayStartHour: number;
    dayEndHour: number;
    hourHeight: number;
    defaultView: "day" | "week" | "month";
  }>;
  theme?: "system" | "light" | "dark";
}>;

const commandIds = [
  "calendar.view.day",
  "calendar.view.week",
  "calendar.view.month",
  "calendar.today",
  "calendar.navigate.previous",
  "calendar.navigate.next",
  "calendar.event.create",
  "command-palette.open",
  "assistant.toggle",
  "settings.open",
  "workspace.section.1",
  "workspace.section.2",
  "workspace.section.3",
  "workspace.section.4",
  "workspace.section.5",
  "workspace.section.6",
  "workspace.section.7",
  "workspace.section.8",
  "workspace.section.9",
] as const satisfies readonly CommandId[];

export const commandIdSchema = z.enum(commandIds);

const keybindingModifiers = ["meta", "ctrl", "alt", "shift"] as const;
const keybindingModifierSchema = z.enum(keybindingModifiers);
const keybindingModifierOrder = new Map(
  keybindingModifiers.map((modifier, index) => [modifier, index]),
);
const normalizedKeySchema = z
  .string()
  .regex(
    /^(?:[a-z0-9]|,|\.|;|'|\[|\]|-|=|\/|\\\\|`|space|enter|escape|tab|backspace|delete|arrowleft|arrowright|arrowup|arrowdown)$/,
  );
const reservedKeybindings = new Set([
  "meta+q",
  "meta+w",
  "meta+h",
  "meta+m",
  "meta+space",
  "meta+tab",
  "meta+escape",
]);

export const keybindingSchema = z
  .object({
    key: normalizedKeySchema,
    modifiers: z
      .array(keybindingModifierSchema)
      .max(keybindingModifiers.length),
  })
  .strict()
  .superRefine((binding, context) => {
    const uniqueModifiers = new Set(binding.modifiers);
    if (uniqueModifiers.size !== binding.modifiers.length) {
      context.addIssue({
        code: "custom",
        message: "Keybinding modifiers must be unique",
      });
    }
    const sortedModifiers = [...binding.modifiers].sort(
      (left, right) =>
        keybindingModifierOrder.get(left)! -
        keybindingModifierOrder.get(right)!,
    );
    if (
      binding.modifiers.some(
        (modifier, index) => modifier !== sortedModifiers[index],
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "Keybinding modifiers must be normalized",
      });
    }
    if (
      reservedKeybindings.has([...binding.modifiers, binding.key].join("+"))
    ) {
      context.addIssue({
        code: "custom",
        message: "Keybinding is reserved by macOS",
      });
    }
  });

const supportedTimeZones =
  typeof Intl.supportedValuesOf === "function"
    ? new Set(Intl.supportedValuesOf("timeZone"))
    : undefined;
const timeZoneSchema = z
  .string()
  .min(1)
  .max(MAX_TIME_ZONE_LENGTH)
  .refine((timeZone) => {
    if (supportedTimeZones && !supportedTimeZones.has(timeZone)) return false;
    try {
      new Intl.DateTimeFormat("en-US", { timeZone });
      return true;
    } catch {
      return false;
    }
  }, "Time zone must be a supported canonical IANA identifier");

const settingsKeybindingOverridesSchema = z
  .object({
    "calendar.view.day": keybindingSchema.nullable().optional(),
    "calendar.view.week": keybindingSchema.nullable().optional(),
    "calendar.view.month": keybindingSchema.nullable().optional(),
    "calendar.today": keybindingSchema.nullable().optional(),
    "calendar.navigate.previous": keybindingSchema.nullable().optional(),
    "calendar.navigate.next": keybindingSchema.nullable().optional(),
    "calendar.event.create": keybindingSchema.nullable().optional(),
    "command-palette.open": keybindingSchema.nullable().optional(),
    "assistant.toggle": keybindingSchema.nullable().optional(),
    "settings.open": keybindingSchema.nullable().optional(),
    "workspace.section.1": keybindingSchema.nullable().optional(),
    "workspace.section.2": keybindingSchema.nullable().optional(),
    "workspace.section.3": keybindingSchema.nullable().optional(),
    "workspace.section.4": keybindingSchema.nullable().optional(),
    "workspace.section.5": keybindingSchema.nullable().optional(),
    "workspace.section.6": keybindingSchema.nullable().optional(),
    "workspace.section.7": keybindingSchema.nullable().optional(),
    "workspace.section.8": keybindingSchema.nullable().optional(),
    "workspace.section.9": keybindingSchema.nullable().optional(),
  })
  .strict();

const defaultCalendarIdSchema = z.string().trim().min(1).max(512).nullable();
const calendarSettingsShape = {
  dayStartHour: z.number().int().min(0).max(23),
  dayEndHour: z.number().int().min(1).max(24),
  hourHeight: z.union([z.literal(72), z.literal(96), z.literal(120)]),
  defaultView: z.enum(["day", "week", "month"]),
  primaryTimeZone: timeZoneSchema,
  secondaryTimeZones: z.array(timeZoneSchema).max(2),
  defaultCalendarId: defaultCalendarIdSchema,
} as const;

const calendarSettingsBaseSchema = z.object(calendarSettingsShape).strict();

const calendarSettingsSchema = z
  .object({
    ...calendarSettingsShape,
    // Older schema-v2 files predate the durable creation target.
    defaultCalendarId: defaultCalendarIdSchema.default(null),
  })
  .strict()
  .superRefine((calendar, context) => {
    if (calendar.dayStartHour >= calendar.dayEndHour) {
      context.addIssue({
        code: "custom",
        message: "dayStartHour must precede dayEndHour",
      });
    }
    const secondaryTimeZones = new Set(calendar.secondaryTimeZones);
    if (secondaryTimeZones.size !== calendar.secondaryTimeZones.length) {
      context.addIssue({
        code: "custom",
        message: "Secondary time zones must be unique",
      });
    }
    if (secondaryTimeZones.has(calendar.primaryTimeZone)) {
      context.addIssue({
        code: "custom",
        message: "A secondary time zone cannot match the primary time zone",
      });
    }
  });

const appearanceSettingsShape = {
  theme: z.enum(["system", "light", "dark"]),
  glassOpacity: z.number().min(0.6).max(0.95),
  transparency: z.enum(["follow-system", "always-reduce"]),
  interfaceSounds: z.boolean(),
} as const;

const appearanceSettingsBaseSchema = z.object(appearanceSettingsShape).strict();
const appearanceSettingsSchema = z
  .object({
    ...appearanceSettingsShape,
    // Older schema-v2 files predate this additive preference.
    interfaceSounds: z.boolean().default(true),
  })
  .strict();

export const qaliSettingsDocumentSchema = z
  .object({
    schemaVersion: z.literal(2),
    revision: z.number().int().nonnegative(),
    calendar: calendarSettingsSchema,
    appearance: appearanceSettingsSchema,
    keybindings: z
      .object({ overrides: settingsKeybindingOverridesSchema })
      .strict(),
  })
  .strict();

export const settingsSnapshotSchema = z
  .object({
    settings: qaliSettingsDocumentSchema,
  })
  .strict();

export const settingsWriteResultSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("committed"), snapshot: settingsSnapshotSchema })
    .strict(),
  z
    .object({ kind: z.literal("replayed"), snapshot: settingsSnapshotSchema })
    .strict(),
  z
    .object({
      kind: z.literal("revision-conflict"),
      snapshot: settingsSnapshotSchema,
    })
    .strict(),
]);

const partialCalendarSettingsSchema = calendarSettingsBaseSchema.partial();
const partialAppearanceSettingsSchema = appearanceSettingsBaseSchema.partial();
export const settingsPatchRequestSchema = z
  .object({
    baseRevision: z.number().int().nonnegative(),
    operationId: settingsOperationIdSchema,
    changes: z
      .object({
        calendar: partialCalendarSettingsSchema.optional(),
        appearance: partialAppearanceSettingsSchema.optional(),
        keybindings: z
          .object({ overrides: settingsKeybindingOverridesSchema })
          .strict()
          .optional(),
      })
      .strict(),
  })
  .strict();

export const settingsResetRequestSchema = z
  .object({
    baseRevision: z.number().int().nonnegative(),
    operationId: settingsOperationIdSchema,
    target: z.enum([
      "calendar",
      "appearance",
      "keybindings",
      "calendar.dayStartHour",
      "calendar.dayEndHour",
      "calendar.hourHeight",
      "calendar.defaultView",
      "calendar.primaryTimeZone",
      "calendar.secondaryTimeZones",
      "calendar.defaultCalendarId",
      "appearance.theme",
      "appearance.glassOpacity",
      "appearance.transparency",
      "appearance.interfaceSounds",
    ]),
  })
  .strict();

export const legacySettingsImportRequestSchema = z
  .object({
    operationId: settingsOperationIdSchema,
    calendarPreferencesV1: z
      .object({
        dayStartHour: z.number().int().min(0).max(23),
        dayEndHour: z.number().int().min(1).max(24),
        hourHeight: z.number().int().positive(),
        defaultView: z.enum(["day", "week", "month"]),
      })
      .strict()
      .optional(),
    theme: z.enum(["system", "light", "dark"]).optional(),
  })
  .strict();

export const googleAccountStatusSchema = z.discriminatedUnion("state", [
  z
    .object({
      accountId: googleAccountIdSchema,
      accountEmail: z.string().email().max(MAX_SHORT_STRING_LENGTH),
      state: z.literal("connected"),
      syncState: z.enum(["idle", "syncing", "offline", "error"]),
      message: optionalStatusMessage,
    })
    .strict(),
  z
    .object({
      accountId: googleAccountIdSchema,
      accountEmail: z.string().email().max(MAX_SHORT_STRING_LENGTH),
      state: z.literal("reconnect-required"),
      reason: z.enum([
        "client-mismatch",
        "authentication-expired",
        "credentials-incomplete",
        "credentials-unsafe",
      ]),
      message: optionalStatusMessage,
    })
    .strict(),
]);

const googleReadySnapshotSchema = z
  .object({
    kind: z.literal("ready"),
    accounts: z.array(googleAccountStatusSchema).max(MAX_GOOGLE_ACCOUNTS),
    oauthBusy: z.boolean(),
  })
  .strict()
  .superRefine((snapshot, context) => {
    const accountIds = new Set(
      snapshot.accounts.map((account) => account.accountId),
    );
    if (accountIds.size !== snapshot.accounts.length) {
      context.addIssue({
        code: "custom",
        path: ["accounts"],
        message: "Google account identifiers must be unique",
      });
    }
  });

const googleUnavailableSnapshotSchema = z
  .object({
    kind: z.literal("unavailable"),
    message: optionalStatusMessage,
  })
  .strict();

const googleLegacyRecoverySnapshotSchema = z
  .object({
    kind: z.literal("unavailable"),
    message: optionalStatusMessage,
    recoveryRequired: z.literal("legacy-credentials"),
    recoveryAction: z.literal("clear-legacy-credentials"),
  })
  .strict();

export const googleAccountsSnapshotSchema = z.union([
  googleReadySnapshotSchema,
  googleLegacyRecoverySnapshotSchema,
  googleUnavailableSnapshotSchema,
]);

export const googleAddAccountResultSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("completed"),
      snapshot: googleAccountsSnapshotSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("cancelled"),
      snapshot: googleAccountsSnapshotSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("limit-reached"),
      snapshot: googleAccountsSnapshotSchema,
    })
    .strict(),
]);

export const googleReconnectAccountResultSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("completed"),
      snapshot: googleAccountsSnapshotSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("cancelled"),
      snapshot: googleAccountsSnapshotSchema,
    })
    .strict(),
]);

export const assistantProviderStatusSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("probing") }).strict(),
  z.object({ kind: z.literal("ready") }).strict(),
  z.object({ kind: z.literal("ready-degraded") }).strict(),
  z.object({ kind: z.literal("authentication-required") }).strict(),
  z.object({ kind: z.literal("needs-reprobe") }).strict(),
  z.object({ kind: z.literal("incompatible") }).strict(),
  z.object({ kind: z.literal("unavailable") }).strict(),
  z.object({ kind: z.literal("probe-failed") }).strict(),
]);

export const assistantSendRequestSchema = z
  .object({
    text: z.string().min(1).max(MAX_ASSISTANT_TEXT_LENGTH),
    timeZone: shortString,
  })
  .strict();

export const assistantSendResultSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("accepted"),
      attemptId: assistantCoordinatorAttemptIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("rejected"),
      reason: z.enum([
        "busy",
        "probing",
        "authentication-required",
        "entitlement-required",
        "incompatible",
        "model-unavailable",
        "needs-reprobe",
        "probe-failed",
        "quota-exceeded",
        "schema-failure",
        "cancelled",
        "unavailable",
      ]),
      message: optionalStatusMessage,
    })
    .strict(),
]);

const assistantLoginUrlSchema = z
  .string()
  .max(MAX_URL_LENGTH)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        url.hostname === "auth.openai.com" &&
        url.port === "" &&
        url.username === "" &&
        url.password === ""
      );
    } catch {
      return false;
    }
  }, "Assistant login URL is not trusted");

export const assistantOpenLoginRequestSchema = z
  .object({
    attemptId: assistantLoginAttemptIdSchema,
    url: assistantLoginUrlSchema,
    code: z
      .string()
      .regex(/^[A-Z0-9]{4,12}(?:-[A-Z0-9]{4,12}){0,3}$/)
      .max(51),
  })
  .strict();

export const assistantLoginResultSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("started"),
      attemptId: assistantLoginAttemptIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("rejected"),
      status: assistantProviderStatusSchema,
    })
    .strict(),
]);

export const chooseCodexInstallationResultSchema = z.discriminatedUnion(
  "kind",
  [
    z
      .object({
        kind: z.literal("selected"),
        status: assistantProviderStatusSchema,
      })
      .strict(),
    z.object({ kind: z.literal("cancelled") }).strict(),
    z.object({ kind: z.literal("missing") }).strict(),
    z
      .object({
        kind: z.literal("incompatible"),
        status: assistantProviderStatusSchema,
      })
      .strict(),
  ],
);

export const assistantLoginEventSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("progress"),
      stage: z.enum([
        "preparing",
        "requesting-code",
        "instructions",
        "credentials-stored",
      ]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("challenge"),
      url: assistantLoginUrlSchema,
      code: z
        .string()
        .regex(/^[A-Z0-9]{4,12}(?:-[A-Z0-9]{4,12}){0,3}$/)
        .max(51),
    })
    .strict(),
  z
    .object({
      kind: z.literal("status"),
      status: assistantProviderStatusSchema,
    })
    .strict(),
]);

const applicationVersionSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
  .max(64);
const updateTimestampSchema = z.iso.datetime();

/** A deliberately small updater contract. The renderer never receives feed
 * URLs, downloaded file paths, signatures, or installer handles. */
export const desktopUpdateStateSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("disabled"),
      currentVersion: applicationVersionSchema,
      reason: z.enum(["development", "packaged-smoke", "release-policy"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("idle"),
      currentVersion: applicationVersionSchema,
      lastCheckedAt: updateTimestampSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("checking"),
      currentVersion: applicationVersionSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("current"),
      currentVersion: applicationVersionSchema,
      checkedAt: updateTimestampSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("downloading"),
      currentVersion: applicationVersionSchema,
      version: applicationVersionSchema,
      percent: z.number().min(0).max(100),
    })
    .strict(),
  z
    .object({
      kind: z.literal("ready"),
      currentVersion: applicationVersionSchema,
      version: applicationVersionSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("error"),
      currentVersion: applicationVersionSchema,
      message: z.string().min(1).max(MAX_STATUS_MESSAGE_LENGTH),
    })
    .strict(),
]);

export const updateInstallResultSchema = z
  .object({ kind: z.literal("restarting") })
  .strict();

export const desktopBootstrapSchema = z
  .object({
    bridgeVersion: z.literal(BRIDGE_VERSION),
    convexUrl: z.string().url().max(MAX_URL_LENGTH),
    rendererAuthToken: z.string().min(1).max(MAX_AUTH_TOKEN_LENGTH),
    google: googleAccountsSnapshotSchema,
    assistant: assistantProviderStatusSchema,
    settings: settingsSnapshotSchema,
  })
  .strict();

export const desktopStatusEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("google-status"),
      status: googleAccountsSnapshotSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("assistant-status"),
      status: assistantProviderStatusSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("assistant-login"),
      attemptId: assistantLoginAttemptIdSchema,
      event: assistantLoginEventSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("settings-changed"),
      snapshot: settingsSnapshotSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("update-status"),
      status: desktopUpdateStateSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("diagnostic"),
      code: shortString,
      values: boundedStringRecord,
    })
    .strict(),
]);

export type DesktopBootstrap = Readonly<{
  bridgeVersion: typeof BRIDGE_VERSION;
  convexUrl: string;
  rendererAuthToken: string;
  google: GoogleAccountsSnapshot;
  assistant: AssistantProviderStatus;
  settings: SettingsSnapshot;
}>;
export type GoogleAccountId = z.infer<typeof googleAccountIdSchema>;
export type GoogleAccountStatus = z.infer<typeof googleAccountStatusSchema>;
export type GoogleAccountsSnapshot = z.infer<
  typeof googleAccountsSnapshotSchema
>;
export type GoogleAddAccountResult = z.infer<
  typeof googleAddAccountResultSchema
>;
export type GoogleReconnectAccountResult = z.infer<
  typeof googleReconnectAccountResultSchema
>;
export type AssistantProviderStatus =
  | z.infer<typeof assistantProviderStatusSchema>
  /** Compile-only compatibility for the retired, unreferenced login runtime. */
  | Readonly<{ kind: "offline" }>;
export type AssistantSendRequest = z.infer<typeof assistantSendRequestSchema>;
export type AssistantSendResult = z.infer<typeof assistantSendResultSchema>;
export type AssistantLoginAttemptId = z.infer<
  typeof assistantLoginAttemptIdSchema
>;
export type AssistantCoordinatorAttemptId = z.infer<
  typeof assistantCoordinatorAttemptIdSchema
>;
export type AssistantAttemptId = z.infer<typeof assistantAttemptIdSchema>;
export type AssistantLoginResult = z.infer<typeof assistantLoginResultSchema>;
export type AssistantLoginEvent = z.infer<typeof assistantLoginEventSchema>;
export type AssistantOpenLoginRequest = z.infer<
  typeof assistantOpenLoginRequestSchema
>;
export type ChooseCodexInstallationResult = z.infer<
  typeof chooseCodexInstallationResultSchema
>;
export type DesktopStatusEvent = z.infer<typeof desktopStatusEventSchema>;
export type DesktopUpdateState = z.infer<typeof desktopUpdateStateSchema>;
export type UpdateInstallResult = z.infer<typeof updateInstallResultSchema>;

export const recoveryExportResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("cancelled") }).strict(),
  z
    .object({
      kind: z.literal("exported"),
      bytes: z
        .number()
        .int()
        .nonnegative()
        .max(64 * 1024 * 1024),
      calendarCount: z.number().int().nonnegative().max(500),
      eventCount: z.number().int().nonnegative().max(100_000),
    })
    .strict(),
]);

export const recoveryBackupSummarySchema = z
  .object({
    id: backupIdSchema,
    createdAt: z.iso.datetime(),
    bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    buildMarker: z.string().min(1).max(512),
    verified: z.literal(true),
  })
  .strict();

export type RecoveryExportResult = z.infer<typeof recoveryExportResultSchema>;
export type RecoveryBackupSummary = z.infer<typeof recoveryBackupSummarySchema>;

export const ipcRequestSchemas = {
  "runtime:bootstrap": emptyRequest,
  "google:status": emptyRequest,
  "google:add-account": emptyRequest,
  "google:reconnect-account": z
    .object({ accountId: googleAccountIdSchema })
    .strict(),
  "google:disconnect-account": z
    .object({ accountId: googleAccountIdSchema })
    .strict(),
  "google:sync-account": z
    .object({ accountId: googleAccountIdSchema })
    .strict(),
  "google:sync-all": emptyRequest,
  "google:clear-legacy-credentials": emptyRequest,
  "assistant:status": emptyRequest,
  "assistant:login": emptyRequest,
  "assistant:open-login-url": assistantOpenLoginRequestSchema,
  "assistant:choose-codex-installation": emptyRequest,
  "assistant:send": assistantSendRequestSchema,
  "assistant:cancel": z
    .object({ attemptId: assistantAttemptIdSchema })
    .strict(),
  "settings:get": emptyRequest,
  "settings:patch": settingsPatchRequestSchema,
  "settings:reset": settingsResetRequestSchema,
  "settings:import-legacy": legacySettingsImportRequestSchema,
  "updates:status": emptyRequest,
  "updates:check": emptyRequest,
  "updates:install": emptyRequest,
  "recovery:export": emptyRequest,
  "recovery:list-backups": emptyRequest,
  "recovery:restore": z.object({ backupId: backupIdSchema }).strict(),
  "recovery:reset": emptyRequest,
} as const;

export const ipcResultSchemas = {
  "runtime:bootstrap": desktopBootstrapSchema,
  "google:status": googleAccountsSnapshotSchema,
  "google:add-account": googleAddAccountResultSchema,
  "google:reconnect-account": googleReconnectAccountResultSchema,
  "google:disconnect-account": googleAccountsSnapshotSchema,
  "google:sync-account": googleAccountsSnapshotSchema,
  "google:sync-all": googleAccountsSnapshotSchema,
  "google:clear-legacy-credentials": googleAccountsSnapshotSchema,
  "assistant:status": assistantProviderStatusSchema,
  "assistant:login": assistantLoginResultSchema,
  "assistant:open-login-url": z.undefined(),
  "assistant:choose-codex-installation": chooseCodexInstallationResultSchema,
  "assistant:send": assistantSendResultSchema,
  "assistant:cancel": z.undefined(),
  "settings:get": settingsSnapshotSchema,
  "settings:patch": settingsWriteResultSchema,
  "settings:reset": settingsWriteResultSchema,
  "settings:import-legacy": settingsWriteResultSchema,
  "updates:status": desktopUpdateStateSchema,
  "updates:check": desktopUpdateStateSchema,
  "updates:install": updateInstallResultSchema,
  "recovery:export": recoveryExportResultSchema,
  "recovery:list-backups": z.array(recoveryBackupSummarySchema).max(100),
  "recovery:restore": z
    .object({
      kind: z.literal("restored"),
      backupId: backupIdSchema,
      restartRequired: z.literal(true),
    })
    .strict(),
  "recovery:reset": z
    .object({
      kind: z.literal("reset"),
      restartRequired: z.literal(true),
    })
    .strict(),
} as const;

export type IpcChannel = keyof typeof ipcRequestSchemas;

export function parseIpcRequest<C extends IpcChannel>(
  channel: C,
  value: unknown,
): z.infer<(typeof ipcRequestSchemas)[C]> {
  return ipcRequestSchemas[channel].parse(value) as z.infer<
    (typeof ipcRequestSchemas)[C]
  >;
}

export function parseIpcResult<C extends IpcChannel>(
  channel: C,
  value: unknown,
): z.infer<(typeof ipcResultSchemas)[C]> {
  return ipcResultSchemas[channel].parse(value) as z.infer<
    (typeof ipcResultSchemas)[C]
  >;
}
