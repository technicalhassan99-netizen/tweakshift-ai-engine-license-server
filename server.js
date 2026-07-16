import express from 'express'
import cors from 'cors'

const app = express()
const PORT = process.env.PORT || 10000

const FREEMIUS_API_BASE =
  process.env.FREEMIUS_API_BASE || 'https://api.freemius.com/v1'

// Supports both old and new Render variable names.
const FREEMIUS_PRODUCT_ID =
  process.env.FREEMIUS_PRODUCT_ID ||
  process.env.FREEMIUS_AI_PRODUCT_ID ||
  ''

const APP_SHARED_SECRET = process.env.APP_SHARED_SECRET || ''
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || process.env.FRONTEND_URL || '')
  .split(',')
  .map((origin) => origin.trim().replace(/\/$/, ''))
  .filter(Boolean)

app.use(cors({
  origin(origin, callback) {
    // Electron/native app requests often send no Origin. Allow those.
    if (!origin) return callback(null, true)

    const normalizedOrigin = origin.replace(/\/$/, '')

    // If no allow-list is configured, keep legacy behavior and allow all.
    // For production web use, set ALLOWED_ORIGINS=https://tweakshift.com
    if (!ALLOWED_ORIGINS.length) return callback(null, true)

    if (ALLOWED_ORIGINS.includes(normalizedOrigin)) return callback(null, true)

    return callback(new Error('Origin not allowed by CORS'))
  },
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-app-secret'],
}))

app.use(express.json({ limit: '64kb' }))

function clean(value) {
  return String(value || '').trim()
}

function mask(value = '') {
  const str = clean(value)
  if (!str) return ''
  if (str.length <= 8) return 'configured'
  return `${str.slice(0, 4)}...${str.slice(-4)}`
}

function toFreemiusUid(machineId = '') {
  const cleaned = clean(machineId).replace(/[^a-zA-Z0-9]/g, '')

  if (cleaned.length >= 32) {
    return cleaned.slice(0, 32)
  }

  return cleaned.padEnd(32, '0').slice(0, 32)
}

function getErrorMessage(payload, fallback = 'License request failed.') {
  if (!payload) return fallback

  if (typeof payload.error === 'string') return payload.error
  if (payload.error?.message) return payload.error.message
  if (payload.message) return payload.message
  if (payload.error_description) return payload.error_description

  return fallback
}

function isRequestAuthorized(req) {
  // Compatibility mode: if APP_SHARED_SECRET is not set on Render, do not block old app builds.
  if (!APP_SHARED_SECRET) return true

  const providedSecret = clean(
    req.headers['x-app-secret'] ||
    req.headers.authorization?.replace(/^Bearer\s+/i, '') ||
    req.body?.appSecret ||
    req.body?.app_secret
  )

  return providedSecret && providedSecret === APP_SHARED_SECRET
}

function requireAppSecret(req, res, next) {
  if (isRequestAuthorized(req)) return next()

  return res.status(401).json({
    valid: false,
    active: false,
    success: false,
    error: 'Unauthorized request.',
    message: 'This request could not be verified. Please update TweakShift and try again.',
  })
}

function parseExpiry(expiration) {
  if (!expiration) return null
  const expiryDate = new Date(String(expiration).replace(' ', 'T')).getTime()
  return Number.isNaN(expiryDate) ? null : expiryDate
}

function normalizeActivation(payload, licenseKey, email, uid) {
  const license = payload.license || payload.data || payload

  const isCancelled =
    license.is_cancelled === true ||
    license.cancelled === true ||
    license.status === 'cancelled'

  const expiration = license.expiration || license.expires_at || null
  const expiryTime = parseExpiry(expiration)
  const isExpired = Boolean(expiryTime && expiryTime < Date.now())

  const installId = payload.install_id || license.install_id || null
  const installApiToken = payload.install_api_token || license.install_api_token || null

  const isActive =
    !isCancelled &&
    !isExpired &&
    (
      license.is_active === true ||
      license.active === true ||
      license.status === 'active' ||
      Boolean(installId)
    )

  return {
    success: Boolean(isActive),
    valid: Boolean(isActive),
    active: Boolean(isActive),
    licenseKey,
    plan:
      license.plan_name ||
      license.plan ||
      payload.plan ||
      'Premium',
    customerEmail:
      license.customer_email ||
      license.email ||
      payload.email ||
      email ||
      '',
    expiresAt: expiration,
    installId,
    installApiToken,
    uid,
    source: 'freemius-activation-api',
    rawStatus: license.status || payload.status || null,
  }
}

async function readJsonResponse(response) {
  const text = await response.text().catch(() => '')
  if (!text) return {}

  try {
    return JSON.parse(text)
  } catch (_err) {
    return { message: text }
  }
}

