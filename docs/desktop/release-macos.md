# Release Qali for macOS

**Audience:** release operators  
**Owner:** Qali maintainers  
**Status:** current  
**Canonical sources:** `.github/workflows/release-macos.yml`,
`scripts/desktop/release-macos.ts`, and `electron-builder.release.yml`  
**Review when:** signing identity, notarization, updater provider, artifacts, or
GitHub environments change

This runbook creates one immutable Apple Silicon candidate, signs every exact
code object with Developer ID, notarizes and staples the app, produces updater-
compatible ZIP and DMG assets, attests them, and publishes the same bytes.

## Authority and protected configuration

Creating a tag or GitHub release, changing repository secrets, or approving a
protected environment is an external mutation and requires maintainer authority.
Configure these only in the `macos-release-candidate` environment:

### Secrets

- `MACOS_CERTIFICATE_BASE64`
- `MACOS_CERTIFICATE_PASSWORD`
- `APPLE_API_PRIVATE_KEY_BASE64`
- `APPLE_API_KEY_ID`
- `APPLE_API_ISSUER`
- `QALI_GOOGLE_OAUTH_CLIENT_SECRET`

### Variables

- `APPLE_TEAM_ID`
- `QALI_MACOS_SIGNING_IDENTITY` (the exact `Developer ID Application: …` name)

The `github-release` environment controls publication approval. Never put a
secret in source, workflow arguments, screenshots, release evidence, or logs.

## Preflight

1. Confirm `main` is green and the package version in
   `apps/desktop/package.json` matches the intended stable tag `vX.Y.Z`.
2. Confirm the release Google Desktop OAuth client is in production or has the
   intended test-user policy and that the Calendar API/scopes are configured.
3. Confirm the Developer ID certificate, Team ID, and App Store Connect API key
   belong to the same release authority.
4. Confirm both protected environments require the intended reviewers.
5. Run focused local verification without using live application data:

   ```bash
   bun install --frozen-lockfile
   bun run check-types
   bun run test
   bun run desktop:package
   bun run desktop:verify-app
   bun run desktop:smoke-packaged
   ```

The local package is an ad-hoc candidate for deterministic validation. It is not
a substitute for the CI signing/notarization lane.

## Create the candidate

Push an annotated stable tag that exactly matches the desktop version. The
tag-only workflow:

1. checks out the exact tag without persisted credentials;
2. installs the frozen Bun dependency graph;
3. imports the certificate into a temporary Keychain;
4. writes the App Store Connect key to a mode-0600 temporary file;
5. runs `bun run desktop:release:mac`;
6. signs deepest code first without `--deep`, verifies the Team ID, notarizes,
   staples, validates, and runs Gatekeeper checks;
7. builds the final ZIP and DMG from that verified app;
8. verifies updater SHA-512 values and sizes, then writes `SHA256SUMS.txt` and
   structured bundle/release evidence;
9. creates a GitHub artifact provenance attestation;
10. uploads the exact candidate for the publication job.

Expected public files are:

```text
Qali-X.Y.Z-arm64.dmg
Qali-X.Y.Z-arm64.dmg.blockmap
Qali-X.Y.Z-arm64.zip
Qali-X.Y.Z-arm64.zip.blockmap
latest-mac.yml
SHA256SUMS.txt
bundle-evidence.json
release-evidence.json
```

The release script refuses unexpected files, rejected notarization, wrong
architecture/team/tag, invalid updater metadata, changed package inputs, or a
dirty/noncanonical candidate.

## Publish and verify

After candidate approval, the publication job downloads the exact artifact,
checks `SHA256SUMS.txt`, refuses to overwrite an existing release, and creates a
GitHub release without rebuilding. After publication:

1. verify the release assets and provenance attestation in GitHub;
2. install the DMG on a clean Apple Silicon test profile;
3. launch, connect a nonproduction Google account, sync, create/edit/delete one
   event, and confirm restart persistence;
4. update from the previous supported version and confirm the update dialog,
   coordinated restart, data preservation, and current version;
5. Force Quit once, relaunch, and confirm Qali reclaims only its verified orphan
   local service;
6. record the release URL, notarization request ID, smoke version, and any
   skipped authenticated checks.

## Failure and rollback

- Before publication, reject the candidate and fix forward; never replace files
  inside it or reuse evidence from another commit.
- If notarization, signing, metadata, or checksum validation fails, rotate only
  the affected credential when compromise is suspected, then create a new tag
  and immutable candidate.
- Never overwrite a published release asset. Publish a new patch version.
- Durable local data is not downgraded automatically. If a release writes an
  incompatible schema, stop rollout and ship a forward-compatible fix using the
  verified backup/restore path.
- A broken update feed can be withdrawn by publishing corrected metadata/assets
  under a new version; the application itself never accepts a renderer-supplied
  feed or installer path.
