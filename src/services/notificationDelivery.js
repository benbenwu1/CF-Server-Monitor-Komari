const NOTIFICATION_DELIVERY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const NOTIFICATION_DELIVERY_LIST_LIMIT = 50;

function cleanText(value, maxLength) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, maxLength);
}

export function createNotificationDeliveryStatement(db, source, result) {
  return db.prepare(`
    INSERT INTO notification_deliveries (
      source,
      provider,
      status,
      attempts,
      status_code,
      error,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(
    cleanText(source, 64) || 'unknown',
    cleanText(result?.provider, 32) || 'unknown',
    result?.success ? 'delivered' : 'failed',
    Number.isInteger(result?.attempts) ? result.attempts : 0,
    Number.isInteger(result?.status_code) ? result.status_code : null,
    result?.error ? cleanText(result.error, 100) : null,
    Date.now()
  );
}

export async function recordNotificationDelivery(db, source, result) {
  await createNotificationDeliveryStatement(db, source, result).run();
}

export async function cleanupNotificationDeliveries(db, now = Date.now()) {
  const result = await db.prepare('DELETE FROM notification_deliveries WHERE created_at < ?')
    .bind(now - NOTIFICATION_DELIVERY_RETENTION_MS)
    .run();
  return Number(result?.meta?.changes || 0);
}

export async function listNotificationDeliveries(db) {
  await cleanupNotificationDeliveries(db);

  const result = await db.prepare(`
    SELECT id, source, provider, status, attempts, status_code, error, created_at
    FROM notification_deliveries
    ORDER BY id DESC
    LIMIT ?
  `).bind(NOTIFICATION_DELIVERY_LIST_LIMIT).all();

  return result.results || [];
}
