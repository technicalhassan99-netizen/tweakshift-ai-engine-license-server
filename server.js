import express from 'express'
import cors from 'cors'

const app = express()
const PORT = process.env.PORT || 10000

const FREEMIUS_API_BASE =
  process.env.FREEMIUS_API_BASE || 'https://api.freemius.com/v1'

const FREEMIUS_PRODUCT_ID = process.env.FREEMIUS_PRODUCT_ID || ''

app.use(cors({ origin: '*', methods: ['GET', 'POST'] }))
app.use(express.json({ limit: '64kb' }))

function clean(value) {
  return String(value || '').trim()
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

function normalizeActivation(payload, licenseKey, email, uid) {
  const license = payload.license || payload.data || payload

  const isCancelled =
    license.is_cancelled === true ||
    license.cancelled === true ||
    license.status === 'cancelled'

  const expiration = license.expiration || license.expires_at || null

  let isExpired = false

  if (expiration) {
    const expiryDate = new Date(String(expiration).replace(' ', 'T')).getTime()
    isExpired = !Number.isNaN(expiryDate) && expiryDate < Date.now()
  }

  const isActive =
    !isCancelled &&
    !isExpired &&
    (
      license.is_active === true ||
      license.active === true ||
      license.status === 'active' ||
      Boolean(payload.install_id || license.install_id)
    )

  return {
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
    installId: payload.install_id || license.install_id || null,
    installApiToken: payload.install_api_token || license.install_api_token || null,
    uid,
    source: 'freemius-activation-api',
    rawStatus: license.status || payload.status || null,
  }
}

app.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'tweakshift-license-server',
    status: 'running',
  })
})

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'tweakshift-license-server',
    productConfigured: Boolean(FREEMIUS_PRODUCT_ID),
  })
})

app.post('/api/license/verify', async (req, res) => {
  try {
    const licenseKey = clean(req.body.licenseKey || req.body.license_key)
    const email = clean(req.body.email)
    const machineId = clean(req.body.machineId || req.body.uid)

    if (!FREEMIUS_PRODUCT_ID) {
      return res.status(500).json({
        valid: false,
        active: false,
        error: 'FREEMIUS_PRODUCT_ID is not configured on Render.',
      })
    }

    if (!licenseKey) {
      return res.status(400).json({
        valid: false,
        active: false,
        error: 'License key is required.',
      })
    }

    const uid = toFreemiusUid(machineId || email || licenseKey)

    const endpoint =
      `${FREEMIUS_API_BASE.replace(/\/$/, '')}` +
      `/products/${encodeURIComponent(FREEMIUS_PRODUCT_ID)}` +
      `/licenses/activate.json` +
      `?uid=${encodeURIComponent(uid)}` +
      `&license_key=${encodeURIComponent(licenseKey)}`

    const response = await fetch(endpoint, {
      method: 'POST',
    })

    const payload = await response.json().catch(() => ({}))

    if (!response.ok) {
      return res.status(response.status).json({
        valid: false,
        active: false,
        error: getErrorMessage(payload, `Freemius returned ${response.status}`),
        freemiusStatus: response.status,
      })
    }

    const normalized = normalizeActivation(payload, licenseKey, email, uid)

    if (!normalized.valid) {
      return res.status(403).json({
        ...normalized,
        error: 'License is inactive, expired, cancelled, or not valid for this product.',
      })
    }

    return res.json(normalized)
  } catch (err) {
    return res.status(500).json({
      valid: false,
      active: false,
      error: err.message || 'Server error during license activation.',
    })
  }
})

app.listen(PORT, () => {
  console.log(`TweakShift license server running on port ${PORT}`)
})