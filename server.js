import express from 'express'
import cors from 'cors'
import crypto from 'crypto'
import fs from 'fs'
import { Readable } from 'stream'

const app = express()
const PORT = process.env.PORT || 10000

const FREEMIUS_API_BASE = process.env.FREEMIUS_API_BASE || 'https://api.freemius.com/v1'
const FREEMIUS_PRODUCT_ID = process.env.FREEMIUS_PRODUCT_ID || process.env.FREEMIUS_AI_PRODUCT_ID || ''

const GUMROAD_API_BASE = process.env.GUMROAD_API_BASE || 'https://api.gumroad.com/v2'

// Monthly / yearly product
const GUMROAD_PRODUCT_ID = process.env.GUMROAD_PRODUCT_ID || process.env.GUMROAD_PRODUCT_PERMALINK || ''

// Lifetime one-time product
const GUMROAD_LIFETIME_PRODUCT_ID = process.env.GUMROAD_LIFETIME_PRODUCT_ID || ''

// Optional manual fallback keys for older Payhip/manual distribution.
// Add comma/newline separated keys in Render env:
// PAYHIP_LICENSE_KEYS=KEY1,KEY2
// LEGACY_LICENSE_KEYS=KEY3,KEY4
const PAYHIP_LICENSE_KEYS = process.env.PAYHIP_LICENSE_KEYS || ''
const LEGACY_LICENSE_KEYS = process.env.LEGACY_LICENSE_KEYS || ''

app.use(cors({ origin: '*', methods: ['GET', 'POST'] }))
app.use(express.json({ limit: '64kb' }))

function clean(value) {
  return String(value || '').trim()
}

function normalizeManualKey(value = '') {
  return clean(value).replace(/\s+/g, '').toUpperCase()
}

function getManualLicenseKeys() {
  return `${PAYHIP_LICENSE_KEYS}\n${LEGACY_LICENSE_KEYS}`
    .split(/[\n,;]+/)
    .map(normalizeManualKey)
    .filter(Boolean)
}

function verifyManualLicenseKey({ licenseKey, displayLicenseKey, email }) {
  const keys = getManualLicenseKeys()
  if (!keys.length) return { configured: false }

  const candidateValues = [licenseKey, displayLicenseKey]
    .map(normalizeManualKey)
    .filter(Boolean)

  const matched = candidateValues.find((candidate) => keys.includes(candidate))
  if (!matched) {
    return {
      configured: true,
      valid: false,
      active: false,
      success: false,
      final: false,
      provider: 'manual',
      status: 'not_found',
      error: 'License key was not found in the supported license list.',
    }
  }

  return {
    configured: true,
    valid: true,
    active: true,
    success: true,
    final: true,
    provider: 'manual',
    source: 'manual-license-list',
    status: 'active',
    subscriptionStatus: 'active',
    plan: 'Premium',
    licenseKey: displayLicenseKey || licenseKey,
    customerEmail: email || '',
  }
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
    plan: !inactive ? (getByPath(payload, [['plan', 'title'], ['plan', 'name'], ['license', 'plan_title'], ['license', 'plan_name'], ['license_plan_name']]) || 'Premium') : 'Locked',
    customerEmail: getByPath(payload, [['user', 'email'], ['customer', 'email'], ['license', 'email'], ['user_email'], ['email']]) || email || '',
    expiresAt: parseExpiry(expiration),
    installId: installId || options.previousInstallId || null,
    licenseId: licenseId || options.previousLicenseId || null,
    uid,
    installApiToken: getByPath(payload, [['install_api_token'], ['install', 'api_token'], ['install', 'token']]) || options.previousInstallApiToken || null,
    source: 'freemius',
    rawStatus,
    status,
    subscriptionStatus: status,
    error: inactive ? 'This license is inactive, expired, cancelled, refunded, or deactivated.' : undefined,
  }
}

