import assert from 'node:assert/strict';
import test from 'node:test';
import { Miniflare } from 'miniflare';

import { initDatabase } from '../src/database/schema.js';
import { handleAdminAPI } from '../src/handlers/admin.js';

function adminRequest(body, { token = '', ipAddress = '198.51.100.1' } = {}) {
  return new Request('https://monitor.example/admin/api', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'CF-Connecting-IP': ipAddress,
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body)
  });
}

test('audit_list removes events older than the 90-day retention window', async () => {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("OK"); } }',
    d1Databases: { DB: 'admin-audit-retention-test' }
  });
  const username = 'audit-retention-admin';
  const apiSecret = 'audit-retention-api-secret';
  const env = {
    DB: await miniflare.getD1Database('DB'),
    API_USER_NAME: username,
    API_SECRET: apiSecret
  };
  const sys = {
    username,
    jwt_secret: 'audit-retention-jwt-secret-32-chars'
  };
  const realDateNow = Date.now;
  const currentTime = Date.UTC(2026, 7, 18, 12, 0, 0);
  const dayMs = 24 * 60 * 60 * 1000;

  try {
    await initDatabase(env.DB);

    Date.now = () => currentTime - 91 * dayMs;
    const expiredResponse = await handleAdminAPI(
      adminRequest(
        { action: 'login', username, password: 'wrong-password' },
        { ipAddress: '198.51.100.91' }
      ),
      env,
      sys
    );
    assert.equal(expiredResponse.status, 401);

    Date.now = () => currentTime;
    const currentResponse = await handleAdminAPI(
      adminRequest(
        { action: 'login', username, password: 'wrong-password' },
        { ipAddress: '198.51.100.90' }
      ),
      env,
      sys
    );
    assert.equal(currentResponse.status, 401);

    const loginResponse = await handleAdminAPI(
      adminRequest({ action: 'login', username, password: apiSecret }),
      env,
      sys
    );
    assert.equal(loginResponse.status, 200);
    const { token } = await loginResponse.json();

    const listResponse = await handleAdminAPI(
      adminRequest(
        { action: 'audit_list', event_type: 'auth.login.failure' },
        { token }
      ),
      env,
      sys
    );
    assert.equal(listResponse.status, 200);
    const listBody = await listResponse.json();

    assert.equal(listBody.pagination.total, 1);
    assert.equal(listBody.events.length, 1);
    assert.equal(listBody.events[0].ip_address, '198.51.100.90');
  } finally {
    Date.now = realDateNow;
    await miniflare.dispose();
  }
});
