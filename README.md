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
