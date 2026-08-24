# Contributing to Qali

Contributions are welcome. Qali is a local-first macOS application, so changes
that appear visual can still cross native, persistence, sync, or security
boundaries. Keep each change focused and prove it at the smallest boundary that
can fail.

## Setup

Prerequisites: Git and Bun 1.3.14.

```bash
git clone https://github.com/mielsense/qali.git
cd qali
git remote add upstream https://github.com/NatnaelTaddese/qali.git
bun install --frozen-lockfile
git switch -c feature/short-description
```

Use the checked-in lockfile. Do not upgrade dependencies as a side effect of an
unrelated change.

## Development lanes

### Desktop

The Electron main process owns local Convex, Google OAuth and Calendar I/O,
Keychain access, updates, filesystem operations, and the separately installed
Codex process. The renderer may use only the versioned preload contract.

Desktop development must not use the installed Qali data root. Tests and smoke
runs create disposable owned roots with explicit sentinels. Never stop a
process by broad name, path substring, or unverified port ownership.

Release-owner Google configuration is documented in
[docs/desktop/google-cloud-setup.md](docs/desktop/google-cloud-setup.md). Do not
download or import OAuth JSON into the app, and never commit a client secret.

### Hosted web

The hosted web lane is secondary and uses Convex Cloud. Copy the example files
only when working on that lane:

```bash
cp apps/web/.env.example apps/web/.env.local
cp packages/backend/.env.example packages/backend/.env.local
bun run dev:setup
bun run dev:web
```

Replace every example host. `.env` and `.env.local` files are ignored and must
never enter a commit.

## Verification

Run a focused test first, then the broad lanes appropriate to the change:

```bash
bun test path/to/focused.test.ts
bun run check-types
bun run test
bun run build
```

Native packaging and update changes also require:

```bash
bun run desktop:package
bun run desktop:verify-app
bun run desktop:smoke-packaged
```

The production package commands require a clean committed tree and release
inputs. The `:local` commands are explicit, non-publishable QA escape hatches
for an intentionally dirty tree. Do not regenerate release ledgers merely to
silence an unexplained failure.

## Pull requests

A pull request should:

- explain the user-visible outcome and the affected trust boundary;
- list exact checks and anything not run;
- include synthetic screenshots or recordings for visible changes;
- cover offline, retry, reverse, and update paths when applicable;
- keep generated output, personal data, local logs, plans, and secrets out.

Read [AGENTS.md](AGENTS.md) for the repository map, invariants, and
change-completeness rules. Local work never authorizes a deployment, release,
tag, repository-secret change, or mutation of personal browser state.
