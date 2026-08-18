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

test('bulk server mutations write one summary audit event per operation', async () => {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("OK"); } }',
    d1Databases: { DB: 'admin-bulk-audit-test' }
  });
  const username = 'bulk-audit-admin';
  const apiSecret = 'bulk-audit-api-secret';
  const importedInternalNote = 'private imported server note';
  const env = {
    DB: await miniflare.getD1Database('DB'),
    API_USER_NAME: username,
    API_SECRET: apiSecret
  };
  const sys = {
    username,
    jwt_secret: 'bulk-audit-jwt-secret-32-characters'
  };

  try {
    await initDatabase(env.DB);
    const loginResponse = await handleAdminAPI(
      adminRequest({ action: 'login', username, password: apiSecret }),
      env,
      sys
    );
    const { token } = await loginResponse.json();

    const ids = [];
    for (const name of ['bulk server one', 'bulk server two']) {
      const response = await handleAdminAPI(
        adminRequest({ action: 'add', name }, token),
        env,
        sys
      );
      assert.equal(response.status, 200);
      ids.push((await response.json()).id);
    }

    const reorderResponse = await handleAdminAPI(
      adminRequest({ action: 'save_order', orders: [ids[1], ids[0]] }, token),
      env,
      sys
    );
    assert.equal(reorderResponse.status, 200);

    const deleteResponse = await handleAdminAPI(
      adminRequest({ action: 'batch_delete', ids }, token),
      env,
      sys
    );
    assert.equal(deleteResponse.status, 200);

    const importResponse = await handleAdminAPI(
      adminRequest({
        action: 'import_servers',
        servers: [{
          id: '4b6c69f0-ffca-41f5-b57d-750ef957db60',
          name: 'imported server',
          internal_note: importedInternalNote
        }]
      }, token),
      env,
      sys
    );
    assert.equal(importResponse.status, 200);

    const auditResponse = await handleAdminAPI(
      adminRequest({ action: 'audit_list', page_size: 100 }, token),
      env,
      sys
    );
    const { events } = await auditResponse.json();
    const bulkEvents = events.filter(event => [
      'admin.server.reorder',
      'admin.server.batch_delete',
      'admin.server.import'
    ].includes(event.event_type));

    assert.deepEqual(
      bulkEvents.map(event => ({ event_type: event.event_type, detail: event.detail })),
      [
        { event_type: 'admin.server.import', detail: { imported: 1, skipped: 0 } },
        { event_type: 'admin.server.batch_delete', detail: { count: 2 } },
        { event_type: 'admin.server.reorder', detail: { count: 2 } }
      ]
    );
    assert.equal(JSON.stringify(bulkEvents).includes(importedInternalNote), false);
  } finally {
    await miniflare.dispose();
  }
});
