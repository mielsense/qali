# Working on Qali

Qali is a local-first macOS calendar. The Electron main process owns local
Convex, credentials, Google OAuth and Calendar I/O, updates, filesystem access,
and the separately installed Codex process. The React renderer is untrusted and
can use only the versioned preload contract.

## Product invariants

- Calendar reads and writes remain usable offline; account-scoped sync resumes
  without duplicating optimistic local events.
- One release-owned Google Desktop OAuth client supports up to eight connected
  accounts. Tokens and client configuration never cross into the renderer.
- Assistant writes are proposals until the user confirms them. Codex receives
  no Google credentials, shell, arbitrary filesystem, MCP, or approval access.
- The installed app recovers only Qali-owned orphan services after a hard quit.
  Never kill a process by broad name, path substring, or unverified port owner.
- Settings, semantic commands, and native capabilities cross process boundaries
  through runtime-validated schemas in `packages/desktop-contracts`.
- The UI follows the shared quiet/elevated design system. Reuse components and
  Motion transitions; preserve keyboard, focus, reduced-motion, and contrast.

## Repository map

| Area                         | Responsibility                                                        | Composition root / owner                                                 |
| ---------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `apps/desktop`               | Electron main, preload, native lifecycle, OAuth, updates, packaging   | `apps/desktop/src/main/index.ts`                                         |
| `apps/web`                   | Calendar, Insights, Settings, command palette, assistant renderer     | `apps/web/src/routeTree.desktop.ts` and `apps/web/src/routes/__root.tsx` |
| `apps/www`                   | Public product/legal site                                             | `apps/www/src/main.tsx`                                                  |
| `packages/backend`           | Local Convex schema, calendar broker, sync queue, assistant proposals | `packages/backend/convex/schema.ts`; also read its scoped `AGENTS.md`    |
| `packages/desktop-contracts` | Runtime schemas for every renderer/main boundary                      | `packages/desktop-contracts/src/schemas.ts`                              |
| `packages/domain`            | Provider-independent calendar and recurrence rules                    | `packages/domain/src/index.ts`                                           |
| `packages/ui`                | Shared design tokens and reusable UI primitives                       | `packages/ui/src/styles/globals.css`                                     |
| `scripts/desktop`            | Deterministic package, verification, smoke, and release automation    | `scripts/desktop/build-app.ts` and `release-macos.ts`                    |

Current architecture and trust boundaries are documented in
[`docs/architecture.md`](docs/architecture.md). Desktop setup, recovery,
privacy, and release operations live under `docs/desktop/`.

## Safe development

- Use Bun 1.3.14 and the checked-in lockfile: `bun install --frozen-lockfile`.
- Never use the installed Qali data root for development or tests. Integrated
  tests must create a disposable root with the expected sentinel and clean only
  that exact owned root.
- Do not copy, print, screenshot, or commit OAuth client secrets, refresh tokens,
  Keychain values, App Store Connect keys, signing certificates, or personal
  calendar data. Use synthetic fixtures for deterministic tests.
- Start shared dev servers, Electron, or browser previews from one coordinating
  session. Stop only captured children or an independently verified Qali-owned
  PID/port/cwd tuple.
- Treat `.env*`, `dist/`, local logs, release evidence, and packaged smoke roots
  as local outputs. Do not hand-edit generated Convex files except through their
  documented generator.
- Preserve unrelated working-tree changes. Local edits do not authorize pushes,
  tags, releases, deployments, repository-secret changes, or personal browser
  mutations.

## Commands and evidence

Run the smallest command that proves the changed risk:

```bash
bun test path/to/focused.test.ts
bun run check-types
bun run build
bun run desktop:package
bun run desktop:verify-app
bun run desktop:smoke-packaged
```

`bun run test` is the broad workspace lane. Packaging requires the exact
arm64 macOS host, clean release inputs, and the release-owned OAuth secret.
Signed/notarized publication belongs to the protected workflow described in
[`docs/desktop/release-macos.md`](docs/desktop/release-macos.md).

Prove the changed risk at the smallest boundary that can actually fail:

- pure behavior: unit/policy/schema test;
- persistence, sync, or idempotency: real disposable Convex boundary test;
- main/preload changes: contract abuse test plus desktop typecheck;
- visual/interaction changes: focused component test and real rendered evidence;
- process, packaging, signing, or updates: packaged candidate/smoke evidence.

Report exact commands and results. Say `not run` when a native, authenticated,
or release-only lane was not available.

## Change completeness

For behavior that crosses boundaries, check the applicable entry points (main
UI, Settings, command palette, keymap), renderer/main contracts, local database,
Google account/provider path, offline/retry/reverse state, update compatibility,
docs, and focused evidence. A setting is incomplete if its schema, defaults,
renderer control, semantic command, persistence, and tests disagree.

## Instruction ownership

This root file is the canonical repository-wide agent guide. The only current
scoped guide is `packages/backend/AGENTS.md`, owned by the Convex integration;
its `CLAUDE.md` file is a compatibility mirror and must stay semantically equal.
Review this file when composition roots, safe commands, trust boundaries,
release policy, or supported agent discovery change. Keep specialist detail in
the linked docs rather than expanding this router.
