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
      'CF-Connecting-IP': '192.0.2.90',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body)
  });
}

test('audit storage failures do not change authentication or completed mutation responses', async () => {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("OK"); } }',
    d1Databases: { DB: 'admin-audit-failure-isolation-test' }
  });
  const username = 'audit-isolation-admin';
  const apiSecret = 'audit-isolation-api-secret';
  const env = {
    DB: await miniflare.getD1Database('DB'),
    API_USER_NAME: username,
    API_SECRET: apiSecret
  };
  const sys = {
    username,
    jwt_secret: 'audit-isolation-jwt-secret-32-chars'
  };

  try {
    await initDatabase(env.DB);
    const loginResponse = await handleAdminAPI(
      adminRequest({ action: 'login', username, password: apiSecret }),
      env,
      sys
    );
    assert.equal(loginResponse.status, 200);
    const { token } = await loginResponse.json();

    await env.DB.prepare('DROP TABLE audit_events').run();

    const failedLoginResponse = await handleAdminAPI(
      adminRequest({ action: 'login', username, password: 'wrong-password' }),
      env,
      sys
    );
    assert.equal(failedLoginResponse.status, 401);

    const addResponse = await handleAdminAPI(
      adminRequest({ action: 'add', name: 'audit-isolation-server' }, token),
      env,
      sys
    );
    assert.equal(addResponse.status, 200);
    const { id } = await addResponse.json();

    const listResponse = await handleAdminAPI(
      adminRequest({ action: 'list' }, token),
      env,
      sys
    );
    assert.equal(listResponse.status, 200);
    const { servers } = await listResponse.json();
    assert.equal(servers.some(server => server.id === id), true);
  } finally {
    await miniflare.dispose();
  }
});
