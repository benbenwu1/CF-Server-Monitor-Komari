import assert from 'node:assert/strict';
import test from 'node:test';
import { Miniflare } from 'miniflare';

import { initDatabase } from '../src/database/schema.js';
import { handleAdminAPI } from '../src/handlers/admin.js';

function adminRequest(body, token = '') {
  return new Request('https://monitor.example/admin/api', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'CF-Connecting-IP': '203.0.113.51',
      'User-Agent': 'Logout browser',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body)
  });
}

test('server-side logout revokes the current session and records a safe audit event', async () => {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("OK"); } }',
    d1Databases: { DB: 'admin-session-logout-test' }
  });
  const username = 'session-logout-admin';
  const apiSecret = 'session-logout-api-secret';
  const env = {
    DB: await miniflare.getD1Database('DB'),
    API_USER_NAME: username,
    API_SECRET: apiSecret
  };
  const sys = {
    username,
    jwt_secret: 'session-logout-jwt-secret-32-characters'
  };

  try {
    await initDatabase(env.DB);
    const loginResponse = await handleAdminAPI(
      adminRequest({ action: 'login', username, password: apiSecret }),
      env,
      sys
    );
    const loginBody = await loginResponse.json();

    const logoutResponse = await handleAdminAPI(
      adminRequest({ action: 'session_logout' }, loginBody.token),
      env,
      sys
    );
    assert.equal(logoutResponse.status, 200);
    const logoutBody = await logoutResponse.json();
    assert.deepEqual(logoutBody, { success: true, revoked: true });

    const oldTokenResponse = await handleAdminAPI(
      adminRequest({ action: 'session_list' }, loginBody.token),
      env,
      sys
    );
    assert.equal(oldTokenResponse.status, 401);

    const reloginResponse = await handleAdminAPI(
      adminRequest({ action: 'login', username, password: apiSecret }),
      env,
      sys
    );
    const reloginBody = await reloginResponse.json();
    const auditResponse = await handleAdminAPI(
      adminRequest({ action: 'audit_list', event_type: 'admin.session.logout' }, reloginBody.token),
      env,
      sys
    );
    assert.equal(auditResponse.status, 200);
    const auditBody = await auditResponse.json();
    assert.equal(auditBody.events.length, 1);
    assert.equal(auditBody.events[0].event_type, 'admin.session.logout');
    assert.equal(JSON.stringify(auditBody.events).includes(loginBody.token), false);
    assert.equal(JSON.stringify(logoutBody).includes(loginBody.token), false);
  } finally {
    await miniflare.dispose();
  }
});
