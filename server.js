import express from 'express'
import cors from 'cors'

const app = express()
const PORT = process.env.PORT || 10000

const FREEMIUS_API_BASE = process.env.FREEMIUS_API_BASE || 'https://api.freemius.com/v1'
const FREEMIUS_PRODUCT_ID = process.env.FREEMIUS_PRODUCT_ID || ''

const GUMROAD_API_BASE = process.env.GUMROAD_API_BASE || 'https://api.gumroad.com/v2'
const GUMROAD_PRODUCT_ID = process.env.GUMROAD_PRODUCT_ID || process.env.GUMROAD_PRODUCT_PERMALINK || ''

app.use(cors({ origin: '*', methods: ['GET', 'POST'] }))
app.use(express.json({ limit: '64kb' }))

function clean(value) {
  return String(value || '').trim()
}

function normalizeGumroadLicenseKey(value) {
<<<<<<< HEAD
  // Gumroad API accepts a 32-character license_key.
  // Gumroad dashboard/emails may show the key with dashes, like:
  // XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX (35 chars including dashes).
  // We keep Freemius keys unchanged, but send Gumroad keys without spaces/dashes.
  return clean(value).replace(/[\s-]/g, '')
}

=======
  return clean(value).replace(/[\s-]/g, '')
}

function looksLikeGumroadLicenseKey(value) {
  const raw = clean(value)
  const compact = normalizeGumroadLicenseKey(raw)
  return /^[a-fA-F0-9]{32}$/.test(compact) && (raw.includes('-') || compact.length === 32)
}

function getGumroadLicenseCandidates(licenseKey, displayLicenseKey) {
  const values = [displayLicenseKey, licenseKey]
    .map(clean)
    .filter(Boolean)

  const candidates = []
  const add = (value) => {
    const cleaned = clean(value)
    if (!cleaned) return
    if (cleaned.length > 80) return
    if (!candidates.includes(cleaned)) candidates.push(cleaned)
  }

  for (const value of values) {
    // Try the exact key first. Some Gumroad receipts/dashboard views include dashes.
    add(value)
    // Then try the compact 32-char format. This covers Gumroad keys copied without dashes.
    const compact = normalizeGumroadLicenseKey(value)
    add(compact)
    add(compact.toUpperCase())
  }

  return candidates.filter(Boolean)
}

