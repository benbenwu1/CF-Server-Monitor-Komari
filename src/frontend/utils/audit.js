export const AUDIT_PAGE_SIZE = 20

function positiveInteger(value, fallback) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function nonNegativeInteger(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback
}

export function buildAuditListRequest({ eventType = '', page = 1 } = {}) {
  const normalizedEventType = String(eventType || '').trim().slice(0, 100)
  return {
    action: 'audit_list',
    ...(normalizedEventType ? { event_type: normalizedEventType } : {}),
    page: positiveInteger(page, 1),
    page_size: AUDIT_PAGE_SIZE
  }
}

export function normalizeAuditPage(payload) {
  const pagination = payload?.pagination || {}
  return {
    events: Array.isArray(payload?.events) ? payload.events : [],
    pagination: {
      page: positiveInteger(pagination.page, 1),
      page_size: positiveInteger(pagination.page_size, AUDIT_PAGE_SIZE),
      total: nonNegativeInteger(pagination.total),
      total_pages: nonNegativeInteger(pagination.total_pages)
    }
  }
}

function formatAuditValue(value) {
  if (Array.isArray(value)) return value.map(item => String(item)).join(', ')
  if (value && typeof value === 'object') return JSON.stringify(value)
  if (value === null || value === undefined || value === '') return '—'
  return String(value)
}

export function formatAuditDetail(detail) {
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return '—'
  const entries = Object.entries(detail)
  if (entries.length === 0) return '—'
  return entries
    .map(([key, value]) => `${key}: ${formatAuditValue(value)}`)
    .join(' · ')
}
