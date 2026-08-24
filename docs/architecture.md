# Qali architecture and repository map

**Audience:** maintainers and contributors  
**Owner:** Qali maintainers  
**Status:** current  
**Verified against:** the v0.1 desktop composition roots on 2026-08-21  
**Review when:** process ownership, contracts, storage, sync, assistant, or
release topology changes

## Product surfaces

Qali ships one primary product: an Apple Silicon macOS application with a React
renderer inside Electron. The repository also contains a public website and the
same renderer can run in development, but production calendar authority remains
in the installed desktop process.

## Trust and data flow

```text
User
  → React renderer (`apps/web`)
  → versioned runtime schemas (`packages/desktop-contracts`)
  → preload allowlist (`apps/desktop/src/preload/index.ts`)
  → Electron main (`apps/desktop/src/main/index.ts`)
      → local Convex child + local database
      → macOS Keychain
      → Google OAuth / Google Calendar APIs
      → separately installed Codex App Server
      → signed update metadata and installer
```

Renderer → preload → Electron main is the privileged boundary. The renderer
cannot request arbitrary paths, commands, feed URLs, OAuth values, processes,
or installers. Main validates requests and responses, owns credentials, and
returns bounded semantic state.

## Runtime owners

| Runtime        | Owns                                                                              | Must not own                                            |
| -------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Renderer       | presentation, navigation, optimistic intent, accessible interaction               | tokens, filesystem paths, child processes, update feeds |
| Electron main  | native windows, IPC authority, Keychain, OAuth, updates, local-service lifecycle  | calendar domain rules embedded in views                 |
| Local Convex   | calendars, events, account-scoped queues, sync receipts, proposals, conversations | macOS credentials or arbitrary native authority         |
| Google adapter | normalized Calendar API reads/writes and provider errors                          | renderer presentation or cross-account fallback         |
| Codex adapter  | one pinned App Server compatibility lane and bounded assistant turns              | direct calendar writes or ambient tool authority        |

## Calendar identity and synchronization

A connected Google account is identified by Google's immutable subject and one
of eight fixed Keychain slots. Calendars, sync cursors, pending operations, and
errors are account-scoped. A local create receives one optimistic event identity;
the Google result is reconciled into that row instead of appearing as a second
event. Full sync preserves unacknowledged local writes and repairs historical
provider-identity duplicates deterministically.

The user's default creation calendar is a persisted desktop setting. `follow
primary` resolves against the current primary account; a fixed choice stores a
stable account/calendar identity and falls back visibly when unavailable.

## Assistant boundary

The assistant uses a separately installed, byte-pinned Codex App Server and the
`gpt-5.6-luna` model at high reasoning effort. Qali supplies bounded calendar
context in an isolated read-only working directory. Tool-like calendar changes
are rendered as proposals and only Qali's existing calendar command path may
apply an explicitly confirmed proposal.

## Updates and releases

The renderer sees only typed update state and the semantic actions `check` and
`install`. Main owns the provider, download progress, coordinated shutdown, and
installer launch. Stable releases are Developer ID signed, notarized, stapled,
Gatekeeper checked, hashed, attested, and published from one immutable candidate.
See [`desktop/release-macos.md`](desktop/release-macos.md).

## Dependency direction

- `apps/web` may depend on `packages/ui`, `packages/domain`, backend client
  contracts, and desktop contracts, but never Electron privileged modules.
- `apps/desktop` may depend on desktop contracts and local runtime adapters, but
  renderer code communicates with it only through preload.
- `packages/backend` may depend on `packages/domain`; domain code remains free
  of React, Electron, Convex, and Google transport details.
- `packages/desktop-contracts` is runtime-safe and authority-minimal. Additive
  changes require producer and every consumer to move together.

## Focused verification map

| Concern              | Smallest honest proof                                               |
| -------------------- | ------------------------------------------------------------------- |
| UI component/command | focused Bun test plus rendered interaction                          |
| settings/IPC         | desktop-contract schema + preload/router tests                      |
| sync/idempotency     | calendar broker and local-write Convex integration tests            |
| service recovery     | process-driver boundary test and packaged hard-quit smoke           |
| assistant            | containment/readiness tests; authenticated live smoke is opt-in     |
| updater              | policy/coordinator tests and protected signed candidate lane        |
| packaging            | build-app/release tests, verifier, packaged smoke, release evidence |

The codebase knowledge graph is a discovery accelerator, not a release input.
If its results mention removed files, re-index it or verify against current
composition roots before making an ownership decision.
