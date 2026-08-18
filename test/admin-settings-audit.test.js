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
      'CF-Connecting-IP': '198.51.100.9',
      'User-Agent': 'CFSM settings audit integration test',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body)
  });
}

test('saving settings records field names without exposing their values', async () => {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("OK"); } }',
    d1Databases: { DB: 'admin-settings-audit-test' }
  });

  const username = 'settings-audit-admin';
  const apiSecret = 'settings-audit-api-secret';
  const env = {
    DB: await miniflare.getD1Database('DB'),
    API_USER_NAME: username,
    API_SECRET: apiSecret
  };
  const sys = {
    username,
    jwt_secret: 'settings-audit-test-jwt-secret-32-chars'
  };
  const sensitiveSettings = {
    site_title: 'private-monitor-title',
    tg_bot_token: 'private-telegram-token',
    cloudflare_token: 'private-cloudflare-token',
    turnstile_secret_key: 'private-turnstile-secret',
    password: 'private-new-admin-password'
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

    const saveResponse = await handleAdminAPI(
      adminRequest({ action: 'save_settings', settings: sensitiveSettings }, token),
      env,
      sys
    );
    assert.equal(saveResponse.status, 200);

    const listResponse = await handleAdminAPI(
      adminRequest({ action: 'audit_list' }, token),
      env,
      sys
    );
    assert.equal(listResponse.status, 200);
    const { events } = await listResponse.json();
    const settingsEvents = events.filter(event => event.event_type === 'admin.settings.update');

    assert.equal(settingsEvents.length, 1);
    assert.equal(settingsEvents[0].outcome, 'success');
    assert.equal(settingsEvents[0].actor, 'admin');
    assert.equal(settingsEvents[0].target_type, 'settings');
    assert.deepEqual(settingsEvents[0].detail, {
      changed_fields: [
        'cloudflare_token',
        'password',
        'site_title',
        'tg_bot_token',
        'turnstile_secret_key'
      ]
    });

    const serializedEvent = JSON.stringify(settingsEvents[0]);
    for (const value of [...Object.values(sensitiveSettings), username, apiSecret, token]) {
      assert.equal(serializedEvent.includes(value), false);
    }
  } finally {
    await miniflare.dispose();
  }
});
