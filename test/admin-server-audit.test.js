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
      'CF-Connecting-IP': '192.0.2.44',
      'User-Agent': 'CFSM server audit integration test',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body)
  });
}

test('creating and deleting a server records its lifecycle without server metadata', async () => {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("OK"); } }',
    d1Databases: { DB: 'admin-server-audit-test' }
  });

  const username = 'server-audit-admin';
  const apiSecret = 'server-audit-api-secret';
  const serverName = 'private-server-name';
  const serverGroup = 'private-server-group';
  const env = {
    DB: await miniflare.getD1Database('DB'),
    API_USER_NAME: username,
    API_SECRET: apiSecret
  };
  const sys = {
    username,
    jwt_secret: 'server-audit-test-jwt-secret-32-chars'
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

    const addResponse = await handleAdminAPI(
      adminRequest({ action: 'add', name: serverName, server_group: serverGroup }, token),
      env,
      sys
    );
    assert.equal(addResponse.status, 200);
    const { id } = await addResponse.json();
    assert.match(id, /^[0-9a-f-]{36}$/i);

    const deleteResponse = await handleAdminAPI(
      adminRequest({ action: 'delete', id }, token),
      env,
      sys
    );
    assert.equal(deleteResponse.status, 200);

    const listResponse = await handleAdminAPI(
      adminRequest({ action: 'audit_list' }, token),
      env,
      sys
    );
    assert.equal(listResponse.status, 200);
    const { events } = await listResponse.json();
    const serverEvents = events.filter(event => event.target_type === 'server');

    assert.deepEqual(
      serverEvents.map(event => ({
        event_type: event.event_type,
        outcome: event.outcome,
        target_id: event.target_id,
        detail: event.detail
      })),
      [
        {
          event_type: 'admin.server.delete',
          outcome: 'success',
          target_id: id,
          detail: {}
        },
        {
          event_type: 'admin.server.create',
          outcome: 'success',
          target_id: id,
          detail: {}
        }
      ]
    );

    const serializedEvents = JSON.stringify(serverEvents);
    for (const value of [serverName, serverGroup, username, apiSecret, token]) {
      assert.equal(serializedEvents.includes(value), false);
    }
  } finally {
    await miniflare.dispose();
  }
});
