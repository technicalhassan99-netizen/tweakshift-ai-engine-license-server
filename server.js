import express from 'express'
import cors from 'cors'
import crypto from 'crypto'

const app = express()
const PORT = process.env.PORT || 10000
const APP_SHARED_SECRET = process.env.APP_SHARED_SECRET || ''
const FREEMIUS_API_BASE = process.env.FREEMIUS_API_BASE || ''
const FREEMIUS_PRODUCT_ID = process.env.FREEMIUS_PRODUCT_ID || ''
const FREEMIUS_PUBLIC_KEY = process.env.FREEMIUS_PUBLIC_KEY || ''
const FREEMIUS_SECRET_KEY = process.env.FREEMIUS_SECRET_KEY || ''

app.use(cors({ origin: '*', methods: ['GET', 'POST'] }))
app.use(express.json({ limit: '64kb' }))

function clean(value) {
  return String(value || '').trim()
}

function mask(key) {
  if (!key) return ''
  return key.slice(0, 4) + '...' + key.slice(-4)
}

async function verifyWithFreemius({ licenseKey, email }) {
  if (!FREEMIUS_API_BASE || !FREEMIUS_PRODUCT_ID || !FREEMIUS_SECRET_KEY) {
    throw new Error('Freemius environment variables are not configured on Render yet.')
  }

  // IMPORTANT:
  // Keep Freemius secret keys only on Render, never inside Electron.
  // If your Freemius account gives you a different endpoint/body shape,
  // update only this backend function. The desktop app will not need changes.
  const endpoint = `${FREEMIUS_API_BASE.replace(/\/$/, '')}/products/${FREEMIUS_PRODUCT_ID}/licenses/verify.json`
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${FREEMIUS_SECRET_KEY}`,
      'X-Public-Key': FREEMIUS_PUBLIC_KEY,
    },
    body: JSON.stringify({ license_key: licenseKey, licenseKey, email }),
  })

  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(payload.error || payload.message || `Freemius returned ${response.status}`)
  }
  return payload
}

function normalizeFreemius(payload, licenseKey) {
  const license = payload.license || payload.data || payload
  const subscription = payload.subscription || license.subscription || {}
  const isActive = license.is_active === true || license.active === true || license.status === 'active' || subscription.status === 'active'
  const isExpired = license.expiration && new Date(license.expiration).getTime() < Date.now()

  return {
    valid: Boolean(isActive && !isExpired),
    licenseKey: mask(licenseKey),
    plan: license.plan_name || license.plan || payload.plan || 'Premium',
    customerEmail: license.customer_email || license.email || payload.email || '',
    expiresAt: license.expiration || license.expires_at || subscription.next_payment || null,
    source: 'freemius-render-proxy',
  }
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'tweakshift-license-server' })
})

app.post('/api/license/verify', async (req, res) => {
  try {
    const licenseKey = clean(req.body.licenseKey || req.body.license_key)
    const email = clean(req.body.email)
    if (!licenseKey) return res.status(400).json({ valid: false, error: 'License key is required.' })

    // Optional fallback for local testing only. Remove this block before final public release.
    if (process.env.NODE_ENV !== 'production' && licenseKey === 'TS-DEMO-UNLOCK') {
      return res.json({ valid: true, active: true, plan: 'Premium Dev', customerEmail: email, source: 'local-dev' })
    }

    const payload = await verifyWithFreemius({ licenseKey, email })
    const normalized = normalizeFreemius(payload, licenseKey)
    if (!normalized.valid) return res.status(403).json({ ...normalized, error: 'License is inactive, expired, or not valid for this product.' })
    return res.json({ ...normalized, active: true })
  } catch (err) {
    return res.status(500).json({ valid: false, error: err.message })
  }
})

app.post('/api/webhooks/freemius', (req, res) => {
  // Optional webhook receiver. Use it later to log renewals/cancellations into your own database.
  // Keep APP_SHARED_SECRET in Render and add the same secret to the webhook URL as ?secret=YOUR_SECRET.
  if (APP_SHARED_SECRET && req.query.secret !== APP_SHARED_SECRET) return res.status(401).json({ ok: false })
  const signature = crypto.createHash('sha256').update(JSON.stringify(req.body)).digest('hex')
  console.log('Freemius webhook received:', { signature, type: req.body?.type || req.body?.event })
  res.json({ ok: true })
})

app.listen(PORT, () => console.log(`TweakShift license server running on port ${PORT}`))
