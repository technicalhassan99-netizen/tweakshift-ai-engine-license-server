import express from 'express'
import cors from 'cors'

const app = express()
const PORT = process.env.PORT || 10000

const FREEMIUS_API_BASE = process.env.FREEMIUS_API_BASE || 'https://api.freemius.com/v1'
const FREEMIUS_PRODUCT_ID = process.env.FREEMIUS_PRODUCT_ID || ''

const GUMROAD_API_BASE = process.env.GUMROAD_API_BASE || 'https://api.gumroad.com/v2'

// Monthly / yearly product
const GUMROAD_PRODUCT_ID = process.env.GUMROAD_PRODUCT_ID || process.env.GUMROAD_PRODUCT_PERMALINK || ''

// Lifetime one-time product
const GUMROAD_LIFETIME_PRODUCT_ID = process.env.GUMROAD_LIFETIME_PRODUCT_ID || ''

app.use(cors({ origin: '*', methods: ['GET', 'POST'] }))
app.use(express.json({ limit: '64kb' }))

function clean(value) {
  return String(value || '').trim()
}

function getGumroadProductIds() {
  const ids = [
    { id: clean(GUMROAD_PRODUCT_ID), type: 'membership' },
    { id: clean(GUMROAD_LIFETIME_PRODUCT_ID), type: 'lifetime' },
  ].filter(item => item.id)

  const unique = []
  for (const item of ids) {
    if (!unique.some(x => x.id === item.id)) unique.push(item)
  }

  return unique
}

function normalizeGumroadLicenseKey(value) {
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
    add(value)

    const compact = normalizeGumroadLicenseKey(value)
    add(compact)
    add(compact.toUpperCase())
  }

  return candidates.filter(Boolean)
}

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

function getByPath(obj, paths) {
  for (const pathKeys of paths) {
    let cur = obj
    let ok = true
    for (const key of pathKeys) {
      if (cur && Object.prototype.hasOwnProperty.call(cur, key)) cur = cur[key]
      else { ok = false; break }
    }
    if (ok && cur !== undefined && cur !== null && cur !== '') return cur
  }
  return null
}

function findDeepValue(obj, wantedKeys) {
  const seen = new Set()
  const stack = [obj]
  while (stack.length) {
    const cur = stack.pop()
    if (!cur || typeof cur !== 'object' || seen.has(cur)) continue
    seen.add(cur)
    for (const [key, value] of Object.entries(cur)) {
      if (wantedKeys.includes(key) && value !== undefined && value !== null && value !== '') return value
      if (value && typeof value === 'object') stack.push(value)
    }
  }
  return null
}

function normalizeStatus(value) {
  return String(value || '').trim().toLowerCase()
}

function freemiusStatusIsInactive(status) {
  return ['expired', 'cancelled', 'canceled', 'inactive', 'disabled', 'deactivated', 'refunded', 'invalid', 'not_found'].includes(normalizeStatus(status))
}

function freemiusDateIsExpired(value) {
  if (!value) return false
  const t = new Date(value).getTime()
  if (!Number.isFinite(t)) return false
  return Date.now() > t
}

