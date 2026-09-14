# TweakShift License Server

This folder is the production Render service used by TweakShift AI Engine 1.2.3. It supports the current desktop license-validation contract, legacy Freemius customers, Gumroad customers, notifications, and protected Key Sounds delivery.

## Render configuration

- Root directory: repository root
- Build command: `npm ci`
- Start command: `npm start`
- Node.js: 18 or newer

Keep the existing production environment variables when redeploying. Do not commit API secrets, bearer tokens, or private keys to this repository.

## License providers

### Gumroad

```txt
GUMROAD_PRODUCT_ID=your_gumroad_product_id_or_permalink
```

Gumroad keys are checked through Gumroad's license API. The server rejects refunded, disputed, cancelled, failed, unpaid, and ended memberships.

### Freemius

Keep these values configured so existing Freemius customers continue to work:

```txt
FREEMIUS_API_BASE=https://api.freemius.com/v1
FREEMIUS_PRODUCT_ID=your_freemius_product_id
FREEMIUS_PUBLIC_KEY=your_public_key
FREEMIUS_SECRET_KEY=your_secret_key
```

The desktop app may supply its Freemius installation identity through the protected native-app request headers expected by `server.js`. Do not expose these credentials in browser code or logs.

## HTTP endpoints

```txt
GET  /health
POST /api/license/verify
POST /api/license/validate
GET  /api/key-sounds/catalog
GET  /api/key-sounds/download/:packId
GET  /api/key-sounds/health
```

`/api/license/validate` performs a non-activating validation for routine startup checks. `/api/license/verify` remains available for activation and compatibility flows.

## Security and access

Native desktop requests without an `Origin` header are supported. Browser-origin requests are restricted to the production TweakShift sites by default. Additional trusted origins can be provided through `ALLOWED_ORIGINS` as a comma-separated list.

The service also applies request-size limits, field-length validation, rate limiting, security headers, and upstream request timeouts.

## Key Sounds private GitHub delivery

Recommended environment variables:

```txt
KEY_SOUNDS_GITHUB_APP_ID=4640897
KEY_SOUNDS_GITHUB_CLIENT_ID=Iv23liOrgT4gqDMIUYwQ
KEY_SOUNDS_GITHUB_OWNER=technicalhassan99-netizen
KEY_SOUNDS_GITHUB_REPO=TweakShift-KeySounds-Private
KEY_SOUNDS_RELEASE_TAG=keysounds-v1.0.0
KEY_SOUNDS_GITHUB_PRIVATE_KEY_PATH=/etc/secrets/tweakshift-sound-delivery.pem
```

In Render Dashboard, add a secret file named `tweakshift-sound-delivery.pem` and paste the GitHub App private-key PEM into that secret file. Never commit the PEM or bundle it into the desktop app.

## Verification

Before deploying:

```bash
npm ci
npm run check
npm audit
```

After Render deploys, confirm that `/health` responds successfully, then verify one real authorized account or license through the desktop application. Local tests without the production provider secrets can verify validation and routing, but cannot complete a real provider entitlement check.

## Anonymous Live Analytics (WordPress dashboard)

TweakShift desktop clients send an anonymous heartbeat to this Render service. The service forwards only the anonymous installation/session IDs, app version, event type, and Free/Premium tier to the private TweakShift WordPress analytics plugin.

Add these Render environment variables after installing the WordPress plugin:

```txt
TWEAKSHIFT_TELEMETRY_WP_URL=https://tweakshift.com/wp-json/tweakshift/v1/telemetry/heartbeat
TWEAKSHIFT_TELEMETRY_SECRET=<copy from WordPress > TS Live Analytics>
```

Optional:

```txt
TWEAKSHIFT_TELEMETRY_TIMEOUT_MS=7000
```

Endpoints:

```txt
GET  /api/telemetry/health
POST /api/telemetry/heartbeat
```

The shared telemetry secret must never be committed to GitHub and must never be bundled into the desktop application. It belongs only in Render Environment and the WordPress plugin settings generated on activation.
