import { getCorsAllowedOrigins } from '../utils/cors.js';

const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_USER_URL = 'https://api.github.com/user';
const OAUTH_STATE_TTL_MS = 5 * 60 * 1000;
const OAUTH_EXCHANGE_TTL_MS = 60 * 1000;
const OAUTH_RANDOM_BYTES = 32;
const OAUTH_START_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const OAUTH_START_LIMIT_ATTEMPTS = 5;
const GITHUB_FETCH_TIMEOUT_MS = 10_000;

function encodeBase64Url(bytes) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function randomBase64Url() {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(OAUTH_RANDOM_BYTES)));
}

async function sha256Base64Url(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value)));
  return encodeBase64Url(new Uint8Array(digest));
}

async function derivePkceVerifier(clientSecret, state) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(clientSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const digest = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`github-oauth-pkce:${state}`)
  );
  return encodeBase64Url(new Uint8Array(digest));
}

function getGithubOAuthCallbackUrl(env) {
  const configured = String(env?.GITHUB_OAUTH_CALLBACK_URL || '').trim();
  if (!configured) return null;
  try {
    const callbackUrl = new URL(configured);
    const isLocalHttp = callbackUrl.protocol === 'http:' &&
      ['127.0.0.1', 'localhost'].includes(callbackUrl.hostname);
    if (
      (!isLocalHttp && callbackUrl.protocol !== 'https:') ||
      callbackUrl.username ||
      callbackUrl.password ||
      callbackUrl.search ||
      callbackUrl.hash ||
      callbackUrl.pathname !== '/admin/oauth/github/callback'
    ) {
      return null;
    }
    return callbackUrl.toString();
  } catch (_) {
    return null;
  }
}

function normalizeReturnUrl(env, value) {
  const callbackUrl = new URL(getGithubOAuthCallbackUrl(env));
  const fallback = new URL('/admin#admin', callbackUrl.origin);
  let target;
  try {
    target = value ? new URL(String(value)) : fallback;
  } catch (_) {
    throw new Error('invalid_oauth_return_url');
  }

  const allowedOrigins = new Set([
    callbackUrl.origin,
    ...getCorsAllowedOrigins(env)
  ]);
  const isLocalHttp = target.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(target.hostname);
  if (
    (!isLocalHttp && target.protocol !== 'https:') ||
    target.username ||
    target.password ||
    !allowedOrigins.has(target.origin) ||
    target.toString().length > 2048
  ) {
    throw new Error('invalid_oauth_return_url');
  }
  return target.toString();
}

export function isGithubOAuthAvailable(env) {
  return !!(
    String(env?.GITHUB_OAUTH_CLIENT_ID || '').trim() &&
    String(env?.GITHUB_OAUTH_CLIENT_SECRET || '').trim() &&
    getGithubOAuthCallbackUrl(env)
  );
}

export function isGithubOAuthCallbackRequest(env, requestUrl) {
  const configured = getGithubOAuthCallbackUrl(env);
  if (!configured) return false;
  const expected = new URL(configured);
  const actual = new URL(requestUrl);
  return actual.origin === expected.origin && actual.pathname === expected.pathname;
}

export async function reserveGithubOAuthStart(db, request, now = Date.now()) {
  const ipAddress = String(request?.headers?.get?.('CF-Connecting-IP') || 'unknown')
    .trim()
    .slice(0, 64) || 'unknown';
  const scopeHash = await sha256Base64Url(`github-oauth-start:${ipAddress}`);
  const expiresAt = now + OAUTH_START_LIMIT_WINDOW_MS;
  const reservation = await db.prepare(`
    INSERT INTO admin_oauth_start_limits (
      scope_hash,
      window_started_at,
      attempt_count,
      expires_at
    ) VALUES (?, ?, 1, ?)
    ON CONFLICT(scope_hash) DO UPDATE SET
      window_started_at = CASE
        WHEN admin_oauth_start_limits.expires_at <= excluded.window_started_at
          THEN excluded.window_started_at
        ELSE admin_oauth_start_limits.window_started_at
      END,
      attempt_count = CASE
        WHEN admin_oauth_start_limits.expires_at <= excluded.window_started_at
          THEN 1
        ELSE admin_oauth_start_limits.attempt_count + 1
      END,
      expires_at = CASE
        WHEN admin_oauth_start_limits.expires_at <= excluded.window_started_at
          THEN excluded.expires_at
        ELSE admin_oauth_start_limits.expires_at
      END
    WHERE admin_oauth_start_limits.expires_at <= excluded.window_started_at
      OR admin_oauth_start_limits.attempt_count < ?
    RETURNING attempt_count, expires_at
  `).bind(
    scopeHash,
    now,
    expiresAt,
    OAUTH_START_LIMIT_ATTEMPTS
  ).first();

  if (reservation) {
    return {
      allowed: true,
      remaining: Math.max(0, OAUTH_START_LIMIT_ATTEMPTS - Number(reservation.attempt_count || 0)),
      retryAfter: Math.max(1, Math.ceil((Number(reservation.expires_at) - now) / 1000))
    };
  }

  const current = await db.prepare(`
    SELECT expires_at
    FROM admin_oauth_start_limits
    WHERE scope_hash = ?
    LIMIT 1
  `).bind(scopeHash).first();
  return {
    allowed: false,
    remaining: 0,
    retryAfter: Math.max(1, Math.ceil((Number(current?.expires_at || expiresAt) - now) / 1000))
  };
}

export async function cleanupGithubOAuthStartLimits(db, now = Date.now()) {
  const result = await db.prepare(`
    DELETE FROM admin_oauth_start_limits
    WHERE expires_at <= ?
  `).bind(now).run();
  return Number(result?.meta?.changes || 0);
}

export async function createGithubOAuthAuthorization(
  db,
  env,
  request,
  { purpose = 'login', sessionId = null, returnUrl = '', now = Date.now() } = {}
) {
  if (!isGithubOAuthAvailable(env)) {
    throw new Error('github_oauth_unavailable');
  }
  if (!['login', 'bind'].includes(purpose)) {
    throw new Error('invalid_oauth_purpose');
  }

  const state = randomBase64Url();
  const stateHash = await sha256Base64Url(state);
  const clientSecret = String(env.GITHUB_OAUTH_CLIENT_SECRET);
  const codeVerifier = await derivePkceVerifier(clientSecret, state);
  const codeChallenge = await sha256Base64Url(codeVerifier);
  const callbackUrl = getGithubOAuthCallbackUrl(env);
  const normalizedReturnUrl = normalizeReturnUrl(env, returnUrl);

  await db.batch([
    db.prepare('DELETE FROM admin_oauth_states WHERE expires_at <= ? OR consumed_at IS NOT NULL')
      .bind(now),
    db.prepare(`
      INSERT INTO admin_oauth_states (
        state_hash,
        provider,
        purpose,
        session_id,
        return_url,
        callback_url,
        created_at,
        expires_at,
        consumed_at
      ) VALUES (?, 'github', ?, ?, ?, ?, ?, ?, NULL)
    `).bind(
      stateHash,
      purpose,
      sessionId,
      normalizedReturnUrl,
      callbackUrl,
      now,
      now + OAUTH_STATE_TTL_MS
    )
  ]);

  const authorizeUrl = new URL(GITHUB_AUTHORIZE_URL);
  authorizeUrl.searchParams.set('client_id', String(env.GITHUB_OAUTH_CLIENT_ID).trim());
  authorizeUrl.searchParams.set('redirect_uri', callbackUrl);
  authorizeUrl.searchParams.set('state', state);
  authorizeUrl.searchParams.set('code_challenge', codeChallenge);
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');

  return { authorizeUrl: authorizeUrl.toString() };
}

export async function consumeGithubOAuthState(db, state, now = Date.now()) {
  const normalizedState = String(state || '').trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(normalizedState)) return null;
  const stateHash = await sha256Base64Url(normalizedState);
  const pending = await db.prepare(`
    SELECT
      state_hash,
      provider,
      purpose,
      session_id,
      return_url,
      callback_url,
      created_at,
      expires_at
    FROM admin_oauth_states
    WHERE state_hash = ?
      AND consumed_at IS NULL
      AND expires_at > ?
    LIMIT 1
  `).bind(stateHash, now).first();
  if (!pending) return null;

  const consumed = await db.prepare(`
    UPDATE admin_oauth_states
    SET consumed_at = ?
    WHERE state_hash = ?
      AND consumed_at IS NULL
      AND expires_at > ?
  `).bind(now, stateHash, now).run();
  return Number(consumed?.meta?.changes || 0) > 0
    ? { ...pending, state: normalizedState }
    : null;
}

export async function fetchGithubOAuthUser(env, pendingState, code) {
  if (!isGithubOAuthAvailable(env)) throw new Error('github_oauth_unavailable');
  const normalizedCode = String(code || '').trim();
  if (!normalizedCode || normalizedCode.length > 512) {
    throw new Error('github_oauth_code_invalid');
  }

  const codeVerifier = await derivePkceVerifier(
    String(env.GITHUB_OAUTH_CLIENT_SECRET),
    pendingState.state
  );
  const tokenBody = new URLSearchParams({
    client_id: String(env.GITHUB_OAUTH_CLIENT_ID).trim(),
    client_secret: String(env.GITHUB_OAUTH_CLIENT_SECRET),
    code: normalizedCode,
    redirect_uri: String(pendingState.callback_url),
    code_verifier: codeVerifier
  });
  const tokenResponse = await fetch(GITHUB_TOKEN_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: tokenBody.toString(),
    redirect: 'manual',
    cache: 'no-store',
    signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS)
  });
  if (!tokenResponse.ok || tokenResponse.status >= 300) {
    throw new Error('github_oauth_token_exchange_failed');
  }
  const tokenPayload = await tokenResponse.json();
  const accessToken = String(tokenPayload?.access_token || '').trim();
  const tokenType = String(tokenPayload?.token_type || '').trim().toLowerCase();
  const grantedScope = String(tokenPayload?.scope || '').trim();
  if (
    tokenPayload?.error ||
    !accessToken ||
    tokenType !== 'bearer' ||
    grantedScope
  ) {
    throw new Error('github_oauth_token_exchange_failed');
  }

  const userResponse = await fetch(GITHUB_USER_URL, {
    method: 'GET',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${accessToken}`,
      'User-Agent': 'CF-Server-Monitor',
      'X-GitHub-Api-Version': '2026-03-10'
    },
    redirect: 'manual',
    cache: 'no-store',
    signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS)
  });
  if (!userResponse.ok || userResponse.status >= 300) {
    throw new Error('github_oauth_user_fetch_failed');
  }
  const user = await userResponse.json();
  if (
    typeof user?.id !== 'number' ||
    !Number.isSafeInteger(user.id) ||
    user.id <= 0
  ) {
    throw new Error('github_oauth_user_invalid');
  }
  const providerUserId = String(user.id);

  return {
    providerUserId,
    login: String(user?.login || '').trim().slice(0, 100) || null
  };
}

export async function getGithubOAuthBinding(db) {
  return await db.prepare(`
    SELECT provider_user_id, provider_login, bound_at, updated_at
    FROM admin_oauth_identities
    WHERE provider = 'github'
    LIMIT 1
  `).first();
}

export async function bindGithubOAuthIdentity(db, githubUser, now = Date.now()) {
  const inserted = await db.prepare(`
    INSERT INTO admin_oauth_identities (
      provider,
      provider_user_id,
      provider_login,
      bound_at,
      updated_at
    ) VALUES ('github', ?, ?, ?, ?)
    ON CONFLICT(provider) DO NOTHING
  `).bind(
    githubUser.providerUserId,
    githubUser.login,
    now,
    now
  ).run();
  if (Number(inserted?.meta?.changes || 0) > 0) {
    return { bound: true };
  }

  const existing = await getGithubOAuthBinding(db);
  return {
    bound: false,
    reason: String(existing?.provider_user_id) === githubUser.providerUserId
      ? 'github_oauth_already_bound'
      : 'github_oauth_binding_conflict'
  };
}

export async function unbindGithubOAuthIdentity(db, currentSessionId, now = Date.now()) {
  const currentSession = currentSessionId
    ? await db.prepare(`
        SELECT auth_method
        FROM admin_sessions
        WHERE id = ? AND revoked_at IS NULL AND expires_at > ?
        LIMIT 1
      `).bind(currentSessionId, now).first()
    : null;
  const results = await db.batch([
    db.prepare(`
      DELETE FROM admin_oauth_identities
      WHERE provider = 'github'
    `),
    db.prepare(`
      UPDATE admin_sessions
      SET revoked_at = ?
      WHERE auth_method LIKE 'github_oauth%'
        AND revoked_at IS NULL
        AND expires_at > ?
    `).bind(now, now),
    db.prepare(`
      DELETE FROM admin_oauth_exchange_codes
      WHERE provider = 'github'
    `)
  ]);
  const unbound = Number(results?.[0]?.meta?.changes || 0) > 0;
  const revokedSessions = Number(results?.[1]?.meta?.changes || 0);
  return {
    unbound,
    revokedSessions,
    currentSessionRevoked: unbound &&
      String(currentSession?.auth_method || '').startsWith('github_oauth')
  };
}

export async function createGithubOAuthExchangeCode(db, providerUserId, now = Date.now()) {
  const code = randomBase64Url();
  const codeHash = await sha256Base64Url(code);
  await db.batch([
    db.prepare(`
      DELETE FROM admin_oauth_exchange_codes
      WHERE expires_at <= ? OR consumed_at IS NOT NULL
    `).bind(now),
    db.prepare(`
      INSERT INTO admin_oauth_exchange_codes (
        code_hash,
        provider,
        provider_user_id,
        created_at,
        expires_at,
        consumed_at
      ) VALUES (?, 'github', ?, ?, ?, NULL)
    `).bind(codeHash, providerUserId, now, now + OAUTH_EXCHANGE_TTL_MS)
  ]);
  return code;
}

export async function getGithubOAuthExchangeCode(db, code, now = Date.now()) {
  const normalizedCode = String(code || '').trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(normalizedCode)) return null;
  const codeHash = await sha256Base64Url(normalizedCode);
  return await db.prepare(`
    SELECT code_hash, provider, provider_user_id, created_at, expires_at
    FROM admin_oauth_exchange_codes
    WHERE code_hash = ?
      AND provider = 'github'
      AND consumed_at IS NULL
      AND expires_at > ?
    LIMIT 1
  `).bind(codeHash, now).first();
}

export function buildGithubOAuthReturnUrl(returnUrl, result = {}) {
  const target = new URL(String(returnUrl));
  const hashValue = target.hash.replace(/^#/, '') || 'admin';
  const separatorIndex = hashValue.indexOf('?');
  const routePath = separatorIndex >= 0 ? hashValue.slice(0, separatorIndex) : hashValue;
  const query = new URLSearchParams(separatorIndex >= 0 ? hashValue.slice(separatorIndex + 1) : '');
  for (const [key, value] of Object.entries(result)) {
    if (value === undefined || value === null || value === '') query.delete(key);
    else query.set(key, String(value));
  }
  target.hash = `${routePath || 'admin'}?${query.toString()}`;
  return target.toString();
}
