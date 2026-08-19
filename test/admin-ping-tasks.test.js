import assert from 'node:assert/strict';
import test from 'node:test';
import { Miniflare } from 'miniflare';

import { initDatabase } from '../src/database/schema.js';
import { handleAdminAPI } from '../src/handlers/admin.js';
import { listAgentPingTasks } from '../src/services/pingTasks.js';

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

async function action(env, sys, token, body) {
  return handleAdminAPI(adminRequest(body, token), env, sys);
}

test('admin manages bounded ping tasks and default assignments through the admin interface', async () => {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("OK"); } }',
    d1Databases: { DB: 'admin-ping-tasks-test' }
  });
  const env = {
    DB: await miniflare.getD1Database('DB'),
    API_USER_NAME: 'ping-admin',
    API_SECRET: 'ping-admin-secret'
  };
  const sys = {
    username: env.API_USER_NAME,
    jwt_secret: 'ping-task-test-jwt-secret-32-characters'
  };

  try {
    await initDatabase(env.DB);
    const login = await handleAdminAPI(adminRequest({
      action: 'login',
      username: env.API_USER_NAME,
      password: env.API_SECRET
    }), env, sys);
    const { token } = await login.json();

    const firstServer = await (await action(env, sys, token, { action: 'add', name: 'first' })).json();
    const secondServer = await (await action(env, sys, token, { action: 'add', name: 'second' })).json();

    const invalid = await action(env, sys, token, {
      action: 'ping_task_create',
      name: 'too frequent',
      type: 'icmp',
      target: 'example.com',
      interval_seconds: 59,
      timeout_ms: 3000,
      server_ids: [firstServer.id]
    });
    assert.equal(invalid.status, 400);

    const createdResponse = await action(env, sys, token, {
      action: 'ping_task_create',
      name: 'Example HTTPS',
      type: 'http',
      target: 'https://example.com/health',
      interval_seconds: 300,
      timeout_ms: 5000,
      enabled: true,
      apply_to_new_servers: true,
      server_ids: [firstServer.id]
    });
    assert.equal(createdResponse.status, 200);
    const created = await createdResponse.json();
    assert.equal(created.success, true);
    assert.match(created.task.id, /^[0-9a-f-]{36}$/);

    const thirdServer = await (await action(env, sys, token, { action: 'add', name: 'third' })).json();
    const listResponse = await action(env, sys, token, { action: 'ping_task_list' });
    assert.equal(listResponse.status, 200);
    const listed = await listResponse.json();
    assert.deepEqual(listed.tasks.map(task => ({
      id: task.id,
      name: task.name,
      type: task.type,
      target: task.target,
      interval_seconds: task.interval_seconds,
      timeout_ms: task.timeout_ms,
      enabled: task.enabled,
      apply_to_new_servers: task.apply_to_new_servers,
      server_ids: task.server_ids
    })), [{
      id: created.task.id,
      name: 'Example HTTPS',
      type: 'http',
      target: 'https://example.com/health',
      interval_seconds: 300,
      timeout_ms: 5000,
      enabled: true,
      apply_to_new_servers: true,
      server_ids: [firstServer.id, thirdServer.id].sort()
    }]);
    assert.deepEqual(await listAgentPingTasks(env.DB, firstServer.id), [{
      id: created.task.id,
      name: 'Example HTTPS',
      type: 'http',
      target: 'https://example.com/health',
      interval_seconds: 300,
      timeout_ms: 5000
    }]);
    assert.deepEqual(await listAgentPingTasks(env.DB, secondServer.id), []);

    const serverCountBeforeFailedDefaultAssignment = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM servers'
    ).first();
    await env.DB.prepare(`
      CREATE TRIGGER fail_default_ping_assignment
      BEFORE INSERT ON ping_task_servers
      BEGIN
        SELECT RAISE(ABORT, 'forced default ping assignment failure');
      END
    `).run();
    const failedServerResponse = await action(env, sys, token, {
      action: 'add',
      name: 'must roll back'
    });
    assert.notEqual(failedServerResponse.status, 200);
    const serverCountAfterFailedDefaultAssignment = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM servers'
    ).first();
    assert.equal(
      Number(serverCountAfterFailedDefaultAssignment.count),
      Number(serverCountBeforeFailedDefaultAssignment.count),
      'server creation must roll back when default PingTask assignment fails'
    );
    await env.DB.prepare('DROP TRIGGER fail_default_ping_assignment').run();

    const updatedResponse = await action(env, sys, token, {
      action: 'ping_task_update',
      id: created.task.id,
      name: 'Example TCP',
      type: 'tcp',
      target: 'example.com:443',
      interval_seconds: 600,
      timeout_ms: 4000,
      apply_to_new_servers: false,
      server_ids: [secondServer.id]
    });
    assert.equal(updatedResponse.status, 200);
    const updated = await updatedResponse.json();
    assert.equal(updated.task.name, 'Example TCP');
    assert.equal(updated.task.enabled, true, 'omitting enabled must preserve the current state');
    assert.deepEqual(updated.task.server_ids, [secondServer.id]);

    const deletedResponse = await action(env, sys, token, {
      action: 'ping_task_delete',
      id: created.task.id
    });
    assert.equal(deletedResponse.status, 200);
    const afterDelete = await (await action(env, sys, token, { action: 'ping_task_list' })).json();
    assert.deepEqual(afterDelete.tasks, []);

    const now = Date.now();
    const capacityStatements = [];
    for (let index = 0; index < 11; index++) {
      const taskId = crypto.randomUUID();
      capacityStatements.push(env.DB.prepare(`
        INSERT INTO ping_tasks (
          id, name, type, target, interval_seconds, timeout_ms, enabled,
          sort_order, apply_to_new_servers, created_at, updated_at
        ) VALUES (?, ?, 'icmp', 'example.com', 300, 3000, 1, ?, 0, ?, ?)
      `).bind(taskId, `capacity-${index}`, index, now, now));
      if (index < 10) {
        capacityStatements.push(env.DB.prepare(`
          INSERT INTO ping_task_servers (task_id, server_id) VALUES (?, ?)
        `).bind(taskId, secondServer.id));
      } else {
        await env.DB.batch(capacityStatements);
        await assert.rejects(
          env.DB.prepare(`
            INSERT INTO ping_task_servers (task_id, server_id) VALUES (?, ?)
          `).bind(taskId, secondServer.id).run(),
          /ping_task_server_limit_exceeded/
        );
      }
    }
  } finally {
    await miniflare.dispose();
  }
});
