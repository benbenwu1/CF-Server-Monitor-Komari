import assert from 'node:assert/strict';
import test from 'node:test';
import { Miniflare } from 'miniflare';

import {
  analyzeKomariSnapshot,
  buildKomariDailyReport,
  runKomariMonitor
} from '../src/services/komariMonitor.js';
import { initDatabase } from '../src/database/schema.js';
import { clearSiteSettingsCache, saveSiteOptions } from '../src/utils/settings.js';

const GIB = 1024 ** 3;

function node(overrides = {}) {
  return {
    uuid: 'node-a',
    name: 'Tokyo',
    traffic_limit: 500 * GIB,
    traffic_limit_type: 'sum',
    expired_at: '2026-09-14T00:00:00Z',
    ...overrides
  };
}

function status(overrides = {}) {
  return {
    online: true,
    net_total_up: 100 * GIB,
    net_total_down: 300 * GIB,
    ping: {
      5: { name: '电信', avg: 80, latest: 82, loss: 0 },
      6: { name: '联通', avg: 90, latest: 93, loss: 0 },
      7: { name: '移动', avg: 70, latest: 72, loss: 0 }
    },
    ...overrides
  };
}

test('daily Komari report includes remaining traffic, line quality, and expiry', () => {
  const message = buildKomariDailyReport(
    [node()],
    { 'node-a': status() },
    Date.parse('2026-08-22T00:00:00Z')
  );

  assert.match(message, /Tokyo - 在线/);
  assert.match(message, /流量 400\.00 GiB \/ 500\.00 GiB，剩余 100\.00 GiB \(20\.0%\)/);
  assert.match(message, /电信 80ms\/0\.0%/);
  assert.match(message, /有效期 2026-09-14/);
});

test('traffic alerts trigger at 80 percent and then each additional five percent', () => {
  const now = Date.parse('2026-08-22T01:00:00Z');
  const first = analyzeKomariSnapshot([node()], { 'node-a': status() }, null, now);
  assert.match(first.alerts.join('\n'), /流量已使用 80\.0%/);

  const duplicate = analyzeKomariSnapshot([node()], { 'node-a': status() }, first.state, now + 60_000);
  assert.equal(duplicate.alerts.length, 0);

  const next = analyzeKomariSnapshot([node()], {
    'node-a': status({ net_total_up: 125 * GIB, net_total_down: 300 * GIB })
  }, duplicate.state, now + 120_000);
  assert.match(next.alerts.join('\n'), /流量已使用 85\.0%/);
});

test('line alerts require five sustained minutes and emit recovery', () => {
  const now = Date.parse('2026-08-22T01:00:00Z');
  const badStatus = status({
    ping: {
      5: { name: '电信', avg: 240, latest: 250, loss: 12 },
      6: { name: '联通', avg: 90, latest: 93, loss: 0 },
      7: { name: '移动', avg: 70, latest: 72, loss: 0 }
    }
  });
  const first = analyzeKomariSnapshot([node({ traffic_limit: 0 })], { 'node-a': badStatus }, null, now);
  assert.equal(first.alerts.length, 0);

  const sustained = analyzeKomariSnapshot(
    [node({ traffic_limit: 0 })],
    { 'node-a': badStatus },
    first.state,
    now + 5 * 60_000
  );
  assert.match(sustained.alerts.join('\n'), /线路质量异常/);

  const recovered = analyzeKomariSnapshot(
    [node({ traffic_limit: 0 })],
    { 'node-a': status() },
    sustained.state,
    now + 6 * 60_000
  );
  assert.match(recovered.recoveries.join('\n'), /线路质量已恢复/);
});

test('offline alerts require three sustained minutes and emit recovery', () => {
  const now = Date.parse('2026-08-22T01:00:00Z');
  const first = analyzeKomariSnapshot(
    [node({ traffic_limit: 0 })],
    { 'node-a': status({ online: false, ping: {} }) },
    null,
    now
  );
  assert.equal(first.alerts.length, 0);

  const sustained = analyzeKomariSnapshot(
    [node({ traffic_limit: 0 })],
    { 'node-a': status({ online: false, ping: {} }) },
    first.state,
    now + 3 * 60_000
  );
  assert.match(sustained.alerts.join('\n'), /连续离线 3 分钟/);

  const recovered = analyzeKomariSnapshot(
    [node({ traffic_limit: 0 })],
    { 'node-a': status() },
    sustained.state,
    now + 4 * 60_000
  );
  assert.match(recovered.recoveries.join('\n'), /恢复在线/);
});

test('Komari monitor queues opaque notification jobs without leaking webhook credentials', async () => {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("OK"); } }',
    d1Databases: { DB: 'komari-monitor-test' }
  });
  const DB = await miniflare.getD1Database('DB');
  await initDatabase(DB);
  await saveSiteOptions(DB, {
    notification_provider: 'feishu',
    tg_bot_token: 'https://open.feishu.cn/open-apis/bot/v2/hook/private-test'
  });
  clearSiteSettingsCache();

  const queueMessages = [];
  const fetchImpl = async (_url, options) => {
    const request = JSON.parse(options.body);
    const result = request.method === 'public:getNodesInformation'
      ? [node()]
      : { 'node-a': status() };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), {
      headers: { 'Content-Type': 'application/json' }
    });
  };
  const env = {
    DB,
    KOMARI_MONITOR_URL: 'https://monitor.example.com',
    KOMARI_MONITOR_FETCH: fetchImpl,
    NOTIFICATION_QUEUE: {
      async send(body, options) {
        queueMessages.push({ body, options });
      }
    }
  };

  const result = await runKomariMonitor(
    env,
    new Date('2026-08-22T01:00:00Z'),
    async () => assert.fail('Queue-enabled monitor must not send synchronously')
  );
  assert.equal(result.checked, true);
  assert.equal(result.notifications, 1);
  assert.equal(result.node_count, 1);
  assert.equal(queueMessages.length, 1);

  const job = await DB.prepare(`
    SELECT source, status, message
    FROM notification_jobs
    ORDER BY created_at DESC
    LIMIT 1
  `).first();
  assert.equal(job.source, 'komari_monitor');
  assert.equal(job.status, 'queued');
  assert.match(job.message, /流量已使用 80\.0%/);
  assert.equal(job.message.includes('private-test'), false);

  await miniflare.dispose();
});
