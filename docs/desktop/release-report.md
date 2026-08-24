# Desktop release verification evidence

**Audience:** maintainers and release operators  
**Owner:** Qali maintainers  
**Status:** current  
**Canonical sources:** `scripts/desktop/verify-app.ts`,
`scripts/desktop/smoke-packaged.ts`, and `scripts/desktop/release-macos.ts`

Qali separates deterministic local packaging evidence from signed release
evidence. A successful local package does not imply Developer ID signing or
notarization; those claims belong only to the protected macOS release lane.

## Local package evidence

`bun run desktop:verify-app` inspects the exact app bundle and writes ignored
evidence under `dist/`. It records the source revision, bridge version, resource
and ASAR inventories, executable identities, architecture, signatures, bundle
digest, and bounded verifier results. The packaged smoke runs a separately
signed disposable clone with disposable state and test Keychain entries.

The verifier rejects credentials, home/source paths, development servers,
source maps, tests, undeclared executable code, architecture mismatches,
unexpected resources, and renderer/native authority leaks. Process-boundary
receipts contain hashes and classifications rather than raw arguments,
environment values, credentials, event content, or assistant prompts.

## Signed release evidence

The protected release lane writes these additional records beside the final
DMG, ZIP, blockmaps, and updater metadata:

- `bundle-evidence.json`: signing identities, Team ID, entitlements,
  notarization/stapling/Gatekeeper results, bundle digest, and contract version;
- `release-evidence.json`: tag, version, architecture, notarization request ID,
  artifact inventory, updater metadata validation, and release-script version;
- `SHA256SUMS.txt`: SHA-256 for every public candidate artifact.

GitHub adds an artifact provenance attestation before the candidate crosses into
the separately approved publication job. Publication downloads and hashes the
same bytes and refuses to overwrite an existing release.

## Evidence interpretation

- `passed` means the recorded command/scenario completed against the named
  bundle or artifact.
- `not run` remains explicit for authenticated Google/Codex and clean-profile
  install/update exercises.
- Evidence from another commit, package version, tag, app digest, or bridge
  version is not transferable.
- Rebuilding, changing, resigning, or restapling a candidate invalidates earlier
  artifact hashes and requires new evidence.

The complete operational sequence and rollback rules are in
[`release-macos.md`](release-macos.md).