function normalizeFreemiusPayload(payload, licenseKey, email, uid, options = {}) {
  const allowTopLevelIdAsInstallId = options.allowTopLevelIdAsInstallId === true
  const installId =
    getByPath(payload, [['install', 'id'], ['install_id']]) ||
    findDeepValue(payload, ['install_id']) ||
    (allowTopLevelIdAsInstallId ? getByPath(payload, [['id']]) : null)

  const licenseId =
    getByPath(payload, [['license', 'id'], ['license_id']]) ||
    findDeepValue(payload, ['license_id']) ||
    (!allowTopLevelIdAsInstallId ? getByPath(payload, [['id']]) : null)

  const rawStatus = normalizeStatus(
    getByPath(payload, [['license', 'status'], ['subscription', 'status'], ['subscription_status'], ['status']]) ||
    findDeepValue(payload, ['subscription_status', 'status'])
  )

  const expiration =
    getByPath(payload, [['license', 'expiration'], ['license', 'expires'], ['license', 'expires_at'], ['expiration'], ['expires_at']]) ||
    findDeepValue(payload, ['expiration', 'expires', 'expires_at', 'expiration_date'])

  const cancelledFlag = payload.is_cancelled === true || findDeepValue(payload, ['is_cancelled', 'isCanceled']) === true
  const refundedFlag = payload.is_refunded === true || findDeepValue(payload, ['is_refunded', 'isRefunded']) === true
  const inactiveFlag = payload.is_active === false || payload.active === false || findDeepValue(payload, ['is_active', 'active']) === false
  const expiredFlag = payload.expired === true || payload.is_expired === true || findDeepValue(payload, ['expired', 'is_expired']) === true
  const dateExpired = freemiusDateIsExpired(expiration)

  const inactive = cancelledFlag || refundedFlag || inactiveFlag || expiredFlag || dateExpired || freemiusStatusIsInactive(rawStatus)
  const status = inactive
    ? (cancelledFlag ? 'cancelled' : refundedFlag ? 'refunded' : inactiveFlag ? 'inactive' : dateExpired || expiredFlag ? 'expired' : rawStatus || 'inactive')
    : (rawStatus || 'active')

  return {
    valid: !inactive,
    active: !inactive,
    success: !inactive,
    final: true,
    licenseKey,
    provider: 'freemius',
    plan: !inactive ? (getByPath(payload, [['plan', 'title'], ['plan', 'name'], ['license', 'plan_title'], ['license', 'plan_name']]) || 'Premium') : 'Locked',
    customerEmail: getByPath(payload, [['user', 'email'], ['customer', 'email'], ['license', 'email'], ['email']]) || email || '',
    expiresAt: parseExpiry(expiration),
    installId: installId || options.previousInstallId || null,
    licenseId: licenseId || options.previousLicenseId || null,
    uid,
    source: 'freemius',
    rawStatus,
    status,
    subscriptionStatus: status,
    error: inactive ? 'Freemius license is inactive, expired, cancelled, refunded, or deactivated.' : undefined,
  }
}

function normalizeFreemiusError(response) {
  const payload = response?.data || {}
  const message = getErrorMessage(payload, response.error || `Freemius returned ${response.status || 0}`)
  const text = String(message || '').toLowerCase()
  const code = String(payload.code || payload.error?.code || payload.error || '').toLowerCase()

  let status = 'invalid'
  if (text.includes('expired') || code.includes('expired')) status = 'expired'
  else if (text.includes('cancel') || code.includes('cancel')) status = 'cancelled'
  else if (text.includes('refund') || code.includes('refund')) status = 'refunded'
  else if (text.includes('inactive') || code.includes('inactive')) status = 'inactive'
  else if (text.includes('deactiv') || code.includes('deactiv')) status = 'deactivated'
  else if (text.includes('not found') || code.includes('not_found') || response.status === 404) status = 'not_found'
  else if (response.status === 403) status = 'invalid'
  else if (!response.status || response.status >= 500) status = 'temporary_error'

  const final = ['expired','cancelled','refunded','inactive','deactivated','not_found','invalid'].includes(status)
  return {
    configured: true,
    valid: false,
    active: false,
    success: false,
    final,
    provider: 'freemius',
    status,
    subscriptionStatus: status,
    error: message,
    freemiusStatus: response.status || 0,
  }
}

async function activateFreemius({ licenseKey, email, machineId }) {
  if (!FREEMIUS_PRODUCT_ID) {
    return { configured: false, final: false, provider: 'freemius', status: 'server_config_error', error: 'Freemius is not configured.' }
  }

  const uid = toFreemiusUid(machineId || email || licenseKey)
  const endpoint =
    `${FREEMIUS_API_BASE.replace(/\/$/, '')}` +
    `/products/${encodeURIComponent(FREEMIUS_PRODUCT_ID)}` +
    `/licenses/activate.json`

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      uid,
      license_key: licenseKey,
      title: machineId ? `TweakShift AI Engine ${String(machineId).slice(0, 8)}` : 'TweakShift AI Engine',
      version: '1.0.0',
      ...(email ? { user_email: email } : {}),
    }),
  })

  const payload = await response.json().catch(() => ({}))

  if (!response.ok) return normalizeFreemiusError({ status: response.status, data: payload })

  const normalized = normalizeFreemiusPayload(payload, licenseKey, email, uid, { allowTopLevelIdAsInstallId: true })
  if (!normalized.valid) return makeInactive(normalized.status, normalized.error, 'freemius', normalized)
  return normalized
}


