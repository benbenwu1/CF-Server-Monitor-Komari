import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { Miniflare } from 'miniflare';

import { initDatabase } from '../src/database/schema.js';
import { handleAdminAPI } from '../src/handlers/admin.js';
import { generateTotpCode } from '../src/services/totp.js';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function decodeBase32(value) {
  let bits = '';
  for (const character of value.replace(/=+$/g, '').toUpperCase()) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index < 0) throw new Error('invalid base32');
    bits += index.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let offset = 0; offset + 8 <= bits.length; offset += 8) {
    bytes.push(Number.parseInt(bits.slice(offset, offset + 8), 2));
  }
  return Buffer.from(bytes);
}

function totpCode(secret, now = Date.now()) {
  const counter = BigInt(Math.floor(now / 30000));
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(counter);
  const digest = createHmac('sha1', decodeBase32(secret)).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = (
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff)
  ) >>> 0;
  return String(binary % 1000000).padStart(6, '0');
}

function adminRequest(body, token = '', ipAddress = '203.0.113.91') {
  return new Request('https://monitor.example/admin/api', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'CF-Connecting-IP': ipAddress,
      'User-Agent': 'TOTP integration test',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body)
  });
}

test('TOTP generation matches the RFC 6238 SHA-1 vectors at six digits', async () => {
  const rfcSecret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  assert.equal(await generateTotpCode(rfcSecret, 59_000), '287082');
  assert.equal(await generateTotpCode(rfcSecret, 1_111_111_109_000), '081804');
  assert.equal(await generateTotpCode(rfcSecret, 1_234_567_890_000), '005924');
});

