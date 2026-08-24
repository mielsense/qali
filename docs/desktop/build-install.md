# Build and install Qali on this Mac

Qali ships one Apple Silicon (`arm64`) macOS application. Local developer builds
are ad-hoc signed; stable GitHub releases are Developer ID signed, notarized,
stapled, and update-compatible. Intel Macs are not supported. The packaged app
runs its own local Convex backend and does not need Bun, Docker, Convex Cloud, a
development server, or an API key at runtime.

## Prerequisites for building

- This Apple Silicon Mac, running macOS 12 or later.
- Xcode Command Line Tools (`xcode-select --install` if `/usr/bin/xcrun` is
  missing).
- Bun 1.3.14, matching the repository's locked `packageManager` field.
- Network access only if the locked JavaScript/Electron dependencies are not
  already cached. The pinned Convex backend, CLI, key generator, and Keychain
  helper are repository release inputs, not runtime downloads.

From the repository root:

```bash
bun install --frozen-lockfile
bun run test
bun run check-types
bun run build
bun run desktop:package
bun run desktop:verify-app
codesign --verify --deep --strict --verbose=2 dist/Qali.app
bun run desktop:probe-release-inputs
bun run desktop:smoke-packaged
```

`desktop:package` first requires a clean committed `HEAD` and a canonical exact
input ledger covering the application sources, backend project, native
resources, and packaged dependency closure. It then refuses non-macOS or
non-arm64 hosts, empties only the exact
repository `dist` directory, rebuilds the JavaScript application, creates one
`dist/Qali.app`, seals a final resource manifest, and ad-hoc signs the nested
code. `desktop:verify-app` inspects the final bundle bytes and writes ignored
evidence to `dist/qali-release-evidence.json`. The packaged smoke uses a
separately signed disposable clone and data root; the installed stable app has
no test-root override.

If you intentionally change a declared release input, commit the source change,
run `bun run desktop:generate-release-input-allowlist`, inspect and commit that
exact ledger as a second commit, and only then package. The generator refuses
untracked additions and packaging refuses a dirty source tree. Do not regenerate
the ledger to make an unexplained verification failure disappear.

For an intentional local QA build of a large uncommitted refactor, first run
`bun scripts/desktop/generate-release-input-allowlist.ts --accept-local-path-set-changes`
and inspect the complete manifest diff. Then run
`bun run desktop:generate-output-policy:local`, regenerate and inspect the
release-input allowlist once more, and run `bun run desktop:package:local`.
Verify and smoke that dirty-tree candidate with
`bun run desktop:verify-app:local` and
`bun run desktop:smoke-packaged:local`; the production commands continue to
require a clean committed source proof.
This explicit mode records the dirty source
proof, disables update publication, and may reuse the matching OAuth client
from the currently installed Qali without printing or writing its secret to
the repository. Both local escape hatches are rejected in CI; the production
release path above remains clean-tree only.

The observed packaged boundary and the lower-layer deterministic coverage are
kept distinct in the [release verification report](release-report.md).

If you intentionally edit the native Keychain helper source, rebuild that
checked release input before packaging:

```bash
bun run desktop:build-keychain-helper
```

Do not run that command merely to install an already verified `Qali.app`.

## Install and first launch

1. Quit any existing Qali process.
2. In Finder, copy `dist/Qali.app` to `/Applications/Qali.app`. Do not move
   individual files inside the bundle after verification.
3. On first launch, Control-click `/Applications/Qali.app`, choose **Open**,
   then confirm **Open** if macOS warns about an unidentified developer.
4. Follow [Google Cloud setup](google-cloud-setup.md) to connect one or more
   accounts.

Ad-hoc signing proves bundle integrity but not a Developer ID identity. This
app has no notarization ticket, so another Mac can reject it and a changed or
partially copied bundle will fail signature validation. Rebuild on this Mac
instead of disabling Gatekeeper globally.

## Runtime behavior

- Stable data: `~/Library/Application Support/Qali/`
- Keychain service: `com.qali.desktop`
- Local backend: a Qali-owned loopback process available only while the app is
  running
- Cloud backend: none
- Offline: the calendar remains readable and writable; Google changes queue
  locally and sync after connectivity returns while Qali is open
- Background sync while Qali is closed: none
- Updates: stable builds check the signed GitHub release channel; installation
  always requires confirmation and a coordinated restart

The first launch can take longer while Qali starts and deploys its sealed local
backend. A second launch focuses the existing window instead of opening another
writer.

## Codex assistant status

Qali never bundles Codex and never uses a DeepSeek or OpenAI API key. The
assistant requires a separately installed Codex CLI from Qali's explicit
compatibility lane and its supported ChatGPT device-login flow. Qali reports a
typed remediation state when the installation is missing, changed,
incompatible, or unauthenticated; the calendar continues to work.

Qali does not copy or bundle Codex credentials. Deterministic release tests do
not use a personal subscription; an authenticated semantic smoke remains an
explicit local opt-in step.

## Launch troubleshooting

- **macOS says the app is damaged or cannot be verified:** recopy the complete
  verified bundle, then rerun the `codesign --verify` command above. Do not use
  `xattr -dr` or disable Gatekeeper as a blanket fix.
- **Nothing appears:** quit Qali in Activity Monitor and reopen it once. Do not
  kill an unrelated process that owns a port. Local logs are described in
  [Privacy and diagnostics](privacy-and-diagnostics.md).
- **The calendar stays on its loading screen:** quit, wait a few seconds, and
  reopen. Preserve the data root before attempting recovery.
- **Google will not connect:** confirm Calendar API is enabled, Qali's release
  client is configured as a Desktop app, and every account is an allowed test
  user while the consent screen remains in Testing. There is no JSON import.
  Testing grants expire after seven days.
- **Google sync says offline or issue:** calendar edits remain queued. Restore
  connectivity and click the sync control; if access was revoked, reconnect.
- **Keychain permission/error:** open Keychain Access and confirm the login
  keychain is unlocked. Qali fails closed rather than writing plaintext
  credentials.
