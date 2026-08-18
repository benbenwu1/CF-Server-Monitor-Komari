export const LEGACY_ADMIN_TOKEN_KEY = 'jwt_token'

const ADMIN_TOKEN_KEY_PREFIX = 'cfsm_admin_jwt:'

function normalizeApiBase(baseUrl) {
  return String(baseUrl || '').trim().replace(/\/+$/, '')
}

function tokenStorageKey(baseUrl) {
  return `${ADMIN_TOKEN_KEY_PREFIX}${encodeURIComponent(normalizeApiBase(baseUrl))}`
}

function cleanToken(token) {
  return String(token || '').trim()
}

export function readAdminToken(storage, baseUrl, { migrateLegacy = false } = {}) {
  if (!storage?.getItem) return ''
  const key = tokenStorageKey(baseUrl)
  try {
    const scopedToken = cleanToken(storage.getItem(key))
    if (scopedToken || !migrateLegacy) return scopedToken

    const legacyToken = cleanToken(storage.getItem(LEGACY_ADMIN_TOKEN_KEY))
    if (!legacyToken || !storage?.setItem) return ''
    storage.setItem(key, legacyToken)
    storage.removeItem?.(LEGACY_ADMIN_TOKEN_KEY)
    return legacyToken
  } catch (_) {
    return ''
  }
}

export function writeAdminToken(storage, baseUrl, token) {
  const normalized = cleanToken(token)
  if (!normalized || !storage?.setItem) return false
  try {
    storage.setItem(tokenStorageKey(baseUrl), normalized)
    return true
  } catch (_) {
    return false
  }
}

export function removeAdminToken(storage, baseUrl) {
  if (!storage?.removeItem) return false
  try {
    storage.removeItem(tokenStorageKey(baseUrl))
    return true
  } catch (_) {
    return false
  }
}