test('admin can enroll TOTP, use one-time recovery codes, protect settings, and disable 2FA', async () => {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("OK"); } }',
    d1Databases: { DB: 'admin-totp-test' }
  });
  const username = 'totp-admin';
  const password = 'totp-password';
  const env = {
    DB: await miniflare.getD1Database('DB'),
    API_USER_NAME: username,
    API_SECRET: password,
    TOTP_ENCRYPTION_KEY: 'test-only-totp-encryption-key-with-32-chars'
  };
  const sys = {
    username,
    jwt_secret: 'totp-jwt-secret-with-at-least-32-characters'
  };

  try {
    await initDatabase(env.DB);
    const initialLogin = await handleAdminAPI(
      adminRequest({ action: 'login', username, password }),
      env,
      sys
    );
    assert.equal(initialLogin.status, 200);
    const initialToken = (await initialLogin.json()).token;

    const setupResponse = await handleAdminAPI(
      adminRequest({ action: 'totp_setup' }, initialToken),
      env,
      sys
    );
    assert.equal(setupResponse.status, 200);
    assert.equal(setupResponse.headers.get('Cache-Control'), 'no-store');
    const setup = await setupResponse.json();
    assert.match(setup.secret, /^[A-Z2-7]{32}$/);
    assert.match(setup.otpauth_uri, /^otpauth:\/\/totp\//);

    const confirmResponses = await Promise.all([
      handleAdminAPI(
        adminRequest({ action: 'totp_confirm', code: totpCode(setup.secret) }, initialToken),
        env,
        sys
      ),
      handleAdminAPI(
        adminRequest({ action: 'totp_confirm', code: totpCode(setup.secret) }, initialToken),
        env,
        sys
      )
    ]);
    assert.deepEqual(confirmResponses.map(response => response.status).sort(), [200, 400]);
    const confirmResponse = confirmResponses.find(response => response.status === 200);
    assert.equal(confirmResponse.status, 200);
    assert.equal(confirmResponse.headers.get('Cache-Control'), 'no-store');
    const confirmed = await confirmResponse.json();
    assert.equal(confirmed.enabled, true);
    assert.equal(confirmed.recovery_codes.length, 10);
    assert.equal(new Set(confirmed.recovery_codes).size, 10);

    const storedSecurityRows = await env.DB.prepare(`
      SELECT key, value
      FROM settings
      WHERE key LIKE 'admin_totp_%'
      ORDER BY key
    `).all();
    const serializedStorage = JSON.stringify(storedSecurityRows.results || []);
    assert.equal(serializedStorage.includes(setup.secret), false);
    assert.equal(serializedStorage.includes(confirmed.recovery_codes[0]), false);

    const settingsResponse = await handleAdminAPI(
      adminRequest({ action: 'get_settings' }, initialToken),
      env,
      sys
    );
    const settingsBody = await settingsResponse.json();
    assert.equal(settingsBody.settings.totp_enabled, true);
    const serializedSettings = JSON.stringify(settingsBody);
    assert.equal(serializedSettings.includes(setup.secret), false);
    assert.equal(serializedSettings.includes(confirmed.recovery_codes[0]), false);
    assert.equal(serializedSettings.includes(env.TOTP_ENCRYPTION_KEY), false);

    const auditResponse = await handleAdminAPI(
      adminRequest({ action: 'audit_list', event_type: 'admin.totp.enable' }, initialToken),
      env,
      sys
    );
    const auditBody = await auditResponse.json();
    assert.equal(auditBody.events.length, 1);
    assert.equal(JSON.stringify(auditBody).includes(setup.secret), false);
    assert.equal(JSON.stringify(auditBody).includes(confirmed.recovery_codes[0]), false);

    const concurrentInvalidLogins = await Promise.all(
      Array.from({ length: 6 }, (_, attempt) => handleAdminAPI(
        adminRequest({
          action: 'login',
          username,
          password,
          recovery_code: `CONCURRENT-INVALID-${attempt}`
        }, '', '203.0.113.92'),
        env,
        sys
      ))
    );
    assert.deepEqual(
      concurrentInvalidLogins.map(response => response.status).sort(),
      [401, 401, 401, 401, 401, 429]
    );

    const missingFactorLogin = await handleAdminAPI(
      adminRequest({ action: 'login', username, password }),
      env,
      sys
    );
    assert.equal(missingFactorLogin.status, 401);
    assert.equal((await missingFactorLogin.json()).code, 'totp_required');

    const totpLogin = await handleAdminAPI(
      adminRequest({ action: 'login', username, password, totp_code: totpCode(setup.secret) }),
      env,
      sys
    );
    assert.equal(totpLogin.status, 200);
    const totpToken = (await totpLogin.json()).token;

    const protectedSettings = await handleAdminAPI(
      adminRequest({ action: 'save_settings', settings: { cloudflare_account_id: 'protected-account' } }, totpToken),
      env,
      sys
    );
    assert.equal(protectedSettings.status, 428);
    assert.equal((await protectedSettings.json()).code, 'totp_required');

    const verifiedSettings = await handleAdminAPI(
      adminRequest({
        action: 'save_settings',
        settings: { cloudflare_account_id: 'protected-account' },
        totp_code: totpCode(setup.secret)
      }, totpToken),
      env,
      sys
    );
    assert.equal(verifiedSettings.status, 200);

    const recoveryLogin = await handleAdminAPI(
      adminRequest({
        action: 'login',
        username,
        password,
        recovery_code: confirmed.recovery_codes[0]
      }),
      env,
      sys
    );
    assert.equal(recoveryLogin.status, 200);
    const recoveryToken = (await recoveryLogin.json()).token;
    const recoverySessionList = await handleAdminAPI(
      adminRequest({ action: 'session_list' }, recoveryToken),
      env,
      sys
    );
    const recoverySessions = (await recoverySessionList.json()).sessions;
    assert.equal(
      recoverySessions.find(session => session.current)?.auth_method,
      'password_recovery'
    );

    const reusedRecoveryLogin = await handleAdminAPI(
      adminRequest({
        action: 'login',
        username,
        password,
        recovery_code: confirmed.recovery_codes[0]
      }),
      env,
      sys
    );
    assert.equal(reusedRecoveryLogin.status, 401);

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const invalidFactorLogin = await handleAdminAPI(
        adminRequest({
          action: 'login',
          username,
          password,
          recovery_code: `INVALID-RECOVERY-${attempt}`
        }),
        env,
        sys
      );
      assert.equal(invalidFactorLogin.status, 401);
    }

    const rateLimitedLogin = await handleAdminAPI(
      adminRequest({ action: 'login', username, password, totp_code: totpCode(setup.secret) }),
      env,
      sys
    );
    assert.equal(rateLimitedLogin.status, 429);
    assert.equal((await rateLimitedLogin.json()).code, 'second_factor_rate_limited');

    const disableResponse = await handleAdminAPI(
      adminRequest({ action: 'totp_disable', code: totpCode(setup.secret) }, totpToken),
      env,
      sys
    );
    assert.equal(disableResponse.status, 200);

    const loginAfterDisable = await handleAdminAPI(
      adminRequest({ action: 'login', username, password }),
      env,
      sys
    );
    assert.equal(loginAfterDisable.status, 200);

    delete env.TOTP_ENCRYPTION_KEY;
    const setupWithoutEncryptionKey = await handleAdminAPI(
      adminRequest({ action: 'totp_setup' }, (await loginAfterDisable.json()).token),
      env,
      sys
    );
    assert.equal(setupWithoutEncryptionKey.status, 400);
    assert.equal(
      (await setupWithoutEncryptionKey.json()).error,
      'totp_encryption_key_unavailable'
    );

    env.TOTP_ENCRYPTION_KEY = 'test-only-totp-encryption-key-with-32-chars';
    const postDisableToken = (await handleAdminAPI(
      adminRequest({ action: 'login', username, password }),
      env,
      sys
    ).then(response => response.json())).token;
    const secondSetupResponse = await handleAdminAPI(
      adminRequest({ action: 'totp_setup' }, postDisableToken),
      env,
      sys
    );
    const secondSetup = await secondSetupResponse.json();
    const secondConfirmResponse = await handleAdminAPI(
      adminRequest({ action: 'totp_confirm', code: totpCode(secondSetup.secret) }, postDisableToken),
      env,
      sys
    );
    assert.equal(secondConfirmResponse.status, 200);

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const invalidSettingsResponse = await handleAdminAPI(
        adminRequest({
          action: 'save_settings',
          settings: { cloudflare_account_id: `blocked-${attempt}` },
          totp_code: '000000'
        }, postDisableToken),
        env,
        sys
      );
      assert.equal(invalidSettingsResponse.status, 428);
    }
    const invalidDisableResponse = await handleAdminAPI(
      adminRequest({ action: 'totp_disable', code: '000000' }, postDisableToken),
      env,
      sys
    );
    assert.equal(invalidDisableResponse.status, 428);

    const authenticatedRateLimitResponse = await handleAdminAPI(
      adminRequest({
        action: 'totp_disable',
        code: totpCode(secondSetup.secret)
      }, postDisableToken),
      env,
      sys
    );
    assert.equal(authenticatedRateLimitResponse.status, 429);
    assert.equal(authenticatedRateLimitResponse.headers.get('Retry-After'), '300');
    assert.equal(
      (await authenticatedRateLimitResponse.json()).code,
      'second_factor_rate_limited'
    );
  } finally {
    await miniflare.dispose();
  }
});
