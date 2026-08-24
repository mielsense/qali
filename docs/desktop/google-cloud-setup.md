# Connect Qali to Google Calendar

Qali uses a direct Google Calendar API connection. Your calendar database and
sync queue stay on this Mac; Convex Cloud is not involved. A single Qali
installation can connect up to eight Google accounts. Each account keeps an
independent credential, sync worker, calendar namespace, and offline queue.

Released builds own one Google Desktop OAuth client credential. There is no JSON
download or import step, and Qali never asks an end user to configure OAuth. The
repository retains only the public client ID; the release build injects the
installed-app client-secret value from `QALI_GOOGLE_OAUTH_CLIENT_SECRET` into
the signed application resource and removes the temporary build input. A fresh
install writes only the refresh token and connected-account metadata to macOS
Keychain under the service `com.qali.desktop`.

An upgrade from an older development build can temporarily retain that build's
legacy imported OAuth-client record in Keychain. Qali never sends or logs its
client-secret field. It removes the record only after verifying a same-account
migration; on incomplete credentials or a client-ID mismatch, it keeps the
record so the user can recover explicitly instead of silently losing access.

## Release-owner Google Cloud configuration

The following Google Cloud steps are for the Qali release owner, not each Qali
user. People installing Qali proceed directly to **Connect in Qali** below.

### 1. Create a project and enable Calendar

