function boundedText(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength)
}

function timestamp(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

export function normalizeAdminSessions(payload) {
  if (!Array.isArray(payload?.sessions)) return []
  return payload.sessions
    .filter(session => session && boundedText(session.id, 100))
    .slice(0, 100)
    .map(session => ({
      id: boundedText(session.id, 100),
      auth_method: boundedText(session.auth_method, 32),
      first_ip: boundedText(session.first_ip, 64),
      last_ip: boundedText(session.last_ip, 64),
      user_agent: boundedText(session.user_agent, 512),
      created_at: timestamp(session.created_at),
      last_seen_at: timestamp(session.last_seen_at),
      expires_at: timestamp(session.expires_at),
      current: session.current === true || session.current === 1,
      online: session.online === true || session.online === 1
    }))
}

export async function revokeCurrentSessionForLogout(requestLogout, apiIndex) {
  if (typeof requestLogout !== 'function') return false
  try {
    const result = await requestLogout(apiIndex)
    return !result?.error && result?.data?.success === true && result?.data?.revoked === true
  } catch (_) {
    return false
  }
}

export async function refreshSessionTokenForSite({
  apiIndex,
  requestRefresh,
  isCurrentSite,
  storeToken
} = {}) {
  if (
    typeof requestRefresh !== 'function' ||
    typeof isCurrentSite !== 'function' ||
    typeof storeToken !== 'function'
  ) {
    return { applied: false, stale: false }
  }

  const result = await requestRefresh(apiIndex)
  if (!isCurrentSite(apiIndex)) {
    return { applied: false, stale: true }
  }
  if (result?.error || !storeToken(result?.data?.token)) {
    return { applied: false, stale: false }
  }
  return { applied: true, stale: false }
}