function normalizeFreemiusError(response) {
  const payload = response?.data || {}
  const message = getErrorMessage(payload, response.error || `The license provider returned ${response.status || 0}`)
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
    return { configured: false, final: false, provider: 'freemius', status: 'server_config_error', error: 'This license provider is not configured.' }
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


async function deactivateFreemius({ licenseKey, machineId, installId, uid, installApiToken }) {
  if (!FREEMIUS_PRODUCT_ID) {
    return { configured: false, final: false, provider: 'freemius', status: 'server_config_error', error: 'This license provider is not configured.' }
  }

  const cleanUid = clean(uid) || toFreemiusUid(machineId || licenseKey)
  const cleanInstallId = clean(installId)
  const cleanInstallApiToken = clean(installApiToken)
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

  const apiBase = FREEMIUS_API_BASE.replace(/\/$/, '')
  const body = {
    uid: cleanUid,
    install_id: /^\d+$/.test(cleanInstallId) ? Number(cleanInstallId) : cleanInstallId,
    license_key: licenseKey,
  }

  // Current Freemius install-token endpoint. This releases the install/quota when install_api_token is available.
  // Older fallback endpoints remain below for compatibility with earlier saved records.
  const endpoints = [
    ...(cleanInstallApiToken ? [`${apiBase}/products/${encodeURIComponent(FREEMIUS_PRODUCT_ID)}/installs/${encodeURIComponent(cleanInstallId)}/deactivate.json?install_api_token=${encodeURIComponent(cleanInstallApiToken)}`] : []),
    `${apiBase}/products/${encodeURIComponent(FREEMIUS_PRODUCT_ID)}/licenses/deactivate.json?fields=id%2Cname%2Cslug%2Cinstall_id`,
    `${apiBase}/plugins/${encodeURIComponent(FREEMIUS_PRODUCT_ID)}/deactivate.json`,
  ]

  let lastError = null

  for (const endpoint of endpoints) {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    })

    const payload = await response.json().catch(() => ({}))

    if (response.ok) {
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
        message: 'License deactivated successfully on this PC.',
        payload,
      }
    }

    lastError = normalizeFreemiusError({ status: response.status, data: payload })

    // Only try the LiteSDK fallback when the product endpoint itself is unavailable.
    // Real license problems like invalid key/quota/install mismatch should not be retried as a different success path.
    if (![404, 405].includes(response.status)) break
  }

  return lastError || {
    configured: true,
    valid: false,
    active: false,
    success: false,
    final: false,
    provider: 'freemius',
    status: 'deactivation_failed',
    error: 'License deactivation failed.',
  }
}

async function verifyActiveFreemius({ licenseKey, email, machineId, installId, uid, licenseId }) {
  if (!FREEMIUS_PRODUCT_ID) {
    return { configured: false, final: false, provider: 'freemius', status: 'server_config_error', error: 'This license provider is not configured.' }
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

async function verifyFreemius({ licenseKey, email, machineId, mode = 'activate', installId = '', uid = '', licenseId = '', installApiToken = '' }) {
  const action = String(mode || '').toLowerCase()
  if (action === 'activate') {
    return activateFreemius({ licenseKey, email, machineId })
  }
  if (action === 'deactivate') {
    return deactivateFreemius({ licenseKey, machineId, installId, uid, installApiToken })
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
      manualKeysConfigured: getManualLicenseKeys().length > 0,
    },
  })
})


async function handleFreemiusDeactivateRequest(req, res) {
  try {
    const licenseKey = clean(req.body.licenseKey || req.body.license_key || req.body.key)
    const email = clean(req.body.email || req.body.user_email)
    const machineId = clean(req.body.machineId || req.body.deviceId || req.body.device_id || req.body.uid)
    const installId = clean(req.body.installId || req.body.install_id)
    const uid = clean(req.body.uid)
    const licenseId = clean(req.body.licenseId || req.body.license_id)
    const installApiToken = clean(req.body.installApiToken || req.body.install_api_token)

    if (!licenseKey) {
      return res.status(400).json({
        valid: false,
        active: false,
        success: false,
        provider: 'freemius',
        status: 'missing_key',
        error: 'License key is required.',
      })
    }

    if (!FREEMIUS_PRODUCT_ID) {
      return res.status(500).json({
        valid: false,
        active: false,
        success: false,
        provider: 'freemius',
        status: 'server_config_error',
        error: 'This license provider is not configured on the server.',
      })
    }

    const freemius = await verifyFreemius({
      licenseKey,
      email,
      machineId,
      mode: 'deactivate',
      installId,
      uid,
      licenseId,
      installApiToken,
    })

    console.log('Freemius deactivate request', {
      status: freemius.status,
      success: freemius.success,
      active: freemius.active,
      hasInstallId: Boolean(installId),
      installIdType: /^\d+$/.test(String(installId || '')) ? 'number-like' : 'string/empty',
      hasUid: Boolean(uid),
      machineIdLength: machineId.length,
    })

    if (freemius.success || freemius.status === 'deactivated') {
      return res.json(freemius)
    }

    const statusCode = freemius.status === 'missing_install_id' ? 409 : 400
    return res.status(statusCode).json(freemius)
  } catch (err) {
    return res.status(500).json({
      valid: false,
      active: false,
      success: false,
      transient: true,
      provider: 'freemius',
      status: 'server_error',
      error: err.message || 'Server error during license deactivation.',
    })
  }
}

