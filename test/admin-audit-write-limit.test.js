import assert from 'node:assert/strict';
import test from 'node:test';
import { Miniflare } from 'miniflare';

import { initDatabase } from '../src/database/schema.js';
import { handleAdminAPI } from '../src/handlers/admin.js';

function adminRequest(body, headers = {}) {
  return new Request('https://monitor.example/admin/api', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'CF-Connecting-IP': '203.0.113.99',
      ...headers
    },
    body: JSON.stringify(body)
  });
}

test('login failure audit writes are capped per IP and five-minute window', async () => {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("OK"); } }',
    d1Databases: { DB: 'admin-audit-write-limit-test' }
  });
  const username = 'audit-limit-admin';
  const apiSecret = 'audit-limit-api-secret';
  const env = {
    DB: await miniflare.getD1Database('DB'),
    API_USER_NAME: username,
    API_SECRET: apiSecret
  };
  const sys = {
    username,
    jwt_secret: 'audit-write-limit-jwt-secret-32-chars'
  };

  try {
    await initDatabase(env.DB);

    for (let attempt = 0; attempt < 25; attempt++) {
      const response = await handleAdminAPI(
        adminRequest({ action: 'login', username, password: 'wrong-password' }),
        env,
        sys
      );
      assert.equal(response.status, 401);
    }

    const loginResponse = await handleAdminAPI(
      adminRequest({ action: 'login', username, password: apiSecret }),
      env,
      sys
    );
    assert.equal(loginResponse.status, 200);
    const { token } = await loginResponse.json();

    const listResponse = await handleAdminAPI(
      adminRequest({ action: 'audit_list' }, { Authorization: `Bearer ${token}` }),
      env,
      sys
    );
    assert.equal(listResponse.status, 200);
    const { events } = await listResponse.json();
    const failureEvents = events.filter(event => event.event_type === 'auth.login.failure');

    assert.equal(failureEvents.length, 1);
    assert.equal(failureEvents[0].count, 20);
  } finally {
    await miniflare.dispose();
  }
});