async function deactivateFreemius({ licenseKey, machineId, installId, uid }) {
  if (!FREEMIUS_PRODUCT_ID) {
    return { configured: false, final: false, provider: 'freemius', status: 'server_config_error', error: 'Freemius is not configured.' }
  }

  const cleanUid = clean(uid) || toFreemiusUid(machineId || licenseKey)
  const cleanInstallId = clean(installId)

  if (!cleanInstallId) {
    return {
      configured: true,
      valid: false,
      active: false,
      success: false,
      final: false,
      provider: 'freemius',
      status: 'missing_install_id',
      subscriptionStatus: 'missing_install_id',
      error: 'This local license record is missing the Freemius install ID. Activate the license once with this updated build, then deactivate it before reinstalling Windows.',
    }
  }

  const endpoint =
    `${FREEMIUS_API_BASE.replace(/\/$/, '')}` +
    `/products/${encodeURIComponent(FREEMIUS_PRODUCT_ID)}` +
    `/licenses/deactivate.json?fields=id%2Cname%2Cslug`

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      uid: cleanUid,
      install_id: cleanInstallId,
      license_key: licenseKey,
    }),
  })

  const payload = await response.json().catch(() => ({}))

  if (!response.ok) return normalizeFreemiusError({ status: response.status, data: payload })

  return {
    valid: true,
    active: false,
    success: true,
    final: true,
    provider: 'freemius',
    status: 'deactivated',
    subscriptionStatus: 'deactivated',
    installId: cleanInstallId,
    uid: cleanUid,
    source: 'freemius',
    message: 'Freemius license deactivated successfully on this PC.',
    payload,
  }
}

async function verifyActiveFreemius({ licenseKey, email, machineId, installId, uid, licenseId }) {
  if (!FREEMIUS_PRODUCT_ID) {
    return { configured: false, final: false, provider: 'freemius', status: 'server_config_error', error: 'Freemius is not configured.' }
  }

  const cleanUid = clean(uid) || toFreemiusUid(machineId || email || licenseKey)
  const cleanInstallId = clean(installId)

  if (!cleanInstallId) {
    return {
      configured: true,
      valid: false,
      active: false,
      success: false,
      final: false,
      provider: 'freemius',
      status: 'missing_install_id',
      subscriptionStatus: 'missing_install_id',
      error: 'Missing Freemius install ID. Ask the user to activate this Freemius license once with the updated build.',
    }
  }

  // Verify endpoint only. This does NOT activate and does NOT consume Freemius device quota.
  const endpoint =
    `${FREEMIUS_API_BASE.replace(/\/$/, '')}` +
    `/products/${encodeURIComponent(FREEMIUS_PRODUCT_ID)}` +
    `/installs/${encodeURIComponent(cleanInstallId)}` +
    `/license.json` +
    `?uid=${encodeURIComponent(cleanUid)}` +
    `&license_key=${encodeURIComponent(licenseKey)}`

  const response = await fetch(endpoint, { method: 'GET', headers: { Accept: 'application/json' } })
  const payload = await response.json().catch(() => ({}))

  if (!response.ok) return normalizeFreemiusError({ status: response.status, data: payload })

  const normalized = normalizeFreemiusPayload(payload, licenseKey, email, cleanUid, {
    allowTopLevelIdAsInstallId: false,
    previousInstallId: cleanInstallId,
    previousLicenseId: licenseId || null,
  })
  if (!normalized.valid) return makeInactive(normalized.status, normalized.error, 'freemius', normalized)
  return normalized
}

async function verifyFreemius({ licenseKey, email, machineId, mode = 'activate', installId = '', uid = '', licenseId = '' }) {
  const action = String(mode || '').toLowerCase()
  if (action === 'activate') {
    return activateFreemius({ licenseKey, email, machineId })
  }
  if (action === 'deactivate') {
    return deactivateFreemius({ licenseKey, machineId, installId, uid })
  }
  return verifyActiveFreemius({ licenseKey, email, machineId, installId, uid, licenseId })
}

