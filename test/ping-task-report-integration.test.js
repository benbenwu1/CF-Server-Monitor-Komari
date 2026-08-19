import assert from 'node:assert/strict';
import test from 'node:test';
import { Miniflare } from 'miniflare';

import { initDatabase } from '../src/database/schema.js';
import { MetricsBroadcaster } from '../src/durable/MetricsBroadcaster.js';
import { handleUpdate } from '../src/handlers/update.js';
import { createPingTask, listPingTaskHistory } from '../src/services/pingTasks.js';

globalThis.WebSocketRequestResponsePair ||= class WebSocketRequestResponsePair {
  constructor(request, response) {
    this.request = request;
    this.response = response;
  }
};

function makeBroadcaster(env) {
  return new MetricsBroadcaster({
    setWebSocketAutoResponse() {},
    getWebSockets() { return []; },
    storage: {
      async get() { return null; },
      async put() {}
    }
  }, env);
}

test('HTTP and WSS reports persist assigned PingTask results and receive schema 6 config', async () => {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("OK"); } }',
    d1Databases: { DB: 'ping-task-report-integration-test' }
  });
  const db = await miniflare.getD1Database('DB');
  const serverId = '11111111-1111-4111-8111-111111111111';
  const secret = 'integration-secret';

  try {
    await initDatabase(db);
    await db.prepare(`
      INSERT INTO servers (id, name, history_partition_id, timestamp)
      VALUES (?, 'integration server', 1, ?)
    `).bind(serverId, Date.now()).run();
    const { task } = await createPingTask(db, {
      name: 'Integration HTTPS',
      type: 'http',
      target: 'https://example.com/health',
      interval_seconds: 300,
      timeout_ms: 5000,
      enabled: true,
      server_ids: [serverId]
    });

    const httpTimestamp = Date.now();
    const httpResponse = await handleUpdate(new Request('https://monitor.example/update', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Agent-Config-Schema': '6',
        'X-Agent-Config-Md5': 'none'
      },
      body: JSON.stringify({
        id: serverId,
        secret,
        metrics: { cpu: 12, timestamp: httpTimestamp },
        ping_results: [{
          task_id: task.id,
          timestamp: httpTimestamp,
          latency_ms: 41,
          success: true
        }]
      })
    }), { DB: db, API_SECRET: secret }, { waitUntil() {} });

    assert.equal(httpResponse.status, 200);
    const httpConfig = new URLSearchParams(await httpResponse.text());
    assert.deepEqual(JSON.parse(httpConfig.get('ping_tasks')), [{
      id: task.id,
      name: 'Integration HTTPS',
      type: 'http',
      target: 'https://example.com/health',
      interval_seconds: 300,
      timeout_ms: 5000
    }]);
    assert.deepEqual(await listPingTaskHistory(db, {
      taskId: task.id,
      serverId,
      hours: 1
    }), [{ timestamp: httpTimestamp, latency_ms: 41, success: true }]);

    const broadcaster = makeBroadcaster({ DB: db, API_SECRET: secret });
    broadcaster._getAgentRealtimeState = () => ({
      frontendActive: false,
      resourceAlertActive: false,
      realtimeActive: false
    });
    broadcaster._cacheLatestReportUpdates = () => {};
    broadcaster._persistAgentHistoryIfDue = async () => ({
      persisted: false,
      nextD1WriteAfterMs: 60000
    });

    let attachment = {
      kind: 'agent-report',
      authenticated: true,
      serverId,
      historyPartitionId: 1,
      reportIntervalMs: 60000,
      configSchema: '6',
      configMd5: 'none'
    };
    const sent = [];
    const ws = {
      deserializeAttachment() { return attachment; },
      serializeAttachment(value) { attachment = value; },
      send(message) { sent.push(JSON.parse(message)); },
      close() {}
    };
    const wssTimestamp = httpTimestamp + 1;
    await broadcaster.webSocketMessage(ws, JSON.stringify({
      id: serverId,
      metrics: { cpu: 13, timestamp: wssTimestamp },
      config_schema: '6',
      config_md5: 'none',
      ping_results_batch_id: 'batch-1',
      ping_results: [{
        task_id: task.id,
        timestamp: wssTimestamp,
        latency_ms: -1,
        success: false
      }]
    }));

    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'ack');
    assert.equal(sent[0].ping_results_batch_id, 'batch-1');
    assert.equal(sent[0].ping_results_received, 1);
    const wssConfig = new URLSearchParams(sent[0].config_body);
    assert.deepEqual(JSON.parse(wssConfig.get('ping_tasks')), [{
      id: task.id,
      name: 'Integration HTTPS',
      type: 'http',
      target: 'https://example.com/health',
      interval_seconds: 300,
      timeout_ms: 5000
    }]);
    assert.deepEqual(await listPingTaskHistory(db, {
      taskId: task.id,
      serverId,
      hours: 1
    }), [
      { timestamp: httpTimestamp, latency_ms: 41, success: true },
      { timestamp: wssTimestamp, latency_ms: null, success: false }
    ]);
  } finally {
    await miniflare.dispose();
  }
});
