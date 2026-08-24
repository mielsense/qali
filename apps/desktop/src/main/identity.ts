export const IDENTITIES = {
  stable: {
    bundleId: "com.qali.desktop",
    name: "Qali",
    namespace: "Qali",
  },
  development: {
    bundleId: "com.qali.desktop.dev",
    name: "Qali Dev",
    namespace: "Qali Development",
  },
  test: {
    bundleId: "com.qali.desktop.test",
    name: "Qali Test",
    namespace: "Qali Test",
  },
} as const;

export type AppChannel = keyof typeof IDENTITIES;

export type KeychainService =
  (typeof IDENTITIES)[AppChannel]["bundleId"];

type AppIdentityFor<Channel extends AppChannel> = Readonly<
  (typeof IDENTITIES)[Channel] & {
    channel: Channel;
    appData: string;
  }
>;

export type AppIdentity = {
  [Channel in AppChannel]: AppIdentityFor<Channel>;
}[AppChannel];

export function selectAppChannel(
  isPackaged: boolean,
  nodeEnvironment = process.env.NODE_ENV,
): AppChannel {
  if (isPackaged) return "stable";
  return nodeEnvironment === "test" ? "test" : "development";
}

export function createAppIdentity<Channel extends AppChannel>(
  channel: Channel,
  appData: string,
): AppIdentityFor<Channel> {
  if (!appData) throw new Error("Application data path is required");

  return Object.freeze({
    channel,
    appData,
    ...IDENTITIES[channel],
  }) as AppIdentityFor<Channel>;
}
