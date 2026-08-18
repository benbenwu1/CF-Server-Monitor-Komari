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

test('test notification failures are returned and persisted without credentials', async () => {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("OK"); } }',
    d1Databases: { DB: 'admin-notification-delivery-test' }
  });
  const username = 'notification-delivery-admin';
  const apiSecret = 'notification-delivery-api-secret';
  const providerToken = 'private-notification-provider-token';
  const env = {
    DB: await miniflare.getD1Database('DB'),
    API_USER_NAME: username,
    API_SECRET: apiSecret
  };
  const sys = {
    username,
    jwt_secret: 'notification-delivery-jwt-secret-32-chars'
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

    const sendResponse = await handleAdminAPI(
      adminRequest({
        action: 'send_test_notification',
        notification_provider: 'telegram',
        tg_bot_token: providerToken,
        tg_chat_id: ''
      }, token),
      env,
      sys
    );
    assert.equal(sendResponse.status, 400);
    const sendBody = await sendResponse.json();
    assert.deepEqual(sendBody.delivery, {
      success: false,
      provider: 'telegram',
      attempts: 0,
      status_code: null,
      error: 'missing_target'
    });

    const listResponse = await handleAdminAPI(
      adminRequest({ action: 'notification_delivery_list' }, token),
      env,
      sys
    );
    assert.equal(listResponse.status, 200);
    const listBody = await listResponse.json();
    assert.equal(listBody.success, true);
    assert.equal(listBody.deliveries.length, 1);
    assert.deepEqual(
      {
        source: listBody.deliveries[0].source,
        provider: listBody.deliveries[0].provider,
        status: listBody.deliveries[0].status,
        attempts: listBody.deliveries[0].attempts,
        status_code: listBody.deliveries[0].status_code,
        error: listBody.deliveries[0].error
      },
      {
        source: 'test',
        provider: 'telegram',
        status: 'failed',
        attempts: 0,
        status_code: null,
        error: 'missing_target'
      }
    );

    const auditResponse = await handleAdminAPI(
      adminRequest({ action: 'audit_list', event_type: 'admin.notification.test' }, token),
      env,
      sys
    );
    assert.equal(auditResponse.status, 200);
    const auditBody = await auditResponse.json();
    assert.equal(auditBody.events.length, 1);
    assert.equal(auditBody.events[0].outcome, 'failure');
    assert.deepEqual(auditBody.events[0].detail, {
      provider: 'telegram',
      error: 'missing_target'
    });

    const serialized = JSON.stringify({ sendBody, deliveries: listBody.deliveries });
    for (const secret of [providerToken, username, apiSecret, token]) {
      assert.equal(serialized.includes(secret), false);
    }
  } finally {
    await miniflare.dispose();
  }
});