>>>>>>> c0459be (Fix Gumroad raw and dashed license verification)
function toFreemiusUid(machineId = '') {
  const cleaned = clean(machineId).replace(/[^a-zA-Z0-9]/g, '')
  if (cleaned.length >= 32) return cleaned.slice(0, 32)
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

function parseExpiry(value) {
  if (!value) return null
  const normalized = String(value).replace(' ', 'T')
  const ts = new Date(normalized).getTime()
  return Number.isNaN(ts) ? null : new Date(ts).toISOString()
}

function makeInactive(status, message, provider, extra = {}) {
  return {
    valid: false,
    active: false,
    success: false,
    final: true,
    provider,
    status,
    error: message,
    ...extra,
  }
}

function normalizeFreemiusActivation(payload, licenseKey, email, uid) {
  const license = payload.license || payload.data || payload

  const status = String(license.status || payload.status || '').toLowerCase()
  const isCancelled =
    license.is_cancelled === true ||
    license.cancelled === true ||
    status === 'cancelled' ||
    status === 'canceled'

  const expiration = license.expiration || license.expires_at || null
  const expiresAt = parseExpiry(expiration)
  const isExpired = expiresAt ? new Date(expiresAt).getTime() < Date.now() : false

  const isActive =
    !isCancelled &&
    !isExpired &&
    (
      license.is_active === true ||
      license.active === true ||
      status === 'active' ||
      Boolean(payload.install_id || license.install_id)
    )

  return {
    valid: Boolean(isActive),
    active: Boolean(isActive),
    success: Boolean(isActive),
    licenseKey,
    provider: 'freemius',
    plan: license.plan_name || license.plan || payload.plan || 'Premium',
    customerEmail: license.customer_email || license.email || payload.email || email || '',
    expiresAt,
    installId: payload.install_id || license.install_id || null,
    installApiToken: payload.install_api_token || license.install_api_token || null,
    uid,
    source: 'freemius-activation-api',
    rawStatus: license.status || payload.status || null,
    status: isActive ? 'active' : isCancelled ? 'cancelled' : isExpired ? 'expired' : status || 'inactive',
<<<<<<< HEAD
  }
}

async function verifyFreemius({ licenseKey, email, machineId }) {
  if (!FREEMIUS_PRODUCT_ID) {
    return { configured: false, error: 'Freemius is not configured.' }
  }

  const uid = toFreemiusUid(machineId || email || licenseKey)
  const endpoint =
    `${FREEMIUS_API_BASE.replace(/\/$/, '')}` +
    `/products/${encodeURIComponent(FREEMIUS_PRODUCT_ID)}` +
    `/licenses/activate.json` +
    `?uid=${encodeURIComponent(uid)}` +
    `&license_key=${encodeURIComponent(licenseKey)}`

  const response = await fetch(endpoint, { method: 'POST' })
  const payload = await response.json().catch(() => ({}))

  if (!response.ok) {
    return {
      configured: true,
      valid: false,
      final: response.status === 403 || response.status === 404,
      provider: 'freemius',
      status: 'invalid',
      error: getErrorMessage(payload, `Freemius returned ${response.status}`),
      freemiusStatus: response.status,
    }
  }

  const normalized = normalizeFreemiusActivation(payload, licenseKey, email, uid)
  if (!normalized.valid) {
    return makeInactive(normalized.status, 'Freemius license is inactive, expired, cancelled, or not valid for this product.', 'freemius', normalized)
  }

  return normalized
}

function normalizeGumroadResponse(payload, licenseKey, email) {
  const purchase = payload.purchase || {}
  const status = String(purchase.subscription_status || purchase.status || '').toLowerCase()

  const refunded = purchase.refunded === true
  const disputed = purchase.disputed === true || purchase.chargebacked === true
  const cancelled = purchase.cancelled === true || purchase.subscription_cancelled_at || status === 'cancelled' || status === 'canceled'
  const endedAt = purchase.subscription_ended_at || purchase.ended_at || null
  const failed = status === 'failed' || status === 'payment_failed' || status === 'past_due' || status === 'unpaid'
  const ended = endedAt ? new Date(endedAt).getTime() < Date.now() : false

  if (refunded) return makeInactive('refunded', 'This Gumroad purchase was refunded.', 'gumroad', { refunded: true })
  if (disputed) return makeInactive('disputed', 'This Gumroad purchase is disputed.', 'gumroad', { disputed: true })
  if (failed) return makeInactive(status, 'This Gumroad membership payment is not active.', 'gumroad')
  if (ended) return makeInactive('expired', 'This Gumroad membership has ended.', 'gumroad', { expiresAt: parseExpiry(endedAt) })

  // For memberships, cancelled can mean it will stop renewing later. If it already has ended_at, we lock above.
  const expiresAt = parseExpiry(endedAt || purchase.subscription_ended_at || purchase.recurrence_end_date || null)

  return {
    valid: payload.success === true,
    active: payload.success === true,
    success: payload.success === true,
    licenseKey,
    provider: 'gumroad',
    plan: purchase.variants || purchase.variant || purchase.product_name || purchase.product_permalink || 'Premium',
    customerEmail: purchase.email || email || '',
    expiresAt,
    subscriptionStatus: cancelled ? 'cancelled_pending_end' : status || 'active',
    cancelled: Boolean(cancelled),
    source: 'gumroad-license-api',
    rawStatus: status || null,
    uses: payload.uses || null,
    purchaseId: purchase.id || purchase.sale_id || null,
    productId: purchase.product_id || GUMROAD_PRODUCT_ID || null,
  }
}

async function verifyGumroad({ licenseKey, email }) {
  if (!GUMROAD_PRODUCT_ID) {
    return { configured: false, error: 'Gumroad is not configured.' }
  }

  const originalKey = clean(licenseKey)
  const gumroadKey = normalizeGumroadLicenseKey(originalKey)

  if (!gumroadKey) {
    return { configured: true, valid: false, final: false, provider: 'gumroad', status: 'empty', error: 'License key is required.' }
  }

  if (gumroadKey.length > 32) {
    return {
      configured: true,
      valid: false,
      final: false,
      provider: 'gumroad',
      status: 'invalid_format',
      error: 'This does not look like a valid Gumroad license key. Please copy the full key from your Gumroad receipt or library.',
    }
  }

  const body = new URLSearchParams()
  body.set('product_id', GUMROAD_PRODUCT_ID)
  body.set('license_key', gumroadKey)
  body.set('increment_uses_count', 'false')

  const response = await fetch(`${GUMROAD_API_BASE.replace(/\/$/, '')}/licenses/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })

  const payload = await response.json().catch(() => ({}))

  if (!response.ok || payload.success !== true) {
    const apiError = getErrorMessage(payload, `Gumroad returned ${response.status}`)
    return {
      configured: true,
      valid: false,
      final: response.status === 404,
      provider: 'gumroad',
      status: 'invalid',
      error: apiError.includes('limited to 32 characters')
        ? 'Gumroad rejected the license format because the server sent more than 32 characters. Redeploy the latest server.js and try again. Dashes are supported in the app.'
        : apiError,
      gumroadStatus: response.status,
    }
  }

  // Save/display the original key the customer entered, but verify Gumroad with the normalized 32-character key.
  const normalized = normalizeGumroadResponse(payload, originalKey, email)
  if (!normalized.valid) return normalized
  return normalized
}

=======
  }
}

async function verifyFreemius({ licenseKey, email, machineId }) {
  if (!FREEMIUS_PRODUCT_ID) {
    return { configured: false, error: 'Freemius is not configured.' }
  }

  const uid = toFreemiusUid(machineId || email || licenseKey)
  const endpoint =
    `${FREEMIUS_API_BASE.replace(/\/$/, '')}` +
    `/products/${encodeURIComponent(FREEMIUS_PRODUCT_ID)}` +
    `/licenses/activate.json` +
    `?uid=${encodeURIComponent(uid)}` +
    `&license_key=${encodeURIComponent(licenseKey)}`

  const response = await fetch(endpoint, { method: 'POST' })
  const payload = await response.json().catch(() => ({}))

  if (!response.ok) {
    return {
      configured: true,
      valid: false,
      final: response.status === 403 || response.status === 404,
      provider: 'freemius',
      status: 'invalid',
      error: getErrorMessage(payload, `Freemius returned ${response.status}`),
      freemiusStatus: response.status,
    }
  }

  const normalized = normalizeFreemiusActivation(payload, licenseKey, email, uid)
  if (!normalized.valid) {
    return makeInactive(normalized.status, 'Freemius license is inactive, expired, cancelled, or not valid for this product.', 'freemius', normalized)
  }

  return normalized
}

function normalizeGumroadResponse(payload, licenseKey, email) {
  const purchase = payload.purchase || {}
  const status = String(purchase.subscription_status || purchase.status || '').toLowerCase()

  const refunded = purchase.refunded === true
  const disputed = purchase.disputed === true || purchase.chargebacked === true
  const cancelled = purchase.cancelled === true || purchase.subscription_cancelled_at || status === 'cancelled' || status === 'canceled'
  const endedAt = purchase.subscription_ended_at || purchase.ended_at || null
  const failed = status === 'failed' || status === 'payment_failed' || status === 'past_due' || status === 'unpaid'
  const ended = endedAt ? new Date(endedAt).getTime() < Date.now() : false

  if (refunded) return makeInactive('refunded', 'This Gumroad purchase was refunded.', 'gumroad', { refunded: true })
  if (disputed) return makeInactive('disputed', 'This Gumroad purchase is disputed.', 'gumroad', { disputed: true })
  if (failed) return makeInactive(status, 'This Gumroad membership payment is not active.', 'gumroad')
  if (ended) return makeInactive('expired', 'This Gumroad membership has ended.', 'gumroad', { expiresAt: parseExpiry(endedAt) })

  // For memberships, cancelled can mean it will stop renewing later. If it already has ended_at, we lock above.
  const expiresAt = parseExpiry(endedAt || purchase.subscription_ended_at || purchase.recurrence_end_date || null)

  return {
    valid: payload.success === true,
    active: payload.success === true,
    success: payload.success === true,
    licenseKey,
    provider: 'gumroad',
    plan: purchase.variants || purchase.variant || purchase.product_name || purchase.product_permalink || 'Premium',
    customerEmail: purchase.email || email || '',
    expiresAt,
    subscriptionStatus: cancelled ? 'cancelled_pending_end' : status || 'active',
    cancelled: Boolean(cancelled),
    source: 'gumroad-license-api',
    rawStatus: status || null,
    uses: payload.uses || null,
    purchaseId: purchase.id || purchase.sale_id || null,
    productId: purchase.product_id || GUMROAD_PRODUCT_ID || null,
  }
}

async function verifyGumroadCandidate(candidate, email) {
  const body = new URLSearchParams()
  body.set('product_id', GUMROAD_PRODUCT_ID)
  body.set('license_key', candidate)
  body.set('increment_uses_count', 'false')

  const response = await fetch(`${GUMROAD_API_BASE.replace(/\/$/, '')}/licenses/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })

  const payload = await response.json().catch(() => ({}))
  return { response, payload }
}

