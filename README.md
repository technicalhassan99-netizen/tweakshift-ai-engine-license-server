# TweakShift Render License Server

Deploy this folder as a Render Web Service.

Build Command:

```bash
npm install
```

Start Command:

```bash
npm start
```

Required environment variables on Render:

- `FREEMIUS_API_BASE`
- `FREEMIUS_PRODUCT_ID`
- `FREEMIUS_PUBLIC_KEY`
- `FREEMIUS_SECRET_KEY`
- `APP_SHARED_SECRET` optional webhook secret

After deployment, copy the Render URL and update this file in the desktop app:

```js
electron/licenseManager.js
```

Replace:

```js
https://YOUR-RENDER-APP.onrender.com/api/license/verify
```

with:

```js
https://your-real-render-app.onrender.com/api/license/verify
```
