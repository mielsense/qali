# Local data, backup, recovery, and uninstall

All stable application files live under:

```text
~/Library/Application Support/Qali/
```

The root contains `database`, `backups`, `exports`, `logs`, `runtime`, `cache`,
and `config` directories. Permissions are restricted to the local macOS user.
Google OAuth material and local signing/admin secrets are separate macOS
Keychain records under service `com.qali.desktop`; they are never included in a
database backup or export.

## Understand the operations

| Operation                   | What it does                                                                                                                | Credentials                            | Recoverability                                                        |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------- |
| Cold backup                 | Copies the complete stopped local Convex state and hashes every file                                                        | Excluded                               | Restorable only by a compatible Qali build after verification         |
| List backups                | Returns only complete backups whose manifests and file hashes verify                                                        | Unchanged                              | Read-only                                                             |
| Restore                     | Stages and verifies one compatible backup, swaps the database, health-checks it, and rolls back on failure                  | Unchanged                              | Prior database stays available until the restored database verifies   |
| JSON export                 | Saves readable calendars, events, and pending-operation summaries chosen through a native save dialog                       | Excluded                               | Reference/portability copy; it is not a Qali database restore image   |
| Reset                       | Creates a verified backup, moves the exact Qali root to a timestamped quarantine, and deletes Qali's exact Keychain records | Deleted                                | Quarantine and backup remain recoverable until you remove them        |
| Disconnect a Google account | Stops that account's sync, best-effort revokes its token, and clears its credential                                         | Selected Google account record deleted | Every local calendar/queue stays on disk; other accounts keep syncing |
| Remove the app              | Deletes only `/Applications/Qali.app`                                                                                       | Unchanged                              | Data and Keychain survive reinstall                                   |
| Full uninstall              | Removes the app, Qali data root, and Qali Keychain records                                                                  | Deleted                                | Not recoverable unless you kept an external copy/export               |

Open **Settings → System & recovery** to export local data, list verified
backups, restore a selected backup, reset Qali's local data, or check for a
software update. Restore and reset require confirmation and a restart. Provider
credentials are excluded from backups and exports. Do not use DevTools or call
the preload bridge manually.

## Make a safe personal backup now

1. Quit Qali completely. A copy made while its local database is running is not
   a supported cold backup.
2. In Finder choose **Go → Go to Folder…** and enter
   `~/Library/Application Support/`.
3. Copy the whole `Qali` folder to an encrypted local disk or other private
   location. Keep the directory intact; do not copy just a `.sqlite` file.
4. If you need Google synchronization after restoring onto a fresh login
   Keychain, reconnect through Qali. The copied folder intentionally does not
   contain the OAuth refresh token.

Qali also creates a verified internal snapshot before a schema/deployment
upgrade when an existing database build marker changes. Those snapshots are
under `Qali/backups/<backup-id>/` and include a `backup-manifest.json`. Do not
edit their contents.

## Restore a cold Finder copy

Open **Settings → System & recovery**, choose a verified backup, and confirm
**Restore**. Qali stages and verifies the backup, replaces the local database,
and tells you when a restart is required. If the automated path rejects the
backup, preserve both roots and the error evidence rather than replacing
database internals manually. Never merge two database directories or restore
only SQLite/WAL fragments.

## Reset and quarantine

The implemented reset is deliberately recoverable: it first verifies a cold
backup, moves the stable root beside itself as a directory named like
`Qali.quarantine-<timestamp>`, then removes only Qali's exact allowlisted
Keychain records (the local service secrets, eight fixed Google account slots,
and compatibility-era legacy Google records). Use **Reset local data** in
**System & recovery**; do not simulate reset by deleting individual database
files. For an operator-only fallback, quit Qali, move the entire root to a
private quarantine name, remove only the Qali Keychain items in Keychain Access,
and reopen. Keep the quarantine until the new calendar works.

## Uninstall

For an app-only uninstall, quit Qali and move `/Applications/Qali.app` to the
Trash. This leaves local calendars, queued operations, backups, logs, and
Keychain credentials in place for a reinstall.

For a full uninstall:

1. Disconnect each Google account in Qali while online, then confirm the app is quit.
2. Optionally make the cold backup above.
3. Move `/Applications/Qali.app` to the Trash.
4. Move `~/Library/Application Support/Qali/` to the Trash.
5. In Keychain Access, search for service `com.qali.desktop` and remove only
   its records. Current Google accounts use the fixed names
   `google-account-v2-0` through `google-account-v2-7`; compatibility releases
   may also retain `google-oauth-client-config`, `google-refresh-token`, and
   `google-account-metadata`. The local service records include
   `convex-instance-root-secret`, `convex-admin-credential`, and
   `local-jwt-signing-key`.
6. If Google revocation could not run, remove Qali Local from your Google
   Account's [third-party connections](https://support.google.com/accounts/answer/13533235).

Emptying the Trash or deleting the Keychain records makes that part of the
uninstall non-recoverable. Never remove the broader Application Support folder
or unrelated Keychain entries.