app.post('/api/license/deactivate', handleFreemiusDeactivateRequest)

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
    const installApiToken = clean(req.body.installApiToken || req.body.install_api_token)

    if (!licenseKey) {
      return res.status(400).json({
        valid: false,
        active: false,
        success: false,
        error: 'License key is required.',
      })
    }

    const manual = verifyManualLicenseKey({ licenseKey, displayLicenseKey, email })
    if (manual.valid) {
      return res.json(manual)
    }


    // Deactivation must go directly to Freemius.
    // Do not run Gumroad checks first, because Freemius keys can sometimes look like Gumroad-style keys.
    // If Gumroad runs first, Freemius can be skipped and the desktop app shows a false internet/deactivation error.
    if (mode === 'deactivate') {
      if (!FREEMIUS_PRODUCT_ID) {
        return res.status(500).json({
          valid: false,
          active: false,
          success: false,
          provider: 'freemius',
          status: 'server_config_error',
          error: 'This license provider is not configured on the server.',
        })
      }

      const freemius = await verifyFreemius({
        licenseKey,
        email,
        machineId,
        mode,
        installId,
        uid,
        licenseId,
        installApiToken,
      })

      console.log('Freemius deactivate result', {
        status: freemius.status,
        success: freemius.success,
        active: freemius.active,
        hasInstallId: Boolean(installId),
        hasUid: Boolean(uid),
      })

      if (freemius.success || freemius.status === 'deactivated') {
        return res.json(freemius)
      }

      const statusCode = freemius.status === 'missing_install_id' ? 409 : 400
      return res.status(statusCode).json(freemius)
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
      manualKeysConfigured: getManualLicenseKeys().length > 0,
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

    if (FREEMIUS_PRODUCT_ID) {
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


// -----------------------------------------------------------------------------
// Key Sounds private delivery (GitHub App -> TweakShift desktop)
// -----------------------------------------------------------------------------
const KEY_SOUNDS_GITHUB_OWNER = process.env.KEY_SOUNDS_GITHUB_OWNER || 'technicalhassan99-netizen'
const KEY_SOUNDS_GITHUB_REPO = process.env.KEY_SOUNDS_GITHUB_REPO || 'TweakShift-KeySounds-Private'
const KEY_SOUNDS_RELEASE_TAG = process.env.KEY_SOUNDS_RELEASE_TAG || 'keysounds-v1.0.0'
const KEY_SOUNDS_GITHUB_APP_ID = process.env.KEY_SOUNDS_GITHUB_APP_ID || '4640897'
const KEY_SOUNDS_GITHUB_CLIENT_ID = process.env.KEY_SOUNDS_GITHUB_CLIENT_ID || 'Iv23liOrgT4gqDMIUYwQ'
const KEY_SOUNDS_PRIVATE_KEY_PATH = process.env.KEY_SOUNDS_GITHUB_PRIVATE_KEY_PATH || '/etc/secrets/tweakshift-sound-delivery.pem'
const TWEAKSHIFT_AUTH_API_BASE = process.env.TWEAKSHIFT_AUTH_API_URL || 'https://tweakshift-auth-api.onrender.com'

const KEY_SOUND_FREE_PACK_IDS = new Set([
  'cherry-mx-black-abs-high-fidelity',
  'steelseries-apex-pro-tkl-v2-linear',
  'gateron-black-ink-linear',
  'anime-reaction-novelty',
])

let keySoundsTokenCache = null
let keySoundsCatalogCache = null
let keySoundsReleaseCache = null

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function readGitHubAppPrivateKey() {
  const inline = String(process.env.KEY_SOUNDS_GITHUB_PRIVATE_KEY || '').trim()
  if (inline) return inline.replace(/\\n/g, '\n')
  if (!fs.existsSync(KEY_SOUNDS_PRIVATE_KEY_PATH)) {
    throw new Error(`GitHub App private key was not found at ${KEY_SOUNDS_PRIVATE_KEY_PATH}`)
  }
  return fs.readFileSync(KEY_SOUNDS_PRIVATE_KEY_PATH, 'utf8')
}

function createGitHubAppJwt() {
  const now = Math.floor(Date.now() / 1000)
  const header = base64UrlJson({ alg: 'RS256', typ: 'JWT' })
  const payload = base64UrlJson({
    iat: now - 60,
    exp: now + 9 * 60,
    iss: KEY_SOUNDS_GITHUB_CLIENT_ID || KEY_SOUNDS_GITHUB_APP_ID,
  })
  const unsigned = `${header}.${payload}`
  const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), readGitHubAppPrivateKey()).toString('base64url')
  return `${unsigned}.${signature}`
}

