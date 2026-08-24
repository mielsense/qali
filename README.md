# Qali

Qali is a local-first Google Calendar for macOS with fast day, week, and month
views, multiple account sync, reference time zones, keyboard-first navigation,
calendar Insights, and a confirmation-first Codex assistant.

The desktop app runs its database and sync queue on your Mac. Calendar reads
and edits stay available offline, Google credentials remain in macOS Keychain,
and the renderer never receives provider tokens or arbitrary native access.

## Highlights

- Day, week, and month views with a primary time zone and two reference clocks
- Support for up to eight Google accounts with isolated credentials,
  per-calendar visibility, and color
- Offline-first event creation, editing, deletion, and idempotent sync recovery
- Searchable settings, rebindable shortcuts, and a `⌘K` command palette
- Local 28-day Insights derived from calendar data on the device
- Optional Codex assistant that proposes changes and waits for confirmation
- Signed-update architecture, hard-quit recovery, backup, and diagnostics flows

Qali currently ships for Apple Silicon Macs running macOS 12 or later.

## Repository

This Bun monorepo separates native authority from the untrusted React renderer.

| Path | Responsibility |
| --- | --- |
| `apps/desktop` | Electron main process, preload, OAuth, updates, packaging |
| `apps/web` | Calendar, Insights, Settings, commands, assistant UI |
| `apps/www` | Public product and legal site |
| `packages/backend` | Local Convex schema, sync queue, assistant proposals |
| `packages/desktop-contracts` | Runtime-validated renderer/main contracts |
| `packages/domain` | Provider-independent calendar rules |
| `packages/ui` | Shared quiet/elevated design system and primitives |
| `scripts/desktop` | Reproducible package, verification, smoke, and release tools |

See [the architecture guide](docs/architecture.md) for trust boundaries and
composition roots.

## Development

Prerequisites: Git and [Bun 1.3.14](https://bun.sh/docs/installation).

```bash
git clone https://github.com/mielsense/qali.git
cd qali
bun install --frozen-lockfile
bun run check-types
bun run test
bun run build
```

The desktop lane owns local Convex and does not need Convex Cloud, Docker, an
OpenAI API key, or Google credentials in renderer environment variables.
Release-owner OAuth setup is documented separately and secrets must never be
committed. Hosted web development remains available as a secondary lane; copy
the relevant checked-in `.env.example` file to `.env.local` and replace every
placeholder.

Read [CONTRIBUTING.md](CONTRIBUTING.md) before changing native boundaries,
calendar sync, packaging, or release code. Coding agents should also read
[AGENTS.md](AGENTS.md).

## Package and verify the macOS app

Production packaging requires a clean reviewed commit and the release-owned
Google Desktop OAuth input. Local QA has an explicit non-publishable lane.

```bash
# Local QA candidate from an intentionally dirty tree
bun scripts/desktop/generate-release-input-allowlist.ts --accept-local-path-set-changes
bun run desktop:generate-output-policy:local
bun run desktop:generate-release-input-allowlist
bun run desktop:package:local
bun run desktop:verify-app:local
bun run desktop:smoke-packaged:local

# Clean production candidate
bun run desktop:package
bun run desktop:verify-app
bun run desktop:smoke-packaged
```

The complete setup and release procedures are in:

- [Build and install](docs/desktop/build-install.md)
- [Google Cloud and OAuth](docs/desktop/google-cloud-setup.md)
- [Backup, recovery, reset, and uninstall](docs/desktop/data-backup-recovery.md)
- [Privacy and diagnostics](docs/desktop/privacy-and-diagnostics.md)
- [Signed macOS release runbook](docs/desktop/release-macos.md)

## Security and privacy

Qali is local-first, but it still handles sensitive calendar metadata. Please
report vulnerabilities privately according to [SECURITY.md](SECURITY.md). Do
not include real calendar records, OAuth secrets, refresh tokens, Keychain
contents, signing materials, or personal diagnostics in issues or fixtures.

## Origin and license

This desktop application is based on the original
[Qali calendar UI](https://github.com/NatnaelTaddese/qali) by Natnael Taddese
and contributors. The local-first desktop architecture, multi-account sync,
assistant, Insights, settings, packaging, and release system were developed in
this repository. See [NOTICE](NOTICE) for attribution.

Qali is licensed under the [GNU Affero General Public License v3.0](LICENSE).