async function verifyGumroad({ licenseKey, displayLicenseKey, email }) {
  if (!GUMROAD_PRODUCT_ID) {
    return { configured: false, error: 'Gumroad is not configured.' }
  }

  const originalKey = clean(displayLicenseKey || licenseKey)
  const candidates = getGumroadLicenseCandidates(licenseKey, displayLicenseKey)

  if (!candidates.length) {
    return { configured: true, valid: false, final: false, provider: 'gumroad', status: 'empty', error: 'License key is required.' }
  }

  const errors = []

  for (const candidate of candidates) {
    try {
      const { response, payload } = await verifyGumroadCandidate(candidate, email)

      if (response.ok && payload.success === true) {
        const normalized = normalizeGumroadResponse(payload, originalKey || candidate, email)
        if (!normalized.valid) return normalized
        return {
          ...normalized,
          licenseKey: originalKey || candidate,
          gumroadMatchedKeyFormat: candidate.includes('-') ? 'dashed' : 'compact',
        }
      }

      const apiError = getErrorMessage(payload, `Gumroad returned ${response.status}`)
      errors.push({
        keyLength: candidate.length,
        keyFormat: candidate.includes('-') ? 'dashed' : 'compact',
        statusCode: response.status,
        error: apiError,
      })

      // Refunded/disputed/expired responses should be final if Gumroad returns purchase metadata.
      if (payload.purchase) {
        const inactive = normalizeGumroadResponse(payload, originalKey || candidate, email)
        if (inactive.final || ['refunded', 'disputed', 'expired'].includes(String(inactive.status || '').toLowerCase())) return inactive
      }
    } catch (err) {
      errors.push({ keyLength: candidate.length, keyFormat: candidate.includes('-') ? 'dashed' : 'compact', error: err.message })
    }
  }

  const firstError = errors[0]?.error || 'License key was not found or is not active.'
  return {
    configured: true,
    valid: false,
    final: true,
    provider: 'gumroad',
    status: 'invalid',
    error: firstError.includes('limited to 32 characters')
      ? 'Gumroad rejected this license format. Please copy the full key exactly from the Gumroad receipt or library.'
      : firstError,
    gumroadAttempts: errors,
  }
}