async function githubJson(pathname, { method = 'GET', token = '', body = null, jwt = false } = {}) {
  const response = await fetch(`https://api.github.com${pathname}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2026-03-10',
      'User-Agent': 'TweakShift-Key-Sounds-Delivery/1.0',
      ...(token ? { Authorization: `${jwt ? 'Bearer' : 'Bearer'} ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await response.text().catch(() => '')
  let payload = {}
  if (text) {
    try { payload = JSON.parse(text) } catch { payload = { message: text } }
  }
  if (!response.ok) {
    const error = new Error(payload?.message || `GitHub returned ${response.status}`)
    error.status = response.status
    error.payload = payload
    throw error
  }
  return payload
}

async function getKeySoundsInstallationToken() {
  if (keySoundsTokenCache?.token && keySoundsTokenCache.expiresAt > Date.now() + 5 * 60 * 1000) {
    return keySoundsTokenCache.token
  }

  const jwt = createGitHubAppJwt()
  const installation = await githubJson(
    `/repos/${encodeURIComponent(KEY_SOUNDS_GITHUB_OWNER)}/${encodeURIComponent(KEY_SOUNDS_GITHUB_REPO)}/installation`,
    { token: jwt, jwt: true }
  )

  const tokenPayload = await githubJson(
    `/app/installations/${encodeURIComponent(installation.id)}/access_tokens`,
    {
      method: 'POST',
      token: jwt,
      jwt: true,
      body: {
        repositories: [KEY_SOUNDS_GITHUB_REPO],
        permissions: { contents: 'read' },
      },
    }
  )

  keySoundsTokenCache = {
    token: tokenPayload.token,
    expiresAt: new Date(tokenPayload.expires_at || Date.now() + 50 * 60 * 1000).getTime(),
  }
  return keySoundsTokenCache.token
}

async function getKeySoundsCatalogRaw() {
  if (keySoundsCatalogCache?.expiresAt > Date.now()) return keySoundsCatalogCache.data
  const token = await getKeySoundsInstallationToken()
  const payload = await githubJson(
    `/repos/${encodeURIComponent(KEY_SOUNDS_GITHUB_OWNER)}/${encodeURIComponent(KEY_SOUNDS_GITHUB_REPO)}/contents/catalog.json`,
    { token }
  )
  if (!payload?.content) throw new Error('catalog.json is missing from the Key Sounds repository.')
  const decoded = Buffer.from(String(payload.content).replace(/\s+/g, ''), 'base64').toString('utf8')
  const data = JSON.parse(decoded)
  keySoundsCatalogCache = { data, expiresAt: Date.now() + 2 * 60 * 1000 }
  return data
}

async function getKeySoundsRelease() {
  if (keySoundsReleaseCache?.expiresAt > Date.now()) return keySoundsReleaseCache.data
  const token = await getKeySoundsInstallationToken()
  const data = await githubJson(
    `/repos/${encodeURIComponent(KEY_SOUNDS_GITHUB_OWNER)}/${encodeURIComponent(KEY_SOUNDS_GITHUB_REPO)}/releases/tags/${encodeURIComponent(KEY_SOUNDS_RELEASE_TAG)}`,
    { token }
  )
  keySoundsReleaseCache = { data, expiresAt: Date.now() + 2 * 60 * 1000 }
  return data
}

function publicPackRecord(pack = {}, availableAssetNames = new Set()) {
  const id = clean(pack.id || String(pack.fileName || '').replace(/\.[^.]+$/, ''))
  const fileName = clean(pack.fileName || `${id}.zip`)
  const tier = KEY_SOUND_FREE_PACK_IDS.has(id) ? 'free' : 'premium'
  return {
    id,
    displayName: clean(pack.displayName || pack.name || id),
    fileName,
    category: clean(pack.category || 'Keyboard'),
    style: clean(pack.style || ''),
    capability: clean(pack.capability || ''),
    sizeBytes: Number(pack.sizeBytes || 0),
    sha256: clean(pack.sha256 || '').toLowerCase(),
    version: clean(pack.version || '1.0.0'),
    accessTier: tier,
    downloadable: availableAssetNames.has(fileName),
  }
}

function pickPremiumFlag(payload = {}) {
  const access = payload.access || payload.entitlement || payload.subscription || payload.license || payload.data?.access || {}
  const status = String(
    access.subscription_status || access.subscriptionStatus || payload.subscription_status || payload.status || ''
  ).toLowerCase()
  const inactive = ['expired','cancelled','canceled','refunded','chargeback','unpaid','past_due','failed','inactive','disabled'].some((word) => status.includes(word))
  const premium = access.premium === true || access.active === true || access.isPremium === true || payload.premium === true || payload.active === true || payload.isPremium === true
  return Boolean(premium && !inactive)
}

async function verifyKeySoundsAccountRequest(req) {
  const auth = clean(req.headers.authorization)
  const token = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : clean(req.headers['x-tweakshift-account-token'])
  if (!token) return false

  const response = await fetch(`${TWEAKSHIFT_AUTH_API_BASE.replace(/\/$/, '')}/api/tool/verify-access`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'TweakShift-Key-Sounds-Delivery/1.0',
    },
    body: JSON.stringify({
      product_key: 'tweakshift_ai_engine',
      product_id: 29310,
      product_name: 'TweakShift AI Engine',
      app: 'TweakShift AI Engine',
      tool: 'TweakShift AI Engine',
      device_id: clean(req.headers['x-tweakshift-machine-id']),
      machine_id: clean(req.headers['x-tweakshift-machine-id']),
      machineId: clean(req.headers['x-tweakshift-machine-id']),
      device_name: clean(req.headers['x-tweakshift-device-name']) || 'Windows PC',
      platform: clean(req.headers['x-tweakshift-platform']) || 'win32',
      arch: clean(req.headers['x-tweakshift-arch']) || 'x64',
      session_token: clean(req.headers['x-tweakshift-session-token']),
      force_sync: true,
      startup_check: false,
    }),
  })
  const payload = await response.json().catch(() => ({}))
  return response.ok && payload?.success !== false && pickPremiumFlag(payload)
}

