import assert from 'node:assert/strict';
import test from 'node:test';
import { Miniflare } from 'miniflare';

import { initDatabase } from '../src/database/schema.js';
import {
  createPingTask,
  defaultPingTaskAssignmentStatement,
  listAgentPingTasks,
  PingTaskError
} from '../src/services/pingTasks.js';

test('default assignments count only enabled tasks and reject an eleventh enabled default', async () => {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("OK"); } }',
    d1Databases: { DB: 'default-ping-task-capacity-test' }
  });
  const db = await miniflare.getD1Database('DB');
  const serverId = '33333333-3333-4333-8333-333333333333';

  try {
    await initDatabase(db);
    await createPingTask(db, {
      name: 'disabled default',
      type: 'icmp',
      target: 'disabled.example.com',
      interval_seconds: 300,
      timeout_ms: 3000,
      enabled: false,
      apply_to_new_servers: true,
      server_ids: []
    });
    for (let index = 0; index < 10; index++) {
      await createPingTask(db, {
        name: `enabled default ${index}`,
        type: 'icmp',
        target: `enabled-${index}.example.com`,
        interval_seconds: 300,
        timeout_ms: 3000,
        enabled: true,
        apply_to_new_servers: true,
        server_ids: []
      });
    }

    await assert.rejects(
      createPingTask(db, {
        name: 'eleventh enabled default',
        type: 'icmp',
        target: 'eleventh.example.com',
        interval_seconds: 300,
        timeout_ms: 3000,
        enabled: true,
        apply_to_new_servers: true,
        server_ids: []
      }),
      error => error instanceof PingTaskError && error.message === 'pingTaskServerLimitExceeded'
    );

    const now = Date.now();
    await assert.rejects(
      db.prepare(`
        INSERT INTO ping_tasks (
          id, name, type, target, interval_seconds, timeout_ms, enabled,
          sort_order, apply_to_new_servers, created_at, updated_at
        ) VALUES (?, 'direct eleventh default', 'icmp', 'direct.example.com', 300, 3000, 1, 99, 1, ?, ?)
      `).bind(crypto.randomUUID(), now, now).run(),
      /ping_task_server_limit_exceeded/
    );

    await db.batch([
      db.prepare(`
        INSERT INTO servers (id, name, history_partition_id, timestamp)
        VALUES (?, 'new server', 1, ?)
      `).bind(serverId, now),
      defaultPingTaskAssignmentStatement(db, serverId)
    ]);
    const assignmentCount = await db.prepare(`
      SELECT COUNT(*) AS count FROM ping_task_servers WHERE server_id = ?
    `).bind(serverId).first();
    assert.equal(Number(assignmentCount.count), 11, 'disabled defaults must not consume enabled capacity');
    assert.equal((await listAgentPingTasks(db, serverId)).length, 10);
  } finally {
    await miniflare.dispose();
  }
});