function normalizeGumroadResponse(payload, licenseKey, email, productInfo) {
  const purchase = payload.purchase || {}
  const status = String(purchase.subscription_status || purchase.status || '').toLowerCase()

  const refunded = purchase.refunded === true
  const disputed = purchase.disputed === true || purchase.chargebacked === true
  const cancelled =
    purchase.cancelled === true ||
    purchase.subscription_cancelled_at ||
    status === 'cancelled' ||
    status === 'canceled'

  const endedAt = purchase.subscription_ended_at || purchase.ended_at || null
  const failed =
    status === 'failed' ||
    status === 'payment_failed' ||
    status === 'past_due' ||
    status === 'unpaid'

  const ended = endedAt ? new Date(endedAt).getTime() < Date.now() : false

  if (refunded) {
    return makeInactive('refunded', 'This Gumroad purchase was refunded.', 'gumroad', {
      refunded: true,
      gumroadProductType: productInfo.type,
    })
  }

  if (disputed) {
    return makeInactive('disputed', 'This Gumroad purchase is disputed.', 'gumroad', {
      disputed: true,
      gumroadProductType: productInfo.type,
    })
  }

  if (failed) {
    return makeInactive(status, 'This Gumroad membership payment is not active.', 'gumroad', {
      gumroadProductType: productInfo.type,
    })
  }

  // Lifetime product has no subscription ending logic unless refunded/disputed.
  if (productInfo.type !== 'lifetime' && ended) {
    return makeInactive('expired', 'This Gumroad membership has ended.', 'gumroad', {
      expiresAt: parseExpiry(endedAt),
      gumroadProductType: productInfo.type,
    })
  }

  const expiresAt =
    productInfo.type === 'lifetime'
      ? null
      : parseExpiry(endedAt || purchase.subscription_ended_at || purchase.recurrence_end_date || null)

  return {
    valid: payload.success === true,
    active: payload.success === true,
    success: payload.success === true,
    licenseKey,
    provider: 'gumroad',
    plan:
      productInfo.type === 'lifetime'
        ? 'Lifetime'
        : purchase.variants || purchase.variant || purchase.product_name || purchase.product_permalink || 'Premium',
    customerEmail: purchase.email || email || '',
    expiresAt,
    subscriptionStatus:
      productInfo.type === 'lifetime'
        ? 'lifetime'
        : cancelled
          ? 'cancelled_pending_end'
          : status || 'active',
    cancelled: productInfo.type === 'lifetime' ? false : Boolean(cancelled),
    source: 'gumroad-license-api',
    rawStatus: status || null,
    uses: payload.uses || null,
    purchaseId: purchase.id || purchase.sale_id || null,
    productId: productInfo.id,
    gumroadProductType: productInfo.type,
  }
}

async function verifyGumroadCandidate(candidate, productInfo) {
  const body = new URLSearchParams()
  body.set('product_id', productInfo.id)
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
  const productIds = getGumroadProductIds()

  if (!productIds.length) {
    return { configured: false, error: 'Gumroad is not configured.' }
  }

  const originalKey = clean(displayLicenseKey || licenseKey)
  const candidates = getGumroadLicenseCandidates(licenseKey, displayLicenseKey)

  if (!candidates.length) {
    return {
      configured: true,
      valid: false,
      final: false,
      provider: 'gumroad',
      status: 'empty',
      error: 'License key is required.',
    }
  }

  const errors = []

  for (const productInfo of productIds) {
    for (const candidate of candidates) {
      try {
        const { response, payload } = await verifyGumroadCandidate(candidate, productInfo)

        if (response.ok && payload.success === true) {
          const normalized = normalizeGumroadResponse(payload, originalKey || candidate, email, productInfo)

          if (!normalized.valid) return normalized

          return {
            ...normalized,
            licenseKey: originalKey || candidate,
            gumroadMatchedKeyFormat: candidate.includes('-') ? 'dashed' : 'compact',
          }
        }

        const apiError = getErrorMessage(payload, `Gumroad returned ${response.status}`)

        errors.push({
          productType: productInfo.type,
          productIdTail: productInfo.id.slice(-6),
          keyLength: candidate.length,
          keyFormat: candidate.includes('-') ? 'dashed' : 'compact',
          statusCode: response.status,
          error: apiError,
        })

        if (payload.purchase) {
          const inactive = normalizeGumroadResponse(payload, originalKey || candidate, email, productInfo)

          if (
            inactive.final ||
            ['refunded', 'disputed', 'expired'].includes(String(inactive.status || '').toLowerCase())
          ) {
            return inactive
          }
        }
      } catch (err) {
        errors.push({
          productType: productInfo.type,
          productIdTail: productInfo.id.slice(-6),
          keyLength: candidate.length,
          keyFormat: candidate.includes('-') ? 'dashed' : 'compact',
          error: err.message,
        })
      }
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
      : 'License key was not found or is not active.',
    gumroadAttempts: errors,
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
    providers: {
      gumroadConfigured: getGumroadProductIds().length > 0,
      gumroadMembershipConfigured: Boolean(GUMROAD_PRODUCT_ID),
      gumroadLifetimeConfigured: Boolean(GUMROAD_LIFETIME_PRODUCT_ID),
      freemiusConfigured: Boolean(FREEMIUS_PRODUCT_ID),
    },
  })
})