async function verifyKeySoundsLicenseRequest(req) {
  const licenseKey = clean(req.headers['x-tweakshift-license-key'])
  const displayLicenseKey = clean(req.headers['x-tweakshift-display-license-key'] || licenseKey)
  const email = clean(req.headers['x-tweakshift-email'])
  const machineId = clean(req.headers['x-tweakshift-machine-id'])
  if (!licenseKey) return false

  const manual = verifyManualLicenseKey({ licenseKey, displayLicenseKey, email })
  if (manual.valid) return true

  if (getGumroadProductIds().length > 0) {
    const gumroad = await verifyGumroad({ licenseKey, displayLicenseKey, email })
    if (gumroad.valid) return true
  }

  if (FREEMIUS_PRODUCT_ID) {
    const freemius = await verifyFreemius({ licenseKey, email, machineId, mode: 'verify' })
    if (freemius.success || freemius.valid) return true
  }
  return false
}

async function keySoundsPremiumAllowed(req) {
  try {
    if (await verifyKeySoundsAccountRequest(req)) return true
  } catch (error) {
    console.warn('Key Sounds account entitlement check failed:', error?.message || error)
  }
  try {
    if (await verifyKeySoundsLicenseRequest(req)) return true
  } catch (error) {
    console.warn('Key Sounds license entitlement check failed:', error?.message || error)
  }
  return false
}

