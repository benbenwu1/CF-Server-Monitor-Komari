const AUDIT_LIST_DEFAULT_PAGE_SIZE = 50;
const AUDIT_LIST_MAX_PAGE_SIZE = 100;
const AUDIT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

function cleanText(value, maxLength) {
  if (value === undefined || value === null) return null;
  const cleaned = String(value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, maxLength);
  return cleaned || null;
}

function parseDetail(value) {
  if (!value) return {};
  try {
    return JSON.parse(value);
  } catch (_) {
    return {};
  }
}

export async function recordAuditEvent(db, event) {
  const occurredAt = Number.isFinite(event.occurredAt) ? event.occurredAt : Date.now();
  const maxCount = Number.isInteger(event.maxCount) && event.maxCount > 0
    ? event.maxCount
    : 2_147_483_647;
  const detail = event.detail && typeof event.detail === 'object'
    ? JSON.stringify(event.detail)
    : '{}';

  await db.prepare(`
    INSERT INTO audit_events (
      event_type,
      outcome,
      actor,
      target_type,
      target_id,
      ip_address,
      user_agent,
      detail,
      dedupe_key,
      count,
      first_occurred_at,
      last_occurred_at,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
    ON CONFLICT(dedupe_key) DO UPDATE SET
      count = audit_events.count + 1,
      last_occurred_at = excluded.last_occurred_at,
      user_agent = excluded.user_agent,
      detail = excluded.detail
    WHERE audit_events.count < ?
  `).bind(
    cleanText(event.eventType, 100),
    cleanText(event.outcome, 32),
    cleanText(event.actor, 100),
    cleanText(event.targetType, 100),
    cleanText(event.targetId, 200),
    cleanText(event.ipAddress, 64),
    cleanText(event.userAgent, 512),
    detail,
    cleanText(event.dedupeKey, 300),
    occurredAt,
    occurredAt,
    occurredAt,
    maxCount
  ).run();
}

export async function cleanupAuditEvents(db, now = Date.now()) {
  const result = await db.prepare('DELETE FROM audit_events WHERE last_occurred_at < ?')
    .bind(now - AUDIT_RETENTION_MS)
    .run();
  return Number(result?.meta?.changes || 0);
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export async function listAuditEvents(db, options = {}) {
  await cleanupAuditEvents(db);

  const page = positiveInteger(options.page, 1);
  const pageSize = Math.min(
    positiveInteger(options.pageSize, AUDIT_LIST_DEFAULT_PAGE_SIZE),
    AUDIT_LIST_MAX_PAGE_SIZE
  );
  const eventType = cleanText(options.eventType, 100);
  const offset = (page - 1) * pageSize;
  const countRow = await db.prepare(`
    SELECT COUNT(*) AS total
    FROM audit_events
    WHERE (? IS NULL OR event_type = ?)
  `).bind(eventType, eventType).first();
  const result = await db.prepare(`
    SELECT
      id,
      event_type,
      outcome,
      actor,
      target_type,
      target_id,
      ip_address,
      user_agent,
      detail,
      count,
      first_occurred_at,
      last_occurred_at,
      created_at
    FROM audit_events
    WHERE (? IS NULL OR event_type = ?)
    ORDER BY last_occurred_at DESC, id DESC
    LIMIT ? OFFSET ?
  `).bind(eventType, eventType, pageSize, offset).all();

  const total = Number(countRow?.total) || 0;

  return {
    events: (result.results || []).map(event => ({
      ...event,
      detail: parseDetail(event.detail)
    })),
    pagination: {
      page,
      page_size: pageSize,
      total,
      total_pages: Math.ceil(total / pageSize)
    }
  };
}
