# Server Deployment

This is an experimental, privately installed Bitrix24 application, not a public
Marketplace release. Publishing its source does not provide access to a hosted
instance or other users' calendars.

## Requirements

- Node.js 24 and npm.
- A Bitrix24 application registration with the `calendar` scope.
- A public HTTPS endpoint that Bitrix24 can embed and send installation data to.
- An Apple Account with an app-specific password for CalDAV access.

## Configuration

Install dependencies with `npm ci`. Create a private `.env` using `.env.example`
as a template and configure your application URL, application code,
OAuth client ID and OAuth client secret. Generate a random 32-byte base64 value
for `ENCRYPTION_KEY`, for example:

```sh
openssl rand -base64 32
```

Keep `.env` readable only by the service user. Do not commit it or any runtime
data. The portal and REST endpoint are determined by the installation OAuth
response, not a global portal setting. Use your own application registration
and configuration. `BITRIX_PORTAL`, if retained in an older deployment, is only
a migration hint for records created before multi-portal support.

Run the server behind an HTTPS reverse proxy:

```sh
node --env-file=.env src/server.mjs
```

The service listens on loopback port 8766 by default. Configure your reverse
proxy for the same port. The application launch URL is `/`, and the installation
handler is `/install`. Use a process supervisor such as PM2 or systemd for
automatic restart. If using PM2, save its configuration and configure startup
for the service user.

## Authorization And Data

The application exchanges the launch refresh token with the fixed Bitrix24
OAuth server to verify the member ID and HTTPS REST endpoint before making
portal requests. It then verifies the application code and user profile. Each
account stores its own verified portal and endpoint. Public custom-domain
portals are supported; local/private IP destinations and REST redirects are
rejected. DNS resolution is checked and pinned when establishing each HTTPS
connection. It uses the launching user's OAuth identity, not an incoming webhook.
Settings, Apple app-specific passwords, OAuth tokens and event mappings are
stored per user in `runtime/accounts/*.enc`, encrypted using AES-256-GCM.

Browser sessions expire after 12 hours and are HMAC-signed using a separate
signature context from calendar callbacks. They survive service restarts as
long as the encryption key is unchanged. An expired browser session requires
reopening the application from Bitrix24.

Back up encrypted accounts together with their encryption key in private
storage. Losing the key makes the records unreadable. Losing event mappings
can cause duplicate events. Deleting an application connection does not erase
separately maintained backups.

## Verification

```sh
npm test
```

Check that `/health` returns success and that `/api/status` rejects requests
without a valid browser session. Do not publish authorization headers or logs
containing account credentials.

The optional `scripts/smoke-calendars.mjs --live` test requires explicit opt-in,
exactly one configured account, and valid provider access. It creates temporary
calendars and events in both systems and attempts to remove them afterwards.
It is not a read-only test and should not be part of unattended CI.

## Operational Limits

Lightweight iCloud ctag/sync-token checks run every 5 seconds. Bitrix24 event
notifications debounce for 200 ms and target the affected calendar. A full
fallback scan runs every 30 seconds. Provider failures use retry backoff up to
15 minutes, honoring longer Retry-After cooldowns where supplied.
Automatic mode may be enabled in advance, but no background writes occur until
the selected calendars are applied and their first synchronization is confirmed.

Only selected calendar pairs are processed, from seven days ago through the selected
future horizon. iCloud recurrence instances are imported as individual
copies with source-only title/time updates, including exceptions and reschedules.
Bitrix recurrence instances are expanded by its own API and exported as personal
iCloud copies without attendees or invitations. Their synthetic date keys and real
exception IDs are retained separately. Reverse edits/deletions cannot alter the
Bitrix source series. All-day events, sub-minute timestamps and iCloud invitations are skipped.
Linked event deletions propagate in both directions after explicit ID/resource
checks; missing query results or permission errors never constitute deletion proof.
Deleting a Bitrix recurrence copy excludes only that occurrence in iCloud.
Deletion/edit conflicts and Bitrix meetings with attendees are protected.
Calendar renames and moves between calendars are not synchronized. Simultaneous edits produce conflicts
instead of silently overwriting one side. CalDAV discovery/authorization can
fail even when the application's HTTP health endpoint is healthy.
