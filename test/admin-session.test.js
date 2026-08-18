import assert from 'node:assert/strict';
import test from 'node:test';
import { Miniflare } from 'miniflare';

import { initDatabase } from '../src/database/schema.js';
import { handleAdminAPI } from '../src/handlers/admin.js';

function adminRequest(body, { token = '', ipAddress = '', userAgent = '' } = {}) {
  return new Request('https://monitor.example/admin/api', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(ipAddress ? { 'CF-Connecting-IP': ipAddress } : {}),
      ...(userAgent ? { 'User-Agent': userAgent } : {})
    },
    body: JSON.stringify(body)
  });
}

test('password login creates a listable device session without exposing token material', async () => {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("OK"); } }',
    d1Databases: { DB: 'admin-session-list-test' }
  });
  const username = 'session-admin';
  const apiSecret = 'session-api-secret';
  const ipAddress = '203.0.113.25';
  const userAgent = 'CFSM session integration test';
  const env = {
    DB: await miniflare.getD1Database('DB'),
    API_USER_NAME: username,
    API_SECRET: apiSecret
  };
  const sys = {
    username,
    jwt_secret: 'session-test-jwt-secret-32-characters'
  };

  try {
    await initDatabase(env.DB);

    const loginResponse = await handleAdminAPI(
      adminRequest(
        { action: 'login', username, password: apiSecret },
        { ipAddress, userAgent }
      ),
      env,
      sys
    );
    assert.equal(loginResponse.status, 200);
    const loginBody = await loginResponse.json();

    const listResponse = await handleAdminAPI(
      adminRequest({ action: 'session_list' }, { token: loginBody.token, ipAddress, userAgent }),
      env,
      sys
    );
    assert.equal(listResponse.status, 200);
    const listBody = await listResponse.json();
    assert.equal(listBody.success, true);
    assert.equal(listBody.sessions.length, 1);
    assert.deepEqual(
      {
        auth_method: listBody.sessions[0].auth_method,
        first_ip: listBody.sessions[0].first_ip,
        last_ip: listBody.sessions[0].last_ip,
        user_agent: listBody.sessions[0].user_agent,
        current: listBody.sessions[0].current,
        online: listBody.sessions[0].online
      },
      {
        auth_method: 'password',
        first_ip: ipAddress,
        last_ip: ipAddress,
        user_agent: userAgent,
        current: true,
        online: true
      }
    );
    assert.equal(typeof listBody.sessions[0].id, 'string');
    assert.equal(Number.isFinite(listBody.sessions[0].created_at), true);
    assert.equal(Number.isFinite(listBody.sessions[0].last_seen_at), true);
    assert.equal(Number.isFinite(listBody.sessions[0].expires_at), true);

    const serialized = JSON.stringify(listBody.sessions);
    for (const secret of [loginBody.token, apiSecret, sys.jwt_secret]) {
      assert.equal(serialized.includes(secret), false);
    }
  } finally {
    await miniflare.dispose();
  }
});
