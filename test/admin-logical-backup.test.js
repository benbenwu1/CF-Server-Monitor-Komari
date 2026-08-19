import assert from 'node:assert/strict';
import test from 'node:test';
import { Miniflare } from 'miniflare';

import { initDatabase } from '../src/database/schema.js';
import { handleAdminAPI } from '../src/handlers/admin.js';
import {
  createLogicalBackup,
  LOGICAL_BACKUP_FORMAT,
  LOGICAL_BACKUP_FORMAT_VERSION,
  LogicalBackupError
} from '../src/services/logicalBackup.js';

function adminRequest(body, token = '') {
  return new Request('https://monitor.example/admin/api', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'CFSM logical backup integration test',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body)
  });
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

test('logical backup exports only allowlisted configuration and can optionally persist to R2', async () => {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("OK"); } }',
    d1Databases: { DB: 'admin-logical-backup-test' },
    r2Buckets: { BACKUP_BUCKET: 'admin-logical-backup-test' }
  });
  const env = {
    DB: await miniflare.getD1Database('DB'),
    BACKUP_BUCKET: await miniflare.getR2Bucket('BACKUP_BUCKET'),
    API_USER_NAME: 'backup-admin',
    API_SECRET: 'backup-api-secret-value'
  };
  const sys = {
    username: env.API_USER_NAME,
    jwt_secret: 'backup-test-jwt-secret-32-characters'
  };

  try {
    await initDatabase(env.DB);
    await env.DB.prepare(`
      INSERT INTO settings (key, value) VALUES ('site_options', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).bind(JSON.stringify({
      is_public: 'false',
      long_history_points: '180',
      notification_provider: 'telegram',
      tg_bot_token: 'notification-secret-value',
      tg_chat_id: 'private-chat-id',
      turnstile_secret_key: 'turnstile-secret-value',
      cloudflare_token: 'cloudflare-secret-value',
      cloudflare_account_id: 'private-account-id',
      username: 'private-login-name',
      password: 'private-password-hash',
      jwt_secret: 'stored-jwt-secret-value'
    })).run();
    await env.DB.prepare(`
      INSERT INTO settings (key, value) VALUES ('appearance_options', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).bind(JSON.stringify({
      site_title: 'Backup Test',
      display_mode: 'bar',
      theme_options: { accent: 'green' }
    })).run();

    const loginResponse = await handleAdminAPI(adminRequest({
      action: 'login',
      username: env.API_USER_NAME,
      password: env.API_SECRET
    }), env, sys);
    assert.equal(loginResponse.status, 200);
    const { token } = await loginResponse.json();

    const addResponse = await handleAdminAPI(adminRequest({
      action: 'add',
      name: 'backup-node'
    }, token), env, sys);
    const added = await addResponse.json();
    assert.equal(addResponse.status, 200);

    const pingResponse = await handleAdminAPI(adminRequest({
      action: 'ping_task_create',
      name: 'backup-http-check',
      type: 'http',
      target: 'https://example.com/health',
      interval_seconds: 300,
      timeout_ms: 5000,
      enabled: true,
      apply_to_new_servers: false,
      server_ids: [added.id]
    }, token), env, sys);
    assert.equal(pingResponse.status, 200);

    await env.DB.prepare(`
      INSERT INTO audit_events (
        event_type, outcome, actor, detail, dedupe_key, count,
        first_occurred_at, last_occurred_at, created_at
      ) VALUES ('test.secret', 'success', 'admin', ?, 'backup-test-secret', 1, 1, 1, 1)
    `).bind(JSON.stringify({ value: 'audit-secret-value' })).run();

    const unauthorized = await handleAdminAPI(
      adminRequest({ action: 'logical_backup_status' }),
      env,
      sys
    );
    assert.equal(unauthorized.status, 401);

    const statusResponse = await handleAdminAPI(
      adminRequest({ action: 'logical_backup_status' }, token),
      env,
      sys
    );
    assert.equal(statusResponse.status, 200);
    assert.equal((await statusResponse.json()).r2_available, true);

    const exportResponse = await handleAdminAPI(
      adminRequest({ action: 'logical_backup_export' }, token),
      env,
      sys
    );
    assert.equal(exportResponse.status, 200);
    assert.equal(exportResponse.headers.get('cache-control'), 'no-store');
    const exported = await exportResponse.json();
    const backup = exported.backup;
    assert.equal(backup.format, LOGICAL_BACKUP_FORMAT);
    assert.equal(backup.format_version, LOGICAL_BACKUP_FORMAT_VERSION);
    assert.equal(backup.manifest.scope, 'configuration-only');
    assert.equal(backup.manifest.restorable_by_application, false);
    assert.equal(backup.data.site_options.is_public, 'false');
    assert.equal(backup.data.site_options.long_history_points, '180');
    assert.equal(backup.data.site_options.notification_provider, 'telegram');
    assert.deepEqual(backup.data.appearance_options.theme_options, { accent: 'green' });
    assert.equal(backup.data.servers.length, 1);
    assert.equal(backup.data.ping_tasks.length, 1);
    assert.deepEqual(backup.data.ping_task_assignments, [{
      task_id: backup.data.ping_tasks[0].id,
      server_id: added.id
    }]);
    assert.equal(
      backup.manifest.checksum.value,
      await sha256Hex(JSON.stringify(backup.data))
    );
    await assert.rejects(
      createLogicalBackup(env.DB, { now: 0, maxBytes: 64 }),
      error => error instanceof LogicalBackupError && error.code === 'logicalBackupTooLarge'
    );

    const serialized = JSON.stringify(backup);
    for (const secret of [
      env.API_SECRET,
      sys.jwt_secret,
      'notification-secret-value',
      'private-chat-id',
      'turnstile-secret-value',
      'cloudflare-secret-value',
      'private-account-id',
      'private-login-name',
      'private-password-hash',
      'stored-jwt-secret-value',
      'audit-secret-value'
    ]) {
      assert.equal(serialized.includes(secret), false, `backup leaked ${secret}`);
    }

    const withoutR2Response = await handleAdminAPI(
      adminRequest({ action: 'logical_backup_r2_create' }, token),
      { ...env, BACKUP_BUCKET: undefined },
      sys
    );
    assert.equal(withoutR2Response.status, 400);
    assert.equal((await withoutR2Response.json()).error, 'logicalBackupR2Unavailable');

    const r2Response = await handleAdminAPI(
      adminRequest({ action: 'logical_backup_r2_create' }, token),
      env,
      sys
    );
    assert.equal(r2Response.status, 200);
    const storedResult = await r2Response.json();
    assert.match(
      storedResult.object.key,
      /^cfsm-logical-backups\/\d{4}\/\d{2}\/\d{2}\/cfsm-config-.*-[a-f0-9]{12}-[a-f0-9]{8}\.json$/
    );
    const storedObject = await env.BACKUP_BUCKET.get(storedResult.object.key);
    assert.ok(storedObject);
    assert.equal(storedObject.httpMetadata.contentType, 'application/json; charset=utf-8');
    assert.equal(storedObject.customMetadata.format, LOGICAL_BACKUP_FORMAT);
    const storedBackup = await storedObject.json();
    assert.equal(
      storedObject.customMetadata.data_sha256,
      await sha256Hex(JSON.stringify(storedBackup.data))
    );

    const auditResponse = await handleAdminAPI(
      adminRequest({ action: 'audit_list', page_size: 100 }, token),
      env,
      sys
    );
    const auditBody = await auditResponse.json();
    const eventTypes = new Set(auditBody.events.map(event => event.event_type));
    assert.equal(eventTypes.has('admin.backup.export'), true);
    assert.equal(eventTypes.has('admin.backup.r2_create'), true);
    assert.equal(JSON.stringify(auditBody.events).includes('notification-secret-value'), false);
  } finally {
    await miniflare.dispose();
  }
});