>>>>>>> c0459be (Fix Gumroad raw and dashed license verification)
app.get('/', (_req, res) => {
  res.json({ ok: true, service: 'tweakshift-license-server', status: 'running' })
})

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'tweakshift-license-server',
    providers: {
      gumroadConfigured: Boolean(GUMROAD_PRODUCT_ID),
      freemiusConfigured: Boolean(FREEMIUS_PRODUCT_ID),
    },
  })
})

app.post('/api/license/verify', async (req, res) => {
  try {
    const licenseKey = clean(req.body.licenseKey || req.body.license_key)
    const displayLicenseKey = clean(req.body.displayLicenseKey || licenseKey)
    const email = clean(req.body.email)
    const machineId = clean(req.body.machineId || req.body.uid)

    if (!licenseKey) {
      return res.status(400).json({ valid: false, active: false, success: false, error: 'License key is required.' })
    }

<<<<<<< HEAD
    const normalizedForGumroad = normalizeGumroadLicenseKey(licenseKey)
    console.log('License verify request', {
      rawLength: licenseKey.length,
      gumroadNormalizedLength: normalizedForGumroad.length,
      hasDashes: licenseKey.includes('-'),
=======
    const normalizedForGumroad = normalizeGumroadLicenseKey(displayLicenseKey || licenseKey)
    const gumroadCandidates = getGumroadLicenseCandidates(licenseKey, displayLicenseKey)
    const gumroadLike = looksLikeGumroadLicenseKey(displayLicenseKey || licenseKey)
    console.log('License verify request', {
      rawLength: licenseKey.length,
      displayLength: displayLicenseKey.length,
      gumroadNormalizedLength: normalizedForGumroad.length,
      hasDashes: licenseKey.includes('-') || displayLicenseKey.includes('-'),
      gumroadCandidateLengths: gumroadCandidates.map(k => k.length),
      gumroadLike,
>>>>>>> c0459be (Fix Gumroad raw and dashed license verification)
      gumroadConfigured: Boolean(GUMROAD_PRODUCT_ID),
      freemiusConfigured: Boolean(FREEMIUS_PRODUCT_ID),
    })

    const attempts = []

    // New users: Gumroad first. Existing users: Freemius fallback remains active.
    if (GUMROAD_PRODUCT_ID) {
<<<<<<< HEAD
      const gumroad = await verifyGumroad({ licenseKey: normalizedForGumroad, email })
      if (gumroad.valid) gumroad.licenseKey = displayLicenseKey || licenseKey
      attempts.push({ provider: 'gumroad', status: gumroad.status || (gumroad.valid ? 'active' : 'invalid'), error: gumroad.error })
=======
      const gumroad = await verifyGumroad({ licenseKey, displayLicenseKey, email })
      if (gumroad.valid) gumroad.licenseKey = displayLicenseKey || licenseKey
      attempts.push({ provider: 'gumroad', status: gumroad.status || (gumroad.valid ? 'active' : 'invalid'), error: gumroad.error, details: gumroad.gumroadAttempts })
>>>>>>> c0459be (Fix Gumroad raw and dashed license verification)
      if (gumroad.valid) return res.json(gumroad)
      if (gumroad.final && ['refunded', 'disputed', 'expired'].includes(String(gumroad.status || '').toLowerCase())) {
        return res.status(403).json(gumroad)
      }
    }

<<<<<<< HEAD
    if (FREEMIUS_PRODUCT_ID) {
=======
    if (FREEMIUS_PRODUCT_ID && !gumroadLike) {
>>>>>>> c0459be (Fix Gumroad raw and dashed license verification)
      const freemius = await verifyFreemius({ licenseKey, email, machineId })
      attempts.push({ provider: 'freemius', status: freemius.status || (freemius.valid ? 'active' : 'invalid'), error: freemius.error })
      if (freemius.valid) return res.json(freemius)
      if (freemius.final && ['cancelled', 'canceled', 'expired', 'inactive'].includes(String(freemius.status || '').toLowerCase())) {
        return res.status(403).json(freemius)
      }
    }

<<<<<<< HEAD
=======
    if (FREEMIUS_PRODUCT_ID && gumroadLike) {
      attempts.push({ provider: 'freemius', status: 'skipped', error: 'Skipped because this key matches Gumroad license-key format.' })
    }

>>>>>>> c0459be (Fix Gumroad raw and dashed license verification)
    if (!GUMROAD_PRODUCT_ID && !FREEMIUS_PRODUCT_ID) {
      return res.status(500).json({ valid: false, active: false, success: false, error: 'No license provider is configured on the server.' })
    }

    return res.status(404).json({
      valid: false,
      active: false,
      success: false,
      final: true,
      status: 'invalid',
      error: 'License key was not found or is not active.',
      attempts,
    })
  } catch (err) {
    return res.status(500).json({ valid: false, active: false, success: false, transient: true, error: err.message || 'Server error during license verification.' })
  }
})

app.listen(PORT, () => {
  console.log(`TweakShift license server running on port ${PORT}`)
<<<<<<< HEAD
console.log('License server patch: Gumroad dash-normalization enabled v2')
=======
  console.log('License server patch: Gumroad raw+dashed verification enabled v3')
>>>>>>> c0459be (Fix Gumroad raw and dashed license verification)
})
