import assert from 'node:assert/strict';
import test from 'node:test';
import { Miniflare } from 'miniflare';

import { initDatabase } from '../src/database/schema.js';
import { handleAdminAPI } from '../src/handlers/admin.js';
import { handleServerAPI, handleServersAPI } from '../src/handlers/dashboard.js';

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

test('internal notes stay private while public notes are exposed by public server endpoints', async () => {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("OK"); } }',
    d1Databases: { DB: 'server-note-visibility-test' }
  });
  const username = 'note-visibility-admin';
  const apiSecret = 'note-visibility-api-secret';
  const internalNote = 'private rack and credential reminder';
  const publicNote = 'public maintenance window on Sunday';
  const env = {
    DB: await miniflare.getD1Database('DB'),
    API_USER_NAME: username,
    API_SECRET: apiSecret
  };
  const sys = {
    username,
    jwt_secret: 'note-visibility-jwt-secret-32-chars',
    is_public: 'true',
    long_history_points: '120',
    wss_report_enabled: 'false'
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
      adminRequest({ action: 'add', name: 'note visibility server' }, token),
      env,
      sys
    );
    assert.equal(addResponse.status, 200);
    const { id } = await addResponse.json();

    const editResponse = await handleAdminAPI(
      adminRequest({
        action: 'edit',
        id,
        name: 'note visibility server',
        server_group: 'Default',
        region: '',
        tags: '',
        internal_note: internalNote,
        public_note: publicNote,
        price: '',
        billing_cycle: 'month',
        auto_renewal: '0',
        currency: '¥',
        expire_date: '',
        traffic_limit: '',
        traffic_calc_type: 'total',
        interface: '',
        reset_day: 1,
        collect_interval: 0,
        report_interval: 60,
        connection_mode: 'http',
        auto_update: '0',
        custom_ct: '',
        custom_cu: '',
        custom_cm: '',
        custom_bd: '',
        rx_correction: '',
        tx_correction: '',
        offline_notify_disabled: '0',
        is_hidden: '0'
      }, token),
      env,
      sys
    );
    assert.equal(editResponse.status, 200);

    const adminListResponse = await handleAdminAPI(
      adminRequest({ action: 'list' }, token),
      env,
      sys
    );
    assert.equal(adminListResponse.status, 200);
    const adminList = await adminListResponse.json();
    const adminServer = adminList.servers.find(server => server.id === id);
    assert.equal(adminServer.internal_note, internalNote);
    assert.equal(adminServer.public_note, publicNote);

    const auditResponse = await handleAdminAPI(
      adminRequest({ action: 'audit_list', event_type: 'admin.server.update' }, token),
      env,
      sys
    );
    assert.equal(auditResponse.status, 200);
    const auditBody = await auditResponse.json();
    assert.equal(auditBody.events.length, 1);
    assert.equal(auditBody.events[0].target_type, 'server');
    assert.equal(auditBody.events[0].target_id, id);
    assert.equal(JSON.stringify(auditBody.events[0]).includes(internalNote), false);
    assert.equal(JSON.stringify(auditBody.events[0]).includes(publicNote), false);

    const publicListResponse = await handleServersAPI(
      new Request('https://monitor.example/api/servers'),
      env,
      sys
    );
    assert.equal(publicListResponse.status, 200);
    const publicList = await publicListResponse.json();
    const publicServer = publicList.servers.find(server => server.id === id);
    assert.equal(publicServer.public_note, publicNote);
    assert.equal(Object.hasOwn(publicServer, 'internal_note'), false);
    assert.equal(Object.hasOwn(publicServer, 'note'), false);
    assert.equal(JSON.stringify(publicServer).includes(internalNote), false);

    const publicDetailResponse = await handleServerAPI(
      new Request(`https://monitor.example/api/server?id=${id}`),
      env,
      sys
    );
    assert.equal(publicDetailResponse.status, 200);
    const publicDetail = await publicDetailResponse.json();
    assert.equal(publicDetail.public_note, publicNote);
    assert.equal(Object.hasOwn(publicDetail, 'internal_note'), false);
    assert.equal(Object.hasOwn(publicDetail, 'note'), false);
    assert.equal(JSON.stringify(publicDetail).includes(internalNote), false);
  } finally {
    await miniflare.dispose();
  }
});
