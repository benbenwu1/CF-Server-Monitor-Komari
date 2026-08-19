import assert from 'node:assert/strict';
import test from 'node:test';
import { Miniflare } from 'miniflare';

import { initDatabase } from '../src/database/schema.js';
import { handlePingTaskHistory, handlePingTaskList } from '../src/handlers/pingTasks.js';
import {
  createPingTask,
  listPingTaskHistory,
  MAX_PING_HISTORY_RESULTS_PER_TASK,
  normalizePingTaskInput,
  PingTaskError,
  savePingTaskResults
} from '../src/services/pingTasks.js';

test('ping task results are assignment-scoped, idempotent, and bounded', async () => {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("OK"); } }',
    d1Databases: { DB: 'ping-task-results-test' }
  });
  const db = await miniflare.getD1Database('DB');
  const assignedServer = '11111111-1111-4111-8111-111111111111';
  const otherServer = '22222222-2222-4222-8222-222222222222';

  try {
    await initDatabase(db);
    await db.batch([
      db.prepare(`
        INSERT INTO servers (id, name, history_partition_id, timestamp)
        VALUES (?, 'assigned', 1, ?)
      `).bind(assignedServer, Date.now()),
      db.prepare(`
        INSERT INTO servers (id, name, history_partition_id, timestamp)
        VALUES (?, 'other', 2, ?)
      `).bind(otherServer, Date.now())
    ]);
    const { task } = await createPingTask(db, {
      name: 'Example ICMP',
      type: 'icmp',
      target: 'example.com',
      interval_seconds: 300,
      timeout_ms: 3000,
      enabled: true,
      server_ids: [assignedServer]
    });
    const now = Date.now();
    const result = {
      task_id: task.id,
      timestamp: now,
      latency_ms: 42,
      success: true
    };

    assert.deepEqual(await savePingTaskResults(db, assignedServer, [result], now), {
      accepted: 1,
      rejected: 0
    });
    assert.deepEqual(await savePingTaskResults(db, assignedServer, [result], now), {
      accepted: 0,
      rejected: 1
    });
    assert.deepEqual(await savePingTaskResults(db, otherServer, [result], now), {
      accepted: 0,
      rejected: 1
    });
    assert.deepEqual(
      await savePingTaskResults(db, assignedServer, [result], now, 'batch-1'),
      { accepted: 0, rejected: 1, batch_id: 'batch-1', received: 1 }
    );
    await assert.rejects(
      savePingTaskResults(db, assignedServer, [result], now, 'invalid batch id'),
      error => error instanceof PingTaskError && error.message === 'invalidPingTaskResults'
    );

    assert.deepEqual(await listPingTaskHistory(db, {
      taskId: task.id,
      serverId: assignedServer,
      hours: 1
    }), [{ timestamp: now, latency_ms: 42, success: true }]);

    const env = { DB: db, API_USER_NAME: 'admin', API_SECRET: 'secret' };
    const settings = { is_public: 'true', username: 'admin', jwt_secret: 'x'.repeat(32) };
    const publicListResponse = await handlePingTaskList(
      new Request('https://monitor.example/api/ping-tasks'),
      env,
      settings
    );
    const publicList = await publicListResponse.json();
    assert.equal(publicList.tasks.length, 1);
    assert.equal(Object.hasOwn(publicList.tasks[0], 'target'), false);

    const publicHistoryResponse = await handlePingTaskHistory(
      new Request(`https://monitor.example/api/ping-history?task_id=${task.id}&server_id=${assignedServer}&hours=1`),
      env,
      settings
    );
    assert.equal(publicHistoryResponse.status, 200);
    assert.deepEqual((await publicHistoryResponse.json()).results, [
      { timestamp: now, latency_ms: 42, success: true }
    ]);

    const serverHistoryResponse = await handlePingTaskHistory(
      new Request(`https://monitor.example/api/ping-history?server_id=${assignedServer}&hours=1`),
      env,
      settings
    );
    assert.equal(serverHistoryResponse.status, 200);
    const serverHistory = await serverHistoryResponse.json();
    assert.deepEqual(serverHistory.series, [{
      task: {
        id: task.id,
        name: 'Example ICMP',
        type: 'icmp',
        interval_seconds: 300,
        timeout_ms: 3000
      },
      results: [{ timestamp: now, latency_ms: 42, success: true }]
    }]);

    const olderRows = Array.from(
      { length: MAX_PING_HISTORY_RESULTS_PER_TASK + 2 },
      (_, index) => db.prepare(`
        INSERT INTO ping_task_results (task_id, server_id, timestamp, latency_ms, success)
        VALUES (?, ?, ?, 10, 1)
      `).bind(task.id, assignedServer, now - index - 1)
    );
    for (let offset = 0; offset < olderRows.length; offset += 100) {
      await db.batch(olderRows.slice(offset, offset + 100));
    }
    const boundedHistory = await listPingTaskHistory(db, {
      taskId: task.id,
      serverId: assignedServer,
      hours: 1
    });
    assert.equal(boundedHistory.length, MAX_PING_HISTORY_RESULTS_PER_TASK);
    assert.equal(boundedHistory[0].timestamp, now - MAX_PING_HISTORY_RESULTS_PER_TASK + 1);
    assert.equal(boundedHistory.at(-1).timestamp, now);
    const boundedServerResponse = await handlePingTaskHistory(
      new Request(`https://monitor.example/api/ping-history?server_id=${assignedServer}&hours=1`),
      env,
      settings
    );
    const boundedServerHistory = await boundedServerResponse.json();
    assert.equal(
      boundedServerHistory.series[0].results.length,
      MAX_PING_HISTORY_RESULTS_PER_TASK
    );
    assert.equal(
      boundedServerHistory.series[0].results[0].timestamp,
      now - MAX_PING_HISTORY_RESULTS_PER_TASK + 1
    );
    assert.equal(boundedServerHistory.series[0].results.at(-1).timestamp, now);

    await assert.rejects(
      savePingTaskResults(db, assignedServer, Array.from({ length: 21 }, () => result), now),
      error => error instanceof PingTaskError && error.message === 'invalidPingTaskResults'
    );
  } finally {
    await miniflare.dispose();
  }
});

test('ping task names use Unicode characters instead of UTF-16 code units for the limit', () => {
  assert.equal(normalizePingTaskInput({
    name: '📡'.repeat(100),
    type: 'icmp',
    target: 'example.com',
    interval_seconds: 300,
    timeout_ms: 3000,
    server_ids: []
  }).name, '📡'.repeat(100));
  assert.throws(
    () => normalizePingTaskInput({
      name: '📡'.repeat(101),
      type: 'icmp',
      target: 'example.com',
      interval_seconds: 300,
      timeout_ms: 3000,
      server_ids: []
    }),
    error => error instanceof PingTaskError && error.message === 'invalidPingTaskName'
  );
  assert.throws(
    () => normalizePingTaskInput({
      name: 'invalid IPv6',
      type: 'icmp',
      target: '::::',
      interval_seconds: 300,
      timeout_ms: 3000,
      server_ids: []
    }),
    error => error instanceof PingTaskError && error.message === 'invalidPingTaskTarget'
  );
});