1. Sign in to the [Google Cloud console](https://console.cloud.google.com/)
   with the Google account you intend to use.
2. Use the project picker, choose **New project**, name it `Qali Local`, and
   create/select it.
3. Leave the project unlinked from billing. Qali never attaches billing or
   requests paid quota.
4. Open **APIs & Services → Library**, find **Google Calendar API**, and choose
   **Enable**. Google's current API-enablement instructions are
   [here](https://developers.google.com/workspace/guides/enable-apis).

No other Google Workspace API is required. In particular, do not enable or add
Contacts, People, Gmail, or Drive access for Qali.

### 2. Configure Google Auth Platform

Open [Google Auth Platform](https://console.cloud.google.com/auth/overview) for
the selected project and choose **Get started** if it is new.

1. Under **Branding**, set the app name to `Qali Local`, select your email as
   the user-support email, and add your email as the developer contact. A logo
   and public website are not required for this private setup.
2. Under **Audience**, choose:
   - **External** for a personal Gmail account, or for any account not confined
     to your own Google Workspace organization.
   - **Internal** only when the project belongs to a Google Cloud organization
     and every account that will connect is a member of that organization.
3. If the External app is in **Testing**, add every Google account that will be
   connected under **Test users**.
4. Under **Data Access**, choose **Add or remove scopes** and add exactly these
   five scopes:

   ```text
   openid
   https://www.googleapis.com/auth/userinfo.email
   https://www.googleapis.com/auth/calendar.calendarlist.readonly
   https://www.googleapis.com/auth/calendar.events
   https://www.googleapis.com/auth/calendar.freebusy
   ```

   Qali requests the standard `email` OpenID shorthand, which Google treats as
   the `userinfo.email` scope shown in the console. The Calendar scope meanings
   are listed in Google's [Calendar authorization
   reference](https://developers.google.com/workspace/calendar/api/auth).

Google documents the current Auth Platform pages and labels under
[Get started](https://support.google.com/cloud/answer/15544987),
[Audience](https://support.google.com/cloud/answer/15549945), and
[Data Access](https://support.google.com/cloud/answer/15549135).

#### Testing or In production

External apps in **Testing** accept at most 100 named test users. Because Qali
requests Calendar scopes and offline access, Google expires a test user's grant
and refresh token seven days after consent. Reconnect Qali after seven days, or
use **Audience → Publish app** to move the app to **In production**.

Public Qali releases must use an **In production** External audience and
complete Google's applicable verification and domain-ownership requirements
before distribution. Prepare the public Qali homepage, privacy policy, terms,
support contact, verified/authorized domain, scope justifications, and an
unlisted demonstration video before submitting. Google's current details are
in [Manage App Audience](https://support.google.com/cloud/answer/15549945),
[Submit for verification](https://support.google.com/cloud/answer/13461325),
and [Using OAuth 2.0](https://developers.google.com/identity/protocols/oauth2).

### 3. Create the release desktop client

1. Open **Google Auth Platform → Clients**.
2. Choose **Create client**.
3. Select application type **Desktop app** — not Web application.
4. Name it `Qali on Mac` and create it.
5. Put only its `client_id` in
   `apps/desktop/resources/google-oauth-client.json`, and supply its
   `client_secret` to the release process as
   `QALI_GOOGLE_OAUTH_CLIENT_SECRET`. The build validates both values, writes a
   mode-0600 temporary input, packages the strict two-key resource, and removes
   that temporary input even when the builder fails.

Desktop applications are public OAuth clients: the installed-app value labelled
client secret cannot be kept confidential in a distributed app. Qali includes
it only because this Google client requires it during authorization-code and
refresh-token exchange; it is never exposed to the renderer, logs, diagnostics,
or user settings. See Google's [OAuth client
guide](https://support.google.com/cloud/answer/15549257).

This one Desktop client supports every Qali user and every Google account they
connect. Do not create a client per person or per account. Keep a separate
Google Cloud project/client for development and testing so test users and
experimental scopes cannot change the production consent configuration.

## Connect in Qali

1. Open Qali.
2. Open **Settings → Calendars & Google** and choose **Add Google account**.
3. Your normal browser opens. Select the account you want to connect,
   review the five permissions, and approve them.
4. Return to Qali after the browser says it is connected. Click the sync
   control once if the first sync has not started.

Repeat **Add Google account** for another account. Qali deliberately asks
Google to show the account chooser each time. Reauthorizing an account that is
already connected repairs/rotates that account instead of creating a duplicate.
At eight accounts, Add is disabled until one account is disconnected.

Qali listens for the OAuth return only on a temporary `127.0.0.1` port. Do not
add a hand-written redirect URI; a Google **Desktop app** client permits this
loopback flow.

## Offline use and sync speed

Calendar reads and changes are immediate against the local database. With no
Wi-Fi, create/edit/delete operations remain queued on this Mac. When Qali is
open and connectivity returns, it wakes the sync worker automatically; the
sync control can also request a run. Qali applies bounded retries and Google
rate-limit backoff, so a temporary API limit can delay a change without losing
it. Qali does not sync while the app is closed.

Google currently lists standard Calendar API use at no additional cost, with
10,000 requests per minute per project, 600 per minute per user/project, and a
1,000,000-request daily threshold before future charges could apply later in 2026. One personal calendar should remain far below those limits. You do not
need to attach billing or purchase quota; do not request a quota increase.
Google can change these terms, so the authoritative page is the current
[Calendar API usage-limits guide](https://developers.google.com/workspace/calendar/api/guides/quota).

## Disconnect, revoke, repair, or remove an account

- **Disconnect one account:** open **Settings → Calendars & Google**, find the
  account, and choose **Disconnect**. If that account has unsynced changes,
  Qali warns that they will remain local. It drains only that account's worker
  and clears only that account's local credential; online revocation is
  best-effort. Other accounts keep syncing.
- **Revoke at Google:** visit your Google Account's
  [third-party connections](https://support.google.com/accounts/answer/13533235),
  find Qali Local, and remove its access. Qali then pauses the intact queue and
  requires reconnection.
- **Release client change:** install a reviewed Qali release containing the new
  public client ID. Existing credentials remain intact until Qali verifies a
  matching migration or asks you to recover. If an incomplete legacy record
  still has independently valid account metadata and a matching client marker,
  choose **Reconnect Google**; Qali replaces it only after the browser returns
  the same account subject. The same rule applies to an account-only modern
  Keychain tuple even when no legacy marker exists. If only a refresh token
  remains, account metadata is corrupt, Qali otherwise cannot establish the
  stored identity, or the client marker is corrupt or mismatched, choose
  **Clear old Google authorization** first. That recovery-only action appears
  only when Qali cannot safely associate legacy credentials with an account;
  it best-effort revokes distinct old grants and clears the legacy records
  while preserving local calendars and queues. Qali never silently discards or
  crosses an existing account boundary.
- **Repair one account:** choose **Reconnect** on that account. Qali uses the
  account as a login hint and accepts the new grant only if Google's immutable
  subject matches the account being repaired.
