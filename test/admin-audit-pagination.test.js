import assert from 'node:assert/strict';
import test from 'node:test';
import { Miniflare } from 'miniflare';

import { initDatabase } from '../src/database/schema.js';
import { handleAdminAPI } from '../src/handlers/admin.js';

function adminRequest(body, { token = '', ipAddress = '203.0.113.1' } = {}) {
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

test('audit_list filters by event type and returns bounded pages', async () => {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("OK"); } }',
    d1Databases: { DB: 'admin-audit-pagination-test' }
  });
  const username = 'audit-pagination-admin';
  const apiSecret = 'audit-pagination-api-secret';
  const env = {
    DB: await miniflare.getD1Database('DB'),
    API_USER_NAME: username,
    API_SECRET: apiSecret
  };
  const sys = {
    username,
    jwt_secret: 'audit-pagination-jwt-secret-32-chars'
  };

  try {
    await initDatabase(env.DB);

    for (let attempt = 1; attempt <= 5; attempt++) {
      const response = await handleAdminAPI(
        adminRequest(
          { action: 'login', username, password: 'wrong-password' },
          { ipAddress: `203.0.113.${attempt}` }
        ),
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
      adminRequest(
        {
          action: 'audit_list',
          event_type: 'auth.login.failure',
          page: 2,
          page_size: 2
        },
        { token }
      ),
      env,
      sys
    );
    assert.equal(listResponse.status, 200);
    const listBody = await listResponse.json();

    assert.equal(listBody.events.length, 2);
    assert.equal(listBody.events.every(event => event.event_type === 'auth.login.failure'), true);
    assert.deepEqual(listBody.pagination, {
      page: 2,
      page_size: 2,
      total: 5,
      total_pages: 3
    });
  } finally {
    await miniflare.dispose();
  }
});
