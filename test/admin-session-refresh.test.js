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

test('refresh rotates the current device session and immediately invalidates the previous JWT', async () => {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("OK"); } }',
    d1Databases: { DB: 'admin-session-refresh-test' }
  });
  const username = 'session-refresh-admin';
  const apiSecret = 'session-refresh-api-secret';
  const metadata = {
    ipAddress: '203.0.113.41',
    userAgent: 'Refresh browser'
  };
  const env = {
    DB: await miniflare.getD1Database('DB'),
    API_USER_NAME: username,
    API_SECRET: apiSecret
  };
  const sys = {
    username,
    jwt_secret: 'session-refresh-jwt-secret-32-characters'
  };

  try {
    await initDatabase(env.DB);
    const loginResponse = await handleAdminAPI(
      adminRequest({ action: 'login', username, password: apiSecret }, metadata),
      env,
      sys
    );
    const loginBody = await loginResponse.json();

    const refreshResponse = await handleAdminAPI(
      adminRequest({ action: 'session_refresh' }, { ...metadata, token: loginBody.token }),
      env,
      sys
    );
    assert.equal(refreshResponse.status, 200);
    const refreshBody = await refreshResponse.json();
    assert.equal(refreshBody.success, true);
    assert.equal(typeof refreshBody.token, 'string');
    assert.notEqual(refreshBody.token, loginBody.token);

    const oldTokenResponse = await handleAdminAPI(
      adminRequest({ action: 'session_list' }, { ...metadata, token: loginBody.token }),
      env,
      sys
    );
    assert.equal(oldTokenResponse.status, 401);

    const newTokenResponse = await handleAdminAPI(
      adminRequest({ action: 'session_list' }, { ...metadata, token: refreshBody.token }),
      env,
      sys
    );
    assert.equal(newTokenResponse.status, 200);
    const newTokenBody = await newTokenResponse.json();
    assert.equal(newTokenBody.sessions.length, 1);
    assert.equal(newTokenBody.sessions[0].current, true);
    assert.equal(newTokenBody.sessions[0].first_ip, metadata.ipAddress);

    const auditResponse = await handleAdminAPI(
      adminRequest(
        { action: 'audit_list', event_type: 'admin.session.refresh' },
        { ...metadata, token: refreshBody.token }
      ),
      env,
      sys
    );
    assert.equal(auditResponse.status, 200);
    const auditBody = await auditResponse.json();
    assert.equal(auditBody.events.length, 1);
    assert.equal(auditBody.events[0].event_type, 'admin.session.refresh');
    assert.equal(JSON.stringify(auditBody.events).includes(loginBody.token), false);
    assert.equal(JSON.stringify(auditBody.events).includes(refreshBody.token), false);
  } finally {
    await miniflare.dispose();
  }
});