app.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'tweakshift-ai-engine-legacy-license-server',
    status: 'running',
    mode: 'legacy-fallback',
  })
})

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'tweakshift-ai-engine-legacy-license-server',
    status: 'running',
    mode: 'legacy-fallback',
    productConfigured: Boolean(FREEMIUS_PRODUCT_ID),
    productId: mask(FREEMIUS_PRODUCT_ID),
    sharedSecretEnabled: Boolean(APP_SHARED_SECRET),
    allowedOriginsConfigured: ALLOWED_ORIGINS.length > 0,
  })
})

// Legacy endpoint used by older AI Engine builds.
// Important: this endpoint activates the license on Freemius because old builds expect verify to unlock access.
app.post('/api/license/verify', requireAppSecret, async (req, res) => {
  try {
    const licenseKey = clean(req.body.licenseKey || req.body.license_key || req.body.key)
    const email = clean(req.body.email)
    const machineId = clean(req.body.machineId || req.body.machine_id || req.body.uid || req.body.deviceId)

    if (!FREEMIUS_PRODUCT_ID) {
      return res.status(500).json({
        success: false,
        valid: false,
        active: false,
        error: 'FREEMIUS_PRODUCT_ID or FREEMIUS_AI_PRODUCT_ID is not configured on Render.',
        message: 'License server setup is incomplete. Please contact TweakShift support.',
      })
    }

    if (!licenseKey) {
      return res.status(400).json({
        success: false,
        valid: false,
        active: false,
        error: 'License key is required.',
        message: 'Please enter your TweakShift AI Engine license key.',
      })
    }

    const uid = toFreemiusUid(machineId || email || licenseKey)

    const endpoint =
      `${FREEMIUS_API_BASE.replace(/\/$/, '')}` +
      `/products/${encodeURIComponent(FREEMIUS_PRODUCT_ID)}` +
      `/licenses/activate.json` +
      `?uid=${encodeURIComponent(uid)}` +
      `&license_key=${encodeURIComponent(licenseKey)}`

    const response = await fetch(endpoint, { method: 'POST' })
    const payload = await readJsonResponse(response)

    if (!response.ok) {
      return res.status(response.status).json({
        success: false,
        valid: false,
        active: false,
        error: getErrorMessage(payload, `Freemius returned ${response.status}`),
        message: getErrorMessage(payload, 'We could not activate this license. Please check the key and try again.'),
        freemiusStatus: response.status,
      })
    }

    const normalized = normalizeActivation(payload, licenseKey, email, uid)

    if (!normalized.valid) {
      return res.status(403).json({
        ...normalized,
        error: 'License is inactive, expired, cancelled, or not valid for this product.',
        message: 'This license is not active for TweakShift AI Engine.',
      })
    }

    return res.json({
      ...normalized,
      message: 'License activated successfully.',
    })
  } catch (err) {
    return res.status(500).json({
      success: false,
      valid: false,
      active: false,
      error: err.message || 'Server error during license activation.',
      message: 'Something went wrong while checking your license. Please try again.',
    })
  }
})

// Optional legacy deactivation endpoint for old builds or support tools.
app.post('/api/license/deactivate', requireAppSecret, async (req, res) => {
  try {
    const installId = clean(req.body.installId || req.body.install_id)
    const installApiToken = clean(req.body.installApiToken || req.body.install_api_token)

    if (!FREEMIUS_PRODUCT_ID) {
      return res.status(500).json({
        success: false,
        error: 'FREEMIUS_PRODUCT_ID or FREEMIUS_AI_PRODUCT_ID is not configured on Render.',
        message: 'License server setup is incomplete. Please contact TweakShift support.',
      })
    }

    if (!installId || !installApiToken) {
      return res.status(400).json({
        success: false,
        error: 'install_id and install_api_token are required.',
        message: 'This device does not have enough license data to deactivate automatically.',
      })
    }

    const endpoint =
      `${FREEMIUS_API_BASE.replace(/\/$/, '')}` +
      `/products/${encodeURIComponent(FREEMIUS_PRODUCT_ID)}` +
      `/installs/${encodeURIComponent(installId)}/deactivate.json` +
      `?install_api_token=${encodeURIComponent(installApiToken)}`

    const response = await fetch(endpoint, { method: 'POST' })
    const payload = await readJsonResponse(response)

    if (!response.ok) {
      return res.status(response.status).json({
        success: false,
        error: getErrorMessage(payload, `Freemius returned ${response.status}`),
        message: getErrorMessage(payload, 'We could not deactivate this device. Please try again.'),
        freemiusStatus: response.status,
      })
    }

    return res.json({
      success: true,
      message: 'Device deactivated successfully.',
      payload,
    })
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err.message || 'Server error during license deactivation.',
      message: 'Something went wrong while deactivating this device. Please try again.',
    })
  }
})

app.use((_req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found.',
  })
})

app.listen(PORT, () => {
  console.log(`TweakShift AI Engine legacy license server running on port ${PORT}`)
})
