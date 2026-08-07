# TweakShift AI Engine Legacy License Server

This is the legacy fallback license server for older TweakShift AI Engine builds that still use license-key activation.

The new account/login system should use the main auth API instead. Keep this service online during migration so old users do not break.

## Render setup

Build Command:

```bash
npm install
```

Start Command:

```bash
npm start
```

## Required environment variables

Use either the old names or the new AI-specific names.

Required:

```env
FREEMIUS_API_BASE=https://api.freemius.com/v1
FREEMIUS_PRODUCT_ID=29310
```

or:

```env
FREEMIUS_API_BASE=https://api.freemius.com/v1
FREEMIUS_AI_PRODUCT_ID=29310
```

Optional:

```env
APP_SHARED_SECRET=your-secret-here
ALLOWED_ORIGINS=https://tweakshift.com
PORT=10000
```

Important: If you set `APP_SHARED_SECRET`, old desktop builds must send the same secret with `x-app-secret` or `Authorization: Bearer ...`. If old builds do not send it, leave this variable empty for compatibility.

## Endpoints

Health:

```http
GET /health
```

Legacy activate/verify:

```http
POST /api/license/verify
Content-Type: application/json

{
  "licenseKey": "XXXX-XXXX-XXXX-XXXX",
  "email": "customer@example.com",
  "machineId": "stable-machine-id"
}
```

Legacy deactivate:

```http
POST /api/license/deactivate
Content-Type: application/json

{
  "installId": "123",
  "installApiToken": "token-from-activation"
}
```

## Notes

- `/api/license/verify` activates the license on Freemius because older app builds expect this endpoint to unlock access.
- Do not use this as the primary account login system.
- For the new login/account flow, use `tweakshift-auth-api`.

## Desktop notification feed

This repository now includes a read-only notification feed for TweakShift AI Engine. Notifications are managed in `notifications.json` and exposed at:

`GET /api/notifications`

No new Render environment variable is required for the notification feed. Edit `notifications.json`, commit the change to GitHub, and let Render auto-deploy the service.

Each notification supports:

- `id`: unique stable ID. Never reuse an ID for a different message.
- `title` / `message`: user-facing copy.
- `type`: `update`, `info`, `premium`, `warning`, `maintenance`, or `bug`.
- `audience`: `all`, `free`, or `premium`.
- `priority`: `low`, `normal`, `high`, or `critical`.
- `active`: set to `true` to publish.
- `createdAt`: ISO timestamp used for sorting and relative time.
- `expiresAt`: optional ISO timestamp; expired messages are automatically hidden.
- `ctaLabel` / `ctaUrl`: optional HTTPS link shown in the desktop notification.
- `minVersion` / `maxVersion`: optional app-version targeting.

The sample notifications are intentionally shipped with `active: false` so a test message is not accidentally published to production users.

