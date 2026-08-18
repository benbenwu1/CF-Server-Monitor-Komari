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

test('changing notification provider requires an explicit replacement credential', async () => {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("OK"); } }',
    d1Databases: { DB: 'admin-notification-provider-change-test' }
  });
  const username = 'provider-change-admin';
  const apiSecret = 'provider-change-api-secret';
  const previousCredential = 'previous-private-telegram-token';
  const replacementCredential = 'https://api.day.app/replacement-private-bark-token';
  const env = {
    DB: await miniflare.getD1Database('DB'),
    API_USER_NAME: username,
    API_SECRET: apiSecret
  };
  const sys = {
    username,
    jwt_secret: 'provider-change-jwt-secret-32-chars',
    notification_provider: 'telegram',
    tg_bot_token: previousCredential,
    tg_chat_id: 'previous-private-chat-id'
  };

  try {
    await initDatabase(env.DB);
    const loginResponse = await handleAdminAPI(
      adminRequest({ action: 'login', username, password: apiSecret }),
      env,
      sys
    );
    const { token } = await loginResponse.json();

    const rejectedResponse = await handleAdminAPI(
      adminRequest({
        action: 'save_settings',
        settings: { notification_provider: 'bark' }
      }, token),
      env,
      sys
    );
    assert.equal(rejectedResponse.status, 400);
    assert.equal((await rejectedResponse.json()).error, 'tgBotTokenRequired');
    assert.equal(sys.notification_provider, 'telegram');
    assert.equal(sys.tg_bot_token, previousCredential);

    const acceptedResponse = await handleAdminAPI(
      adminRequest({
        action: 'save_settings',
        settings: {
          notification_provider: 'bark',
          tg_bot_token: replacementCredential
        }
      }, token),
      env,
      sys
    );
    assert.equal(acceptedResponse.status, 200);
    const acceptedBody = await acceptedResponse.json();
    assert.equal(sys.notification_provider, 'bark');
    assert.equal(sys.tg_bot_token, replacementCredential);

    const serializedResponses = JSON.stringify(acceptedBody);
    assert.equal(serializedResponses.includes(previousCredential), false);
    assert.equal(serializedResponses.includes(replacementCredential), false);
  } finally {
    await miniflare.dispose();
  }
});
