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

test('get_settings reports notification credential presence without returning credential values', async () => {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("OK"); } }',
    d1Databases: { DB: 'admin-notification-settings-redaction-test' }
  });
  const username = 'notification-settings-admin';
  const apiSecret = 'notification-settings-api-secret';
  const notificationToken = 'private-saved-notification-token';
  const notificationTarget = 'private-saved-notification-target';
  const env = {
    DB: await miniflare.getD1Database('DB'),
    API_USER_NAME: username,
    API_SECRET: apiSecret
  };
  const sys = {
    username,
    jwt_secret: 'notification-settings-jwt-secret-32-chars',
    notification_provider: 'telegram',
    tg_bot_token: notificationToken,
    tg_chat_id: notificationTarget
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

    const settingsResponse = await handleAdminAPI(
      adminRequest({ action: 'get_settings' }, token),
      env,
      sys,
      async () => sys
    );
    assert.equal(settingsResponse.status, 200);
    const body = await settingsResponse.json();

    assert.equal(body.settings.notification_provider, 'telegram');
    assert.equal(body.settings.has_notification_credential, true);
    assert.equal(body.settings.has_notification_target, true);
    assert.equal(Object.hasOwn(body.settings, 'tg_bot_token'), false);
    assert.equal(Object.hasOwn(body.settings, 'tg_chat_id'), false);
    assert.equal(JSON.stringify(body.settings).includes(notificationToken), false);
    assert.equal(JSON.stringify(body.settings).includes(notificationTarget), false);
  } finally {
    await miniflare.dispose();
  }
});
