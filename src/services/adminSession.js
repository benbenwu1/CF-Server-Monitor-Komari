const ADMIN_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ADMIN_SESSION_ONLINE_WINDOW_MS = 5 * 60 * 1000;
const ADMIN_SESSION_TOUCH_INTERVAL_MS = 60 * 1000;
const ADMIN_SESSION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const ADMIN_SESSION_LIST_LIMIT = 100;

function cleanText(value, maxLength) {
  if (value === undefined || value === null) return null;
  const cleaned = String(value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, maxLength);
  return cleaned || null;
}

function getRequestMetadata(request) {
  return {
    ipAddress: cleanText(request?.headers?.get?.('CF-Connecting-IP'), 64),
    userAgent: cleanText(request?.headers?.get?.('User-Agent'), 512)
  };
}

export async function createAdminSession(db, request, authMethod = 'password', now = Date.now()) {
  const id = crypto.randomUUID();
  const metadata = getRequestMetadata(request);
  const session = {
    id,
    subject: 'admin',
    auth_method: cleanText(authMethod, 32) || 'password',
    first_ip: metadata.ipAddress,
    last_ip: metadata.ipAddress,
    user_agent: metadata.userAgent,
    created_at: now,
    last_seen_at: now,
    expires_at: now + ADMIN_SESSION_TTL_MS
  };

  await db.prepare(`
    INSERT INTO admin_sessions (
      id,
      subject,
      auth_method,
      first_ip,
      last_ip,
      user_agent,
      created_at,
      last_seen_at,
      expires_at,
      revoked_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
  `).bind(
    session.id,
    session.subject,
    session.auth_method,
    session.first_ip,
    session.last_ip,
    session.user_agent,
    session.created_at,
    session.last_seen_at,
    session.expires_at
  ).run();

  return session;
}

export async function createAdminSessionFromOAuthExchange(
  db,
  request,
  authMethod,
  exchange,
  now = Date.now()
) {
  const id = crypto.randomUUID();
  const metadata = getRequestMetadata(request);
  const session = {
    id,
    subject: 'admin',
    auth_method: cleanText(authMethod, 32) || 'github_oauth',
    first_ip: metadata.ipAddress,
    last_ip: metadata.ipAddress,
    user_agent: metadata.userAgent,
    created_at: now,
    last_seen_at: now,
    expires_at: now + ADMIN_SESSION_TTL_MS
  };

  const results = await db.batch([
    db.prepare(`
      INSERT INTO admin_sessions (
        id,
        subject,
        auth_method,
        first_ip,
        last_ip,
        user_agent,
        created_at,
        last_seen_at,
        expires_at,
        revoked_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL
      WHERE EXISTS (
        SELECT 1
        FROM admin_oauth_exchange_codes AS exchange_code
        JOIN admin_oauth_identities AS identity
          ON identity.provider = exchange_code.provider
          AND identity.provider_user_id = exchange_code.provider_user_id
        WHERE exchange_code.code_hash = ?
          AND exchange_code.provider = 'github'
          AND exchange_code.provider_user_id = ?
          AND exchange_code.consumed_at IS NULL
          AND exchange_code.expires_at > ?
      )
    `).bind(
      session.id,
      session.subject,
      session.auth_method,
      session.first_ip,
      session.last_ip,
      session.user_agent,
      session.created_at,
      session.last_seen_at,
      session.expires_at,
      exchange.code_hash,
      exchange.provider_user_id,
      now
    ),
    db.prepare(`
      UPDATE admin_oauth_exchange_codes
      SET consumed_at = ?
      WHERE code_hash = ?
        AND provider = 'github'
        AND provider_user_id = ?
        AND consumed_at IS NULL
        AND expires_at > ?
    `).bind(
      now,
      exchange.code_hash,
      exchange.provider_user_id,
      now
    )
  ]);

  const inserted = Number(results?.[0]?.meta?.changes || 0) > 0;
  const consumed = Number(results?.[1]?.meta?.changes || 0) > 0;
  return inserted && consumed ? session : null;
}

