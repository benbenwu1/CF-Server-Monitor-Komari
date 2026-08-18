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
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body)
  });
}

test('session storage failures return a server error without invalidating the JWT as unauthorized', async () => {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("OK"); } }',
    d1Databases: { DB: 'admin-session-storage-failure-test' }
  });
  const username = 'session-storage-admin';
  const apiSecret = 'session-storage-api-secret';
  const env = {
    DB: await miniflare.getD1Database('DB'),
    API_USER_NAME: username,
    API_SECRET: apiSecret
  };
  const sys = {
    username,
    jwt_secret: 'session-storage-jwt-secret-32-characters'
  };

  try {
    await initDatabase(env.DB);
    const loginResponse = await handleAdminAPI(
      adminRequest({ action: 'login', username, password: apiSecret }),
      env,
      sys
    );
    const { token } = await loginResponse.json();

    const unavailableEnv = {
      ...env,
      DB: {
        prepare() {
          throw new Error('simulated D1 outage');
        }
      }
    };
    const response = await handleAdminAPI(
      adminRequest({ action: 'session_list' }, token),
      unavailableEnv,
      sys
    );
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.equal(body.error, 'Internal Server Error');
    assert.equal(JSON.stringify(body).includes(token), false);
    assert.equal(JSON.stringify(body).includes('simulated D1 outage'), false);
  } finally {
    await miniflare.dispose();
  }
});
