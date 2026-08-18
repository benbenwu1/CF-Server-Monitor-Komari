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
      ...headers
    },
    body: JSON.stringify(body)
  });
}

test('login security events aggregate failures and are only visible to an authenticated admin', async () => {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("OK"); } }',
    d1Databases: { DB: 'admin-audit-test' }
  });

  const username = 'private-audit-user';
  const password = 'private-audit-password';
  const apiSecret = 'private-api-secret';
  const ipAddress = '203.0.113.17';
  const userAgent = 'CFSM audit integration test';
  const env = {
    DB: await miniflare.getD1Database('DB'),
    API_USER_NAME: username,
    API_SECRET: apiSecret
  };
  const sys = {
    username,
    jwt_secret: 'admin-audit-test-jwt-secret-32-characters'
  };
  const loginHeaders = {
    'CF-Connecting-IP': ipAddress,
    'User-Agent': userAgent
  };

  try {
    await initDatabase(env.DB);

    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await handleAdminAPI(
        adminRequest({ action: 'login', username, password: `${password}-wrong` }, loginHeaders),
        env,
        sys
      );
      assert.equal(response.status, 401);
    }

    const loginResponse = await handleAdminAPI(
      adminRequest({ action: 'login', username, password: apiSecret }, loginHeaders),
      env,
      sys
    );
    assert.equal(loginResponse.status, 200);
    const loginBody = await loginResponse.json();
    assert.equal(loginBody.success, true);
    assert.equal(typeof loginBody.token, 'string');

    const unauthorizedResponse = await handleAdminAPI(
      adminRequest({ action: 'audit_list' }),
      env,
      sys
    );
    assert.equal(unauthorizedResponse.status, 401);

    const listResponse = await handleAdminAPI(
      adminRequest(
        { action: 'audit_list' },
        { Authorization: `Bearer ${loginBody.token}` }
      ),
      env,
      sys
    );
    assert.equal(listResponse.status, 200);
    const listBody = await listResponse.json();
    assert.equal(listBody.success, true);
    assert.equal(Array.isArray(listBody.events), true);

    const failureEvents = listBody.events.filter(event => event.event_type === 'auth.login.failure');
    assert.equal(failureEvents.length, 1);
    assert.equal(failureEvents[0].outcome, 'failure');
    assert.equal(failureEvents[0].count, 2);
    assert.equal(failureEvents[0].ip_address, ipAddress);
    assert.equal(failureEvents[0].user_agent, userAgent);

    const successEvents = listBody.events.filter(event => event.event_type === 'auth.login.success');
    assert.equal(successEvents.length, 1);
    assert.equal(successEvents[0].outcome, 'success');
    assert.equal(successEvents[0].count, 1);
    assert.equal(successEvents[0].ip_address, ipAddress);

    const serializedEvents = JSON.stringify(listBody.events);
    for (const secret of [username, password, `${password}-wrong`, loginBody.token, apiSecret]) {
      assert.equal(serializedEvents.includes(secret), false);
    }
  } finally {
    await miniflare.dispose();
  }
});