app.get('/api/key-sounds/catalog', async (_req, res) => {
  try {
    const [catalog, release] = await Promise.all([getKeySoundsCatalogRaw(), getKeySoundsRelease()])
    const assetNames = new Set((release.assets || []).map((asset) => asset.name))
    const packs = (Array.isArray(catalog?.packs) ? catalog.packs : [])
      .map((pack) => publicPackRecord(pack, assetNames))
      .filter((pack) => pack.id && pack.fileName)

    return res.json({
      success: true,
      catalogVersion: clean(catalog?.catalogVersion || catalog?.schemaVersion || '1'),
      releaseTag: KEY_SOUNDS_RELEASE_TAG,
      freePackIds: [...KEY_SOUND_FREE_PACK_IDS],
      packs,
    })
  } catch (error) {
    console.error('Key Sounds catalog error:', error)
    return res.status(503).json({ success: false, code: 'CATALOG_UNAVAILABLE', error: error?.message || 'Sound pack catalog is unavailable.' })
  }
})

app.get('/api/key-sounds/download/:packId', async (req, res) => {
  try {
    const packId = clean(req.params.packId)
    const [catalog, release] = await Promise.all([getKeySoundsCatalogRaw(), getKeySoundsRelease()])
    const source = (Array.isArray(catalog?.packs) ? catalog.packs : []).find((pack) => clean(pack.id) === packId)
    if (!source) return res.status(404).json({ success: false, code: 'PACK_NOT_FOUND', error: 'Sound pack was not found.' })

    const tier = KEY_SOUND_FREE_PACK_IDS.has(packId) ? 'free' : 'premium'
    if (tier === 'premium' && !(await keySoundsPremiumAllowed(req))) {
      return res.status(403).json({ success: false, code: 'PREMIUM_REQUIRED', error: 'TweakShift Premium is required for this sound pack.' })
    }

    const fileName = clean(source.fileName || `${packId}.zip`)
    const asset = (release.assets || []).find((item) => item.name === fileName)
    if (!asset) return res.status(404).json({ success: false, code: 'ASSET_NOT_FOUND', error: 'The selected sound pack is not attached to the configured release.' })

    const token = await getKeySoundsInstallationToken()
    const upstream = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(KEY_SOUNDS_GITHUB_OWNER)}/${encodeURIComponent(KEY_SOUNDS_GITHUB_REPO)}/releases/assets/${asset.id}`,
      {
        headers: {
          Accept: 'application/octet-stream',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2026-03-10',
          'User-Agent': 'TweakShift-Key-Sounds-Delivery/1.0',
        },
        redirect: 'follow',
      }
    )

    if (!upstream.ok || !upstream.body) {
      const message = await upstream.text().catch(() => '')
      return res.status(502).json({ success: false, code: 'GITHUB_DOWNLOAD_FAILED', error: message || `GitHub returned ${upstream.status}` })
    }

    res.setHeader('Content-Type', 'application/octet-stream')
    res.setHeader('Content-Disposition', `attachment; filename="${fileName.replace(/"/g, '')}"`)
    res.setHeader('X-TweakShift-Pack-Id', packId)
    res.setHeader('X-TweakShift-Pack-Sha256', clean(source.sha256 || ''))
    res.setHeader('X-TweakShift-Pack-Tier', tier)
    if (asset.size) res.setHeader('Content-Length', String(asset.size))
    return Readable.fromWeb(upstream.body).pipe(res)
  } catch (error) {
    console.error('Key Sounds download error:', error)
    return res.status(500).json({ success: false, code: 'PACK_DOWNLOAD_ERROR', error: error?.message || 'Sound pack download failed.' })
  }
})

app.get('/api/key-sounds/health', (_req, res) => {
  res.json({ success: true, service: 'key-sounds-delivery', repo: KEY_SOUNDS_GITHUB_REPO, releaseTag: KEY_SOUNDS_RELEASE_TAG })
})

app.listen(PORT, () => {
  console.log(`TweakShift license server running on port ${PORT}`)
  console.log('License server patch: Freemius activation/deactivation IPC + new logo support enabled v6')
})