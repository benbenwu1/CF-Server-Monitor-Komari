const TOTP_SECRET_BYTES = 20;
const TOTP_STEP_MS = 30 * 1000;
const TOTP_DIGITS = 6;
const TOTP_WINDOW = 1;
const TOTP_SETUP_TTL_MS = 10 * 60 * 1000;
const RECOVERY_CODE_COUNT = 10;
const RECOVERY_CODE_BYTES = 10;
const ENCRYPTION_KEY_MIN_LENGTH = 32;
const SECOND_FACTOR_ATTEMPT_LIMIT = 5;
const SECOND_FACTOR_ATTEMPT_WINDOW_MS = 5 * 60 * 1000;
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

const SETTINGS = Object.freeze({
  enabled: 'admin_totp_enabled',
  secret: 'admin_totp_secret',
  recoveryCodes: 'admin_totp_recovery_codes',
  pending: 'admin_totp_pending'
});

const ALWAYS_PROTECTED_SETTING_FIELDS = new Set([
  'password',
  'jwt_secret',
  'turnstile_secret_key',
  'cloudflare_token',
  'tg_bot_token',
  'tg_chat_id'
]);

const COMPARED_PROTECTED_SETTING_FIELDS = new Set([
  'username',
  'turnstile_enabled',
  'turnstile_login_enabled',
  'turnstile_site_key',
  'cloudflare_account_id',
  'notification_provider',
  'custom_head',
  'custom_script',
  'csp_static',
  'csp_api'
]);

function encodeBase64Url(bytes) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function decodeBase64Url(value) {
  const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  return Uint8Array.from(atob(padded), character => character.charCodeAt(0));
}

function encodeBase32(bytes) {
  let value = 0;
  let bits = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

function decodeBase32(value) {
  const normalized = String(value || '').replace(/=+$/g, '').toUpperCase();
  let buffer = 0;
  let bits = 0;
  const output = [];
  for (const character of normalized) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index < 0) throw new Error('invalid_totp_secret');
    buffer = (buffer << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((buffer >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(output);
}

function normalizeTotpCode(value) {
  const code = String(value || '').trim();
  return /^\d{6}$/.test(code) ? code : '';
}

function normalizeRecoveryCode(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
}

function constantTimeEqual(left, right) {
  const a = String(left || '');
  const b = String(right || '');
  const maxLength = Math.max(a.length, b.length);
  let difference = a.length ^ b.length;
  for (let index = 0; index < maxLength; index += 1) {
    difference |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function getEncryptionSecret(value) {
  const secret = String(value || '');
  if (secret.length < ENCRYPTION_KEY_MIN_LENGTH) {
    throw new Error('totp_encryption_key_unavailable');
  }
  return secret;
}

async function getEncryptionKey(encryptionSecret) {
  const encoder = new TextEncoder();
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(getEncryptionSecret(encryptionSecret)));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function encryptSecret(secret, encryptionSecret) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await getEncryptionKey(encryptionSecret);
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(secret)
  );
  return JSON.stringify({
    v: 1,
    iv: encodeBase64Url(iv),
    data: encodeBase64Url(new Uint8Array(encrypted))
  });
}

async function decryptSecret(payload, encryptionSecret) {
  const parsed = JSON.parse(String(payload || ''));
  if (parsed?.v !== 1 || !parsed.iv || !parsed.data) {
    throw new Error('invalid_totp_secret_payload');
  }
  const key = await getEncryptionKey(encryptionSecret);
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: decodeBase64Url(parsed.iv) },
    key,
    decodeBase64Url(parsed.data)
  );
  return new TextDecoder().decode(decrypted);
}

async function getSetting(db, key) {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ? LIMIT 1').bind(key).first();
  return row?.value === undefined || row?.value === null ? '' : String(row.value);
}

function upsertSetting(db, key, value) {
  return db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).bind(key, String(value));
}

function deleteSetting(db, key) {
  return db.prepare('DELETE FROM settings WHERE key = ?').bind(key);
}

async function hashRateLimitScope(scope, windowStartedAt) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${String(scope || '')}:${windowStartedAt}`)
  );
  return encodeBase64Url(new Uint8Array(digest));
}

async function reserveSecondFactorAttempt(db, scope, now) {
  if (!scope) return { allowed: true, scopeKey: null };

  const windowStartedAt = Math.floor(now / SECOND_FACTOR_ATTEMPT_WINDOW_MS) * SECOND_FACTOR_ATTEMPT_WINDOW_MS;
  const expiresAt = windowStartedAt + SECOND_FACTOR_ATTEMPT_WINDOW_MS;
  const scopeKey = await hashRateLimitScope(scope, windowStartedAt);
  const [, reservation] = await db.batch([
    db.prepare('DELETE FROM admin_second_factor_attempts WHERE expires_at <= ?').bind(now),
    db.prepare(`
      INSERT INTO admin_second_factor_attempts (
        scope_key,
        attempt_count,
        window_started_at,
        expires_at,
        updated_at
      ) VALUES (?, 1, ?, ?, ?)
      ON CONFLICT(scope_key) DO UPDATE SET
        attempt_count = admin_second_factor_attempts.attempt_count + 1,
        updated_at = excluded.updated_at
      WHERE admin_second_factor_attempts.attempt_count < ?
    `).bind(
      scopeKey,
      windowStartedAt,
      expiresAt,
      now,
      SECOND_FACTOR_ATTEMPT_LIMIT
    )
  ]);

  return {
    allowed: Number(reservation?.meta?.changes || 0) > 0,
    scopeKey,
    retryAfter: Math.ceil(SECOND_FACTOR_ATTEMPT_WINDOW_MS / 1000)
  };
}

async function releaseSecondFactorAttempt(db, scopeKey) {
  if (!scopeKey) return;
  await db.prepare(`
    UPDATE admin_second_factor_attempts
    SET attempt_count = CASE WHEN attempt_count > 0 THEN attempt_count - 1 ELSE 0 END
    WHERE scope_key = ?
  `).bind(scopeKey).run();
}

async function hashRecoveryCode(code, encryptionSecret) {
  const normalized = normalizeRecoveryCode(code);
  if (!normalized) return '';
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(getEncryptionSecret(encryptionSecret)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(normalized));
  return encodeBase64Url(new Uint8Array(digest));
}

function generateRecoveryCode() {
  const encoded = encodeBase32(crypto.getRandomValues(new Uint8Array(RECOVERY_CODE_BYTES)));
  return encoded.match(/.{1,4}/g).join('-');
}

async function generateRecoveryCodes(encryptionSecret) {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => generateRecoveryCode());
  const hashes = await Promise.all(codes.map(code => hashRecoveryCode(code, encryptionSecret)));
  return { codes, hashes };
}

async function consumeRecoveryCode(db, code, encryptionSecret) {
  const candidateHash = await hashRecoveryCode(code, encryptionSecret);
  if (!candidateHash) return false;
  const stored = await getSetting(db, SETTINGS.recoveryCodes);
  let hashes;
  try {
    hashes = JSON.parse(stored);
  } catch (_) {
    return false;
  }
  if (!Array.isArray(hashes)) return false;
  const index = hashes.findIndex(hash => constantTimeEqual(hash, candidateHash));
  if (index < 0) return false;
  const replacement = JSON.stringify(hashes.filter((_, hashIndex) => hashIndex !== index));
  const result = await db.prepare(`
    UPDATE settings
    SET value = ?
    WHERE key = ? AND value = ?
  `).bind(replacement, SETTINGS.recoveryCodes, stored).run();
  return Number(result?.meta?.changes || 0) > 0;
}

export async function generateTotpCode(secret, now = Date.now()) {
  const counter = BigInt(Math.floor(now / TOTP_STEP_MS));
  const message = new Uint8Array(8);
  let remaining = counter;
  for (let index = message.length - 1; index >= 0; index -= 1) {
    message[index] = Number(remaining & 255n);
    remaining >>= 8n;
  }
  const key = await crypto.subtle.importKey(
    'raw',
    decodeBase32(secret),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign']
  );
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, message));
  const offset = digest[digest.length - 1] & 15;
  const binary = (
    ((digest[offset] & 127) << 24) |
    ((digest[offset + 1] & 255) << 16) |
    ((digest[offset + 2] & 255) << 8) |
    (digest[offset + 3] & 255)
  ) >>> 0;
  return String(binary % (10 ** TOTP_DIGITS)).padStart(TOTP_DIGITS, '0');
}

export async function verifyTotpCode(secret, code, now = Date.now()) {
  const normalized = normalizeTotpCode(code);
  if (!normalized) return false;
  for (let offset = -TOTP_WINDOW; offset <= TOTP_WINDOW; offset += 1) {
    const expected = await generateTotpCode(secret, now + (offset * TOTP_STEP_MS));
    if (constantTimeEqual(expected, normalized)) return true;
  }
  return false;
}

export function isTotpEncryptionAvailable(encryptionSecret) {
  return String(encryptionSecret || '').length >= ENCRYPTION_KEY_MIN_LENGTH;
}

export async function isAdminTotpEnabled(db) {
  return await getSetting(db, SETTINGS.enabled) === 'true';
}

export async function beginAdminTotpSetup(db, encryptionSecret, label, now = Date.now()) {
  getEncryptionSecret(encryptionSecret);
  if (await isAdminTotpEnabled(db)) {
    return { success: false, reason: 'totp_already_enabled' };
  }
  const secret = encodeBase32(crypto.getRandomValues(new Uint8Array(TOTP_SECRET_BYTES)));
  const encryptedSecret = await encryptSecret(secret, encryptionSecret);
  await upsertSetting(db, SETTINGS.pending, JSON.stringify({
    created_at: now,
    encrypted_secret: encryptedSecret
  })).run();
  const accountLabel = String(label || 'admin').slice(0, 100);
  const issuer = 'CF-Server-Monitor';
  const otpauthUri = `otpauth://totp/${encodeURIComponent(`${issuer}:${accountLabel}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_MS / 1000}`;
  return { success: true, secret, otpauthUri };
}

export async function confirmAdminTotpSetup(db, encryptionSecret, code, now = Date.now()) {
  const pendingValue = await getSetting(db, SETTINGS.pending);
  if (!pendingValue) return { success: false, reason: 'totp_setup_not_found' };
  let pending;
  try {
    pending = JSON.parse(pendingValue);
  } catch (_) {
    return { success: false, reason: 'totp_setup_invalid' };
  }
  if (
    !Number.isFinite(Number(pending.created_at)) ||
    now - Number(pending.created_at) > TOTP_SETUP_TTL_MS
  ) {
    await deleteSetting(db, SETTINGS.pending).run();
    return { success: false, reason: 'totp_setup_expired' };
  }
  const secret = await decryptSecret(pending.encrypted_secret, encryptionSecret);
  if (!await verifyTotpCode(secret, code, now)) {
    return { success: false, reason: 'invalid_totp_code' };
  }
  const recovery = await generateRecoveryCodes(encryptionSecret);
  const conditionalUpsert = (key, value) => db.prepare(`
    INSERT INTO settings (key, value)
    SELECT ?, ?
    WHERE EXISTS (
      SELECT 1 FROM settings WHERE key = ? AND value = ?
    )
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).bind(key, String(value), SETTINGS.pending, pendingValue);
  const results = await db.batch([
    conditionalUpsert(SETTINGS.enabled, 'true'),
    conditionalUpsert(SETTINGS.secret, pending.encrypted_secret),
    conditionalUpsert(SETTINGS.recoveryCodes, JSON.stringify(recovery.hashes)),
    db.prepare('DELETE FROM settings WHERE key = ? AND value = ?')
      .bind(SETTINGS.pending, pendingValue)
  ]);
  if (Number(results[3]?.meta?.changes || 0) === 0) {
    return { success: false, reason: 'totp_setup_not_found' };
  }
  return { success: true, recoveryCodes: recovery.codes };
}

export async function verifyAdminSecondFactor(
  db,
  encryptionSecret,
  { totpCode, recoveryCode, rateLimitScope } = {},
  now = Date.now()
) {
  if (!await isAdminTotpEnabled(db)) {
    return { required: false, valid: true, method: null };
  }
  getEncryptionSecret(encryptionSecret);
  const hasFactorInput = !!String(totpCode || recoveryCode || '').trim();
  const reservation = hasFactorInput
    ? await reserveSecondFactorAttempt(db, rateLimitScope, now)
    : { allowed: true, scopeKey: null };
  if (!reservation.allowed) {
    return {
      required: true,
      valid: false,
      method: null,
      rateLimited: true,
      retryAfter: reservation.retryAfter
    };
  }

  let result;
  if (totpCode) {
    const encryptedSecret = await getSetting(db, SETTINGS.secret);
    if (!encryptedSecret) throw new Error('totp_secret_unavailable');
    const secret = await decryptSecret(encryptedSecret, encryptionSecret);
    result = {
      required: true,
      valid: await verifyTotpCode(secret, totpCode, now),
      method: 'totp'
    };
  } else if (recoveryCode) {
    result = {
      required: true,
      valid: await consumeRecoveryCode(db, recoveryCode, encryptionSecret),
      method: 'recovery'
    };
  } else {
    result = { required: true, valid: false, method: null };
  }

  if (result.valid) {
    await releaseSecondFactorAttempt(db, reservation.scopeKey);
  }
  return result;
}

export async function disableAdminTotp(db, encryptionSecret, factor, now = Date.now()) {
  const verification = await verifyAdminSecondFactor(db, encryptionSecret, factor, now);
  if (!verification.required) return { success: false, reason: 'totp_not_enabled' };
  if (verification.rateLimited) {
    return {
      success: false,
      reason: 'second_factor_rate_limited',
      retryAfter: verification.retryAfter
    };
  }
  if (!verification.valid) return { success: false, reason: 'invalid_second_factor' };
  await db.batch([
    deleteSetting(db, SETTINGS.enabled),
    deleteSetting(db, SETTINGS.secret),
    deleteSetting(db, SETTINGS.recoveryCodes),
    deleteSetting(db, SETTINGS.pending)
  ]);
  return { success: true, method: verification.method };
}

export function requiresTotpForSettings(settings = {}, currentSettings = {}) {
  for (const field of ALWAYS_PROTECTED_SETTING_FIELDS) {
    if (settings[field] !== undefined && String(settings[field] || '').trim()) return true;
  }
  for (const field of COMPARED_PROTECTED_SETTING_FIELDS) {
    if (
      settings[field] !== undefined &&
      String(settings[field] ?? '') !== String(currentSettings?.[field] ?? '')
    ) {
      return true;
    }
  }
  return false;
}