export async function validateAdminSession(db, sessionId, request, options = {}) {
  if (!db || !sessionId) return null;
  const now = Number.isFinite(options.now) ? options.now : Date.now();

  const session = await db.prepare(`
    SELECT id, subject, last_seen_at, expires_at
    FROM admin_sessions
    WHERE id = ?
      AND revoked_at IS NULL
      AND expires_at > ?
    LIMIT 1
  `).bind(sessionId, now).first();

  if (!session) return null;

  if (now - Number(session.last_seen_at) >= ADMIN_SESSION_TOUCH_INTERVAL_MS) {
    const metadata = getRequestMetadata(request);
    const touchSession = async () => {
      try {
        await db.prepare(`
          UPDATE admin_sessions
          SET
            last_seen_at = ?,
            last_ip = COALESCE(?, last_ip),
            user_agent = COALESCE(?, user_agent)
          WHERE id = ?
            AND revoked_at IS NULL
            AND expires_at > ?
            AND last_seen_at <= ?
        `).bind(
          now,
          metadata.ipAddress,
          metadata.userAgent,
          sessionId,
          now,
          now - ADMIN_SESSION_TOUCH_INTERVAL_MS
        ).run();
      } catch (error) {
        console.error(JSON.stringify({
          event: 'admin_session.touch_failed',
          error: error?.name || 'Error'
        }));
      }
    };

    const touchPromise = touchSession();
    if (typeof options.ctx?.waitUntil === 'function') {
      options.ctx.waitUntil(touchPromise);
    } else {
      await touchPromise;
    }
  }

  return session;
}

export async function listAdminSessions(db, currentSessionId, now = Date.now()) {
  const result = await db.prepare(`
    SELECT
      id,
      auth_method,
      first_ip,
      last_ip,
      user_agent,
      created_at,
      last_seen_at,
      expires_at
    FROM admin_sessions
    WHERE revoked_at IS NULL
      AND expires_at > ?
    ORDER BY last_seen_at DESC, created_at DESC
    LIMIT ?
  `).bind(now, ADMIN_SESSION_LIST_LIMIT).all();

  return (result.results || []).map(session => ({
    ...session,
    current: session.id === currentSessionId,
    online: now - Number(session.last_seen_at) <= ADMIN_SESSION_ONLINE_WINDOW_MS
  }));
}

export async function revokeAdminSession(db, sessionId, currentSessionId, now = Date.now()) {
  const normalizedSessionId = cleanText(sessionId, 100);
  if (!normalizedSessionId) {
    return { revoked: false, reason: 'invalid_session' };
  }
  if (normalizedSessionId === currentSessionId) {
    return { revoked: false, reason: 'current_session' };
  }

  const result = await db.prepare(`
    UPDATE admin_sessions
    SET revoked_at = ?
    WHERE id = ?
      AND revoked_at IS NULL
      AND expires_at > ?
  `).bind(now, normalizedSessionId, now).run();

  return {
    revoked: Number(result?.meta?.changes || 0) > 0,
    reason: Number(result?.meta?.changes || 0) > 0 ? null : 'session_not_found'
  };
}

export async function revokeCurrentAdminSession(db, currentSessionId, now = Date.now()) {
  if (!currentSessionId) return false;
  const result = await db.prepare(`
    UPDATE admin_sessions
    SET revoked_at = ?
    WHERE id = ?
      AND revoked_at IS NULL
      AND expires_at > ?
  `).bind(now, currentSessionId, now).run();
  return Number(result?.meta?.changes || 0) > 0;
}

export async function refreshAdminSession(db, currentSessionId, request, issueToken, now = Date.now()) {
  if (!currentSessionId || typeof issueToken !== 'function') return null;

  const replacement = {
    id: crypto.randomUUID(),
    issued_at: now,
    expires_at: now + ADMIN_SESSION_TTL_MS
  };
  const token = await issueToken(replacement);
  const metadata = getRequestMetadata(request);
  const results = await db.batch([
    db.prepare(`
      INSERT INTO admin_sessions (
        id,
        subject,
        auth_method,
        first_ip,
        last_ip,
        user_agent,
        created_at,
        last_seen_at,
        expires_at,
        revoked_at
      )
      SELECT
        ?,
        subject,
        auth_method,
        first_ip,
        COALESCE(?, last_ip),
        COALESCE(?, user_agent),
        created_at,
        ?,
        ?,
        NULL
      FROM admin_sessions
      WHERE id = ?
        AND revoked_at IS NULL
        AND expires_at > ?
    `).bind(
      replacement.id,
      metadata.ipAddress,
      metadata.userAgent,
      now,
      replacement.expires_at,
      currentSessionId,
      now
    ),
    db.prepare(`
      UPDATE admin_sessions
      SET revoked_at = ?
      WHERE id = ?
        AND revoked_at IS NULL
        AND expires_at > ?
    `).bind(now, currentSessionId, now)
  ]);

  const inserted = Number(results?.[0]?.meta?.changes || 0) > 0;
  const revoked = Number(results?.[1]?.meta?.changes || 0) > 0;
  if (!inserted || !revoked) return null;

  return {
    ...replacement,
    token
  };
}

export async function cleanupAdminSessions(db, now = Date.now()) {
  const cutoff = now - ADMIN_SESSION_RETENTION_MS;
  const result = await db.prepare(`
    DELETE FROM admin_sessions
    WHERE expires_at < ?
      OR (revoked_at IS NOT NULL AND revoked_at < ?)
  `).bind(cutoff, cutoff).run();
  return Number(result?.meta?.changes || 0);
}
