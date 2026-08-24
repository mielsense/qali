# Privacy and diagnostics

Qali Desktop is local-first and calendar-focused. It has no Convex Cloud
deployment, analytics, automatic crash upload, advertising, or billing
integration. Its updater checks signed GitHub release metadata from Electron
main; the renderer never receives or selects a feed URL, file path, or installer.

## What stays on this Mac

Under `~/Library/Application Support/Qali/`:

- the local Convex calendar database and deployed local modules;
- calendars, events, recurrence data, attendees, locations, and conference
  metadata needed by the calendar UI;
- the offline operation queue, sync tokens/state, conflicts, and application
  records;
- assistant conversations, bounded attempt events, and proposals stored by the
  application;
- verified migration backups, user-requested exports, bounded local logs, and
  runtime/config markers.

In macOS Keychain under service `com.qali.desktop`:

- up to eight atomic Google account records, each containing one refresh token
  and that account's subject/email metadata;
- local Convex instance/admin material and the local JWT signing key.

Qali's Google Desktop OAuth client ID and installed-app client-secret value are
release-owned application resources. The repository stores only the public ID;
the release process injects the installed-app value into the signed bundle from
a local environment secret and removes its temporary input. Installed desktop
clients cannot keep that value confidential; Qali sends it only to Google's
token endpoint during authorization-code and refresh-token exchange and never
exposes it to the renderer, settings, logs, or diagnostics. Current releases do
not import OAuth JSON or create a Google client-secret Keychain record. An upgrade from an older development build may
retain its legacy imported client record in Keychain only while a same-account
migration is being verified or recovery is required. Qali does not use, send,
or log that record's client-secret field. **Disconnect Google** clears it; a
client-ID mismatch, corrupt marker, or legacy tuple whose account identity
cannot be established must be disconnected before the release-owned client can
be connected. If a fresh grant is stored but legacy-marker cleanup cannot be
verified against the packaged public client ID, Qali reports bounded recovery
instead of claiming a connected state. Qali applies the same identity boundary
to partial modern records when no legacy marker exists: account-only state can
reconnect only to the same subject; refresh-only or corrupt account state must
be explicitly disconnected first.

## What leaves this Mac

### Google

Only after you explicitly connect Google, Electron main sends OAuth requests,
your verified email identity request, and Google Calendar API traffic required
to list subscribed calendars, read/write events, and read free/busy data.
Calendar content involved in synchronization is therefore processed by Google
under your Google account. Consent always opens in the system browser. The
renderer never receives the refresh token, authorization code, PKCE verifier,
or OAuth client configuration.

When offline, calendar work remains local. Disconnect drains and clears only
the selected account; other accounts remain connected. Qali attempts online
token revocation, while removing access from Google's
third-party-connections page is the authoritative remote revoke. Tokens,
subjects, Keychain slot names, OAuth codes, and PKCE material never cross the
preload/renderer bridge.

### Codex/OpenAI

The assistant is optional and uses a separately installed, explicitly supported
Codex App Server. Qali does not bundle Codex, copy its credentials, or request an
OpenAI API key. If Codex is missing, incompatible, or not signed in, the
calendar remains usable and Qali reports the bounded remediation state.

Only an explicit assistant turn sends the text you submit, Qali's bounded
conversation summary, and the calendar context needed for that request to the
Codex/OpenAI service. The provider receives an isolated empty working directory,
read-only sandbox, no approvals, no dynamic tools, no MCP tools, and no shell,
filesystem, or web-search authority. It does not receive Google credentials or
Convex admin material. Calendar writes remain Qali-owned proposals and require
user confirmation before the app executes them.

### Convex

The packaged Convex backend is a child process bound to loopback on this Mac.
It does not use Convex Cloud. Local authenticated traffic between the renderer,
Electron main, and that process does not leave the machine.

## Logs and redaction

Current logs are in `~/Library/Application Support/Qali/logs/`. The local
backend log is bounded to 512 KiB plus one rotated file. Child output is not
copied verbatim: Qali serializes a small allowlisted lifecycle record after
redaction.

Allowed diagnostic fields are component/version, state transitions, bounded
duration/count, safe error code, opaque operation ID, migration/restart state,
and `arm64` architecture. Diagnostics do not collect event titles,
descriptions, attendees, locations, conference data, assistant prompts or
answers, OAuth URLs/codes/state/verifiers/tokens/cookies, local JWTs, Convex
instance/admin credentials, Codex authentication material, arbitrary command
arguments, or full home-directory paths.

There is no automatic diagnostic upload or support-bundle submission. If you
share a log manually, inspect the file first even though the writer is
allowlisted and redacted.

## Package and release privacy checks

The release verifier scans the final `Qali.app` bytes for credentials, seeded
canaries, home/source paths, development servers, forbidden providers, tests,
source maps, undeclared executable code, architecture/signature mismatches, and
a user-selectable smoke data root. The packaged smoke uses a disposable app
identity and deletes its temporary data and test Keychain entries afterward.
No live Google authorization, real Calendar mutation, or personal Codex
authentication is performed by deterministic release tests. Any authenticated
Codex smoke is an explicit local opt-in lane and is never run in CI.

The disposable packaged smoke also records redacted receipts at Qali's owned
process-spawn boundaries: the local backend, deploy CLI, key generator, and
Keychain helper. A receipt contains the executable byte hash/size/mode, argument
classifications and hashes, and environment key classifications/hashes—never
the argument or environment values. The test independently verifies those
executables against the inspected package. The generated local Convex instance
secret is required to occur exactly once in each official backend argument
vector and nowhere in any other owned argument/environment surface; only its
one-way fingerprint is retained in evidence.

Stable release artifacts are Developer ID signed, notarized, stapled, hashed,
and provenance-attested before publication. Update failures are reduced to
bounded error codes/messages; provider URLs, local installer paths, and signing
or notarization credentials are never sent to the renderer or diagnostic logs.
