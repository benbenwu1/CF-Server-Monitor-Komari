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

test('admin can revoke another device session without revoking the current session', async () => {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("OK"); } }',
    d1Databases: { DB: 'admin-session-revoke-test' }
  });
  const username = 'session-revoke-admin';
  const apiSecret = 'session-revoke-api-secret';
  const env = {
    DB: await miniflare.getD1Database('DB'),
    API_USER_NAME: username,
    API_SECRET: apiSecret
  };
  const sys = {
    username,
    jwt_secret: 'session-revoke-jwt-secret-32-characters'
  };

  try {
    await initDatabase(env.DB);

    const firstLogin = await handleAdminAPI(
      adminRequest(
        { action: 'login', username, password: apiSecret },
        { ipAddress: '203.0.113.31', userAgent: 'Current browser' }
      ),
      env,
      sys
    );
    const firstLoginBody = await firstLogin.json();
    const secondLogin = await handleAdminAPI(
      adminRequest(
        { action: 'login', username, password: apiSecret },
        { ipAddress: '203.0.113.32', userAgent: 'Other browser' }
      ),
      env,
      sys
    );
    const secondLoginBody = await secondLogin.json();

    const beforeRevoke = await handleAdminAPI(
      adminRequest(
        { action: 'session_list' },
        { token: firstLoginBody.token, ipAddress: '203.0.113.31', userAgent: 'Current browser' }
      ),
      env,
      sys
    );
    assert.equal(beforeRevoke.status, 200);
    const beforeRevokeBody = await beforeRevoke.json();
    assert.equal(beforeRevokeBody.sessions.length, 2);
    const otherSession = beforeRevokeBody.sessions.find(session => !session.current);
    assert.equal(typeof otherSession?.id, 'string');

    const revokeResponse = await handleAdminAPI(
      adminRequest(
        { action: 'session_revoke', session_id: otherSession.id },
        { token: firstLoginBody.token, ipAddress: '203.0.113.31', userAgent: 'Current browser' }
      ),
      env,
      sys
    );
    assert.equal(revokeResponse.status, 200);

    const revokedSessionResponse = await handleAdminAPI(
      adminRequest(
        { action: 'session_list' },
        { token: secondLoginBody.token, ipAddress: '203.0.113.32', userAgent: 'Other browser' }
      ),
      env,
      sys
    );
    assert.equal(revokedSessionResponse.status, 401);

    const currentSessionResponse = await handleAdminAPI(
      adminRequest(
        { action: 'session_list' },
        { token: firstLoginBody.token, ipAddress: '203.0.113.31', userAgent: 'Current browser' }
      ),
      env,
      sys
    );
    assert.equal(currentSessionResponse.status, 200);
    const currentSessionBody = await currentSessionResponse.json();
    assert.equal(currentSessionBody.sessions.length, 1);
    assert.equal(currentSessionBody.sessions[0].current, true);

    const auditResponse = await handleAdminAPI(
      adminRequest(
        { action: 'audit_list', event_type: 'admin.session.revoke' },
        { token: firstLoginBody.token, ipAddress: '203.0.113.31', userAgent: 'Current browser' }
      ),
      env,
      sys
    );
    assert.equal(auditResponse.status, 200);
    const auditBody = await auditResponse.json();
    assert.equal(auditBody.events.length, 1);
    assert.deepEqual(
      {
        event_type: auditBody.events[0].event_type,
        outcome: auditBody.events[0].outcome,
        target_type: auditBody.events[0].target_type,
        target_id: auditBody.events[0].target_id
      },
      {
        event_type: 'admin.session.revoke',
        outcome: 'success',
        target_type: 'admin_session',
        target_id: otherSession.id
      }
    );

    const serializedAudit = JSON.stringify(auditBody.events);
    assert.equal(serializedAudit.includes(firstLoginBody.token), false);
    assert.equal(serializedAudit.includes(secondLoginBody.token), false);
  } finally {
    await miniflare.dispose();
  }
});