app.post('/api/license/verify', async (req, res) => {
  try {
    const licenseKey = clean(req.body.licenseKey || req.body.license_key)
    const displayLicenseKey = clean(req.body.displayLicenseKey || licenseKey)
    const email = clean(req.body.email)
    const machineId = clean(req.body.machineId || req.body.deviceId || req.body.uid)
    const mode = clean(req.body.mode || 'activate').toLowerCase()
    const installId = clean(req.body.installId || req.body.install_id)
    const uid = clean(req.body.uid)
    const licenseId = clean(req.body.licenseId || req.body.license_id)

    if (!licenseKey) {
      return res.status(400).json({
        valid: false,
        active: false,
        success: false,
        error: 'License key is required.',
      })
    }

    const normalizedForGumroad = normalizeGumroadLicenseKey(displayLicenseKey || licenseKey)
    const gumroadCandidates = getGumroadLicenseCandidates(licenseKey, displayLicenseKey)
    const gumroadLike = looksLikeGumroadLicenseKey(displayLicenseKey || licenseKey)

    console.log('License verify request', {
      rawLength: licenseKey.length,
      displayLength: displayLicenseKey.length,
      gumroadNormalizedLength: normalizedForGumroad.length,
      hasDashes: licenseKey.includes('-') || displayLicenseKey.includes('-'),
      gumroadCandidateLengths: gumroadCandidates.map((key) => key.length),
      gumroadLike,
      gumroadProductsConfigured: getGumroadProductIds().map(item => item.type),
      freemiusConfigured: Boolean(FREEMIUS_PRODUCT_ID),
    })

    const attempts = []

    if (getGumroadProductIds().length > 0) {
      const gumroad = await verifyGumroad({
        licenseKey,
        displayLicenseKey,
        email,
      })

      if (gumroad.valid) {
        gumroad.licenseKey = displayLicenseKey || licenseKey
      }

      attempts.push({
        provider: 'gumroad',
        status: gumroad.status || (gumroad.valid ? 'active' : 'invalid'),
        error: gumroad.error,
        productType: gumroad.gumroadProductType,
        details: gumroad.gumroadAttempts,
      })

      if (gumroad.valid) {
        return res.json(gumroad)
      }

      if (
        gumroad.final &&
        ['refunded', 'disputed', 'expired'].includes(String(gumroad.status || '').toLowerCase())
      ) {
        return res.status(403).json(gumroad)
      }
    }

    if (FREEMIUS_PRODUCT_ID && !gumroadLike) {
      const freemius = await verifyFreemius({
        licenseKey,
        email,
        machineId,
        mode,
        installId,
        uid,
        licenseId,
      })

      attempts.push({
        provider: 'freemius',
        status: freemius.status || (freemius.valid ? 'active' : 'invalid'),
        error: freemius.error,
      })

      if (freemius.success || freemius.valid || (mode === 'deactivate' && freemius.status === 'deactivated')) {
        return res.json(freemius)
      }

      if (mode === 'deactivate' && freemius.status === 'missing_install_id') {
        return res.status(409).json(freemius)
      }

      if (
        freemius.final &&
        ['cancelled', 'canceled', 'expired', 'inactive', 'disabled', 'deactivated', 'refunded', 'invalid', 'not_found'].includes(String(freemius.status || '').toLowerCase())
      ) {
        return res.status(403).json(freemius)
      }
    }

    if (FREEMIUS_PRODUCT_ID && gumroadLike) {
      attempts.push({
        provider: 'freemius',
        status: 'skipped',
        error: 'Skipped because this key matches Gumroad license-key format.',
      })
    }

    if (getGumroadProductIds().length === 0 && !FREEMIUS_PRODUCT_ID) {
      return res.status(500).json({
        valid: false,
        active: false,
        success: false,
        error: 'No license provider is configured on the server.',
      })
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
    return res.status(500).json({
      valid: false,
      active: false,
      success: false,
      transient: true,
      error: err.message || 'Server error during license verification.',
    })
  }
})

app.listen(PORT, () => {
  console.log(`TweakShift license server running on port ${PORT}`)
  console.log('License server patch: Freemius activation/deactivation + Gumroad verification enabled v5')
})
