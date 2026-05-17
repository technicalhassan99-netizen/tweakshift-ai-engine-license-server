# TweakShift Hybrid License Server

Deploy this folder as a Render Web Service.

This server now supports two license providers:

1. **Gumroad** for new monthly/yearly/lifetime customers.
2. **Freemius** for existing users so old customers are not affected.

The desktop app calls this server from:

```txt
electron/licenseManager.js
```

Default endpoint:

```txt
https://tweakshift-ai-engine-license-server.onrender.com/api/license/verify
```

## Required environment variables

### Gumroad new users

```txt
GUMROAD_PRODUCT_ID=your_gumroad_product_id_or_permalink
```

The server verifies Gumroad keys through:

```txt
https://api.gumroad.com/v2/licenses/verify
```

It checks refunded, disputed, cancelled, failed/unpaid, and ended memberships.

### Freemius existing users

Keep these variables configured so existing Freemius customers keep working:

```txt
FREEMIUS_API_BASE=https://api.freemius.com/v1
FREEMIUS_PRODUCT_ID=your_freemius_product_id
FREEMIUS_PUBLIC_KEY=your_public_key
FREEMIUS_SECRET_KEY=your_secret_key
```

The current Freemius flow uses the product license activation endpoint.

## App-side protection

The desktop app verifies the saved license every time the app opens.

If Render is sleeping or verification times out:

- The app keeps the user’s last verified Premium state temporarily.
- First retry happens after 30 seconds.
- Second retry happens after 2 minutes.
- Premium stays available for up to 72 hours after the last successful verification.
- After 7 days without successful verification, Premium locks until the server verifies again.

This avoids interrupting real paying users while Render wakes up, but still removes access for expired/refunded/cancelled users when verification succeeds.


## Gumroad license key format

Gumroad may display license keys with dashes, for example `XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX`. The server normalizes Gumroad keys by removing spaces and dashes before calling Gumroad's verify API, while keeping Freemius keys unchanged for existing users.
