import assert from 'node:assert/strict';
import test from 'node:test';
import { Miniflare } from 'miniflare';

import { initDatabase, saveMetricsHistory } from '../src/database/schema.js';
import {
  processNotificationQueueBatch,
  recoverStagedNotificationJobs
} from '../src/services/notificationQueue.js';
import { runScheduledTrafficReport } from '../src/services/trafficReport.js';
import { clearAllCaches } from '../src/utils/cache.js';
import {
  clearSiteSettingsCache,
  normalizeTrafficReportSchedule,
  saveSiteOptions
} from '../src/utils/settings.js';

let miniflare;
let DB;

test.before(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("OK"); } }',
    d1Databases: { DB: 'traffic-report-test' }
  });
  DB = await miniflare.getD1Database('DB');
  await initDatabase(DB);
});

test.beforeEach(async () => {
  await DB.batch([
    DB.prepare('DELETE FROM traffic_report_runs'),
    DB.prepare('DELETE FROM notification_jobs'),
    DB.prepare('DELETE FROM notification_deliveries'),
    DB.prepare('DELETE FROM metrics_history'),
    DB.prepare('DELETE FROM servers'),
    DB.prepare("DELETE FROM settings WHERE key = 'site_options'")
  ]);
  clearAllCaches();
  clearSiteSettingsCache();
});

test.after(async () => {
  await miniflare.dispose();
});

test('traffic report schedules are explicit and default to disabled', () => {
  assert.equal(normalizeTrafficReportSchedule(), 'off');
  assert.equal(normalizeTrafficReportSchedule('daily'), 'daily');
  assert.equal(normalizeTrafficReportSchedule('weekly'), 'weekly');
  assert.equal(normalizeTrafficReportSchedule('monthly'), 'monthly');
  assert.equal(normalizeTrafficReportSchedule('hourly'), 'off');
});

test('disabled traffic reports do not read servers or send notifications', async () => {
  const result = await runScheduledTrafficReport(
    { DB },
    new Date('2026-08-19T03:00:00.000Z'),
    async () => assert.fail('disabled reports must not send')
  );

  assert.deepEqual(result, { sent: false, reason: 'disabled' });
  const runs = await DB.prepare('SELECT COUNT(*) AS count FROM traffic_report_runs').first();
  assert.equal(runs.count, 0);
});

test('daily traffic snapshots use current billing counters and send once per UTC period', async () => {
  await saveSiteOptions(DB, {
    traffic_report_schedule: 'daily',
    notification_provider: 'telegram',
    tg_bot_token: 'traffic-report-token',
    tg_chat_id: 'traffic-report-target'
  });
  await DB.batch([
    DB.prepare(`
      INSERT INTO servers (
        id, name, traffic_limit, traffic_calc_type, history_partition_id, sort_order
      ) VALUES ('server-a', 'Alpha', '10', 'total', 1, 0)
    `),
    DB.prepare(`
      INSERT INTO servers (
        id, name, traffic_limit, traffic_calc_type, history_partition_id, sort_order
      ) VALUES ('server-b', 'Beta', '', 'max', 2, 1)
    `)
  ]);
  const metricTime = Date.parse('2026-08-19T02:59:00.000Z');
  await saveMetricsHistory(DB, 'server-a', 1, {
    net_rx_monthly: 3 * 1024 ** 3,
    net_tx_monthly: 2 * 1024 ** 3
  }, '', metricTime);
  await saveMetricsHistory(DB, 'server-b', 2, {
    net_rx_monthly: 1024 ** 3,
    net_tx_monthly: 4 * 1024 ** 3
  }, '', metricTime);
  clearAllCaches();
  clearSiteSettingsCache();

  const messages = [];
  const sender = async (settings, message, context) => {
    messages.push({ settings, message, context });
    return {
      success: true,
      provider: 'telegram',
      attempts: 1,
      status_code: 200,
      error: null
    };
  };
  const now = new Date('2026-08-19T03:00:00.000Z');
  const first = await runScheduledTrafficReport({ DB }, now, sender);
  const duplicate = await runScheduledTrafficReport({ DB }, now, sender);
  const nextDay = await runScheduledTrafficReport(
    { DB },
    new Date('2026-08-20T03:00:00.000Z'),
    sender
  );

  assert.equal(first.sent, true);
  assert.equal(first.period_key, 'daily:2026-08-19');
  assert.deepEqual(duplicate, {
    sent: false,
    reason: 'already_processed',
    period_key: 'daily:2026-08-19'
  });
  assert.equal(nextDay.sent, true);
  assert.equal(nextDay.period_key, 'daily:2026-08-20');
  assert.equal(messages.length, 2);
  assert.equal(messages[0].settings.tg_bot_token, 'traffic-report-token');
  assert.equal(messages[0].context.db, DB);
  assert.equal(messages[0].context.source, 'traffic_report');
  assert.match(messages[0].message, /每日 · 当前账期流量快照/);
  assert.match(messages[0].message, /Alpha - 5\.00 GB \/ 10\.00 GB \(50\.0%\)/);
  assert.match(messages[0].message, /Beta - 4\.00 GB \/ 不限/);
  assert.match(messages[0].message, /\*\*合计:\*\* 9\.00 GB/);

  const runs = await DB.prepare(`
    SELECT period_key, status
    FROM traffic_report_runs
    ORDER BY period_key
  `).all();
  assert.deepEqual(runs.results, [
    { period_key: 'daily:2026-08-19', status: 'delivered' },
    { period_key: 'daily:2026-08-20', status: 'delivered' }
  ]);
});

test('traffic snapshots reuse the opaque notification Queue contract', async () => {
  await saveSiteOptions(DB, {
    traffic_report_schedule: 'weekly',
    notification_provider: 'telegram',
    tg_bot_token: 'queued-traffic-token',
    tg_chat_id: 'queued-traffic-target'
  });
  await DB.prepare(`
    INSERT INTO servers (
      id, name, traffic_limit, traffic_calc_type, history_partition_id, sort_order
    ) VALUES ('server-queue', 'Queued server', '100', 'total', 1, 0)
  `).run();
  clearAllCaches();
  clearSiteSettingsCache();

  const queueMessages = [];
  const env = {
    DB,
    NOTIFICATION_QUEUE: {
      async send(body, options) {
        queueMessages.push({ body, options });
        return { metadata: { metrics: {} } };
      }
    }
  };
  const result = await runScheduledTrafficReport(
    env,
    new Date('2026-08-19T03:00:00.000Z'),
    async () => assert.fail('queued reports must not call the Provider synchronously')
  );

  assert.equal(result.sent, true);
  assert.equal(result.period_key, 'weekly:2026-08-17');
  assert.equal(result.delivery.queued, true);
  assert.deepEqual(queueMessages, [{
    body: { version: 1, job_id: result.delivery.job_id },
    options: { contentType: 'json' }
  }]);
  const serializedQueueMessage = JSON.stringify(queueMessages);
  assert.equal(serializedQueueMessage.includes('queued-traffic-token'), false);
  assert.equal(serializedQueueMessage.includes('Queued server'), false);

  const job = await DB.prepare(`
    SELECT source, status, message
    FROM notification_jobs
    WHERE id = ?
  `).bind(result.delivery.job_id).first();
  assert.equal(job.source, 'traffic_report');
  assert.equal(job.status, 'queued');
  assert.match(job.message, /每周 · 当前账期流量快照/);
  const run = await DB.prepare(`
    SELECT status, notification_job_id, completed_at
    FROM traffic_report_runs
  `).first();
  assert.deepEqual(run, {
    status: 'queued',
    notification_job_id: result.delivery.job_id,
    completed_at: null
  });

  let acknowledgements = 0;
  await processNotificationQueueBatch({
    queue: 'cf-server-monitor-notifications',
    messages: [{
      body: queueMessages[0].body,
      attempts: 1,
      ack() { acknowledgements += 1; },
      retry() { assert.fail('successful report delivery must not retry'); }
    }]
  }, env, async () => ({
    success: true,
    provider: 'telegram',
    attempts: 1,
    status_code: 200,
    error: null
  }));
  assert.equal(acknowledgements, 1);
  const completedRun = await DB.prepare(`
    SELECT status, error
    FROM traffic_report_runs
  `).first();
  assert.deepEqual(completedRun, { status: 'delivered', error: null });
});

test('a traffic report reconciles a terminal Queue job before producer finalization', async () => {
  await saveSiteOptions(DB, {
    traffic_report_schedule: 'daily',
    notification_provider: 'telegram',
    tg_bot_token: 'fast-consumer-token',
    tg_chat_id: 'fast-consumer-target'
  });
  await DB.prepare(`
    INSERT INTO servers (
      id, name, traffic_limit, traffic_calc_type, history_partition_id, sort_order
    ) VALUES ('server-fast-consumer', 'Fast consumer', '100', 'total', 1, 0)
  `).run();
  clearAllCaches();
  clearSiteSettingsCache();

  let acknowledgements = 0;
  let providerResult = {
    success: true,
    provider: 'telegram',
    attempts: 1,
    status_code: 200,
    error: null
  };
  const provider = async () => providerResult;
  const env = { DB };
  env.NOTIFICATION_QUEUE = {
    async send(body) {
      await processNotificationQueueBatch({
        queue: 'cf-server-monitor-notifications',
        messages: [{
          body,
          attempts: 1,
          ack() { acknowledgements += 1; },
          retry() { assert.fail('successful fast delivery must not retry'); }
        }]
      }, env, provider);
      return { metadata: { metrics: {} } };
    }
  };

  const report = await runScheduledTrafficReport(
    env,
    new Date('2026-08-19T03:00:00.000Z'),
    provider
  );

  assert.equal(report.delivery.queued, true);
  assert.equal(acknowledgements, 1);
  const job = await DB.prepare(
    'SELECT status FROM notification_jobs WHERE id = ?'
  ).bind(report.delivery.job_id).first();
  const run = await DB.prepare(`
    SELECT status, notification_job_id, completed_at
    FROM traffic_report_runs
    WHERE period_key = ?
  `).bind(report.period_key).first();
  assert.equal(job.status, 'delivered');
  assert.equal(run.status, 'delivered');
  assert.equal(run.notification_job_id, report.delivery.job_id);
  assert.equal(Number.isInteger(run.completed_at), true);

  providerResult = {
    success: false,
    provider: 'telegram',
    attempts: 1,
    status_code: 400,
    error: 'HTTP_400'
  };
  const failedReport = await runScheduledTrafficReport(
    env,
    new Date('2026-08-20T03:00:00.000Z'),
    provider
  );
  const failedJob = await DB.prepare(
    'SELECT status, error FROM notification_jobs WHERE id = ?'
  ).bind(failedReport.delivery.job_id).first();
  const failedRun = await DB.prepare(`
    SELECT status, notification_job_id, error, completed_at
    FROM traffic_report_runs
    WHERE period_key = ?
  `).bind(failedReport.period_key).first();
  assert.equal(acknowledgements, 2);
  assert.deepEqual(failedJob, { status: 'failed', error: 'HTTP_400' });
  assert.equal(failedRun.status, 'failed');
  assert.equal(failedRun.notification_job_id, failedReport.delivery.job_id);
  assert.equal(failedRun.error, 'HTTP_400');
  assert.equal(Number.isInteger(failedRun.completed_at), true);
});

test('a report remains linked to its staged outbox job until Queue recovery completes', async () => {
  await saveSiteOptions(DB, {
    traffic_report_schedule: 'monthly',
    notification_provider: 'telegram',
    tg_bot_token: 'staged-report-token',
    tg_chat_id: 'staged-report-target'
  });
  await DB.prepare(`
    INSERT INTO servers (
      id, name, traffic_limit, traffic_calc_type, history_partition_id, sort_order
    ) VALUES ('server-staged', 'Staged report', '100', 'total', 1, 0)
  `).run();
  clearAllCaches();
  clearSiteSettingsCache();

  let queueAvailable = false;
  const queueMessages = [];
  const env = {
    DB,
    NOTIFICATION_QUEUE: {
      async send(body) {
        if (!queueAvailable) throw new Error('queue unavailable');
        queueMessages.push(body);
        return { metadata: { metrics: {} } };
      }
    }
  };
  const report = await runScheduledTrafficReport(
    env,
    new Date('2026-08-19T03:00:00.000Z'),
    async () => ({
      success: false,
      provider: 'telegram',
      attempts: 3,
      status_code: null,
      error: 'network_error'
    })
  );

  assert.equal(report.sent, false);
  assert.equal(report.delivery.pending, true);
  assert.match(report.delivery.job_id, /^[0-9a-f-]{36}$/i);
  let run = await DB.prepare(`
    SELECT status, notification_job_id, completed_at
    FROM traffic_report_runs
  `).first();
  assert.deepEqual(run, {
    status: 'staged',
    notification_job_id: report.delivery.job_id,
    completed_at: null
  });

  const job = await DB.prepare(
    'SELECT available_at FROM notification_jobs WHERE id = ?'
  ).bind(report.delivery.job_id).first();
  queueAvailable = true;
  assert.equal(await recoverStagedNotificationJobs(env, job.available_at + 1), 1);
  run = await DB.prepare('SELECT status, completed_at FROM traffic_report_runs').first();
  assert.deepEqual(run, { status: 'queued', completed_at: null });

  let acknowledgements = 0;
  await processNotificationQueueBatch({
    queue: 'cf-server-monitor-notifications',
    messages: [{
      body: queueMessages[0],
      attempts: 1,
      ack() { acknowledgements += 1; },
      retry() { assert.fail('recovered report must not retry after success'); }
    }]
  }, env, async () => ({
    success: true,
    provider: 'telegram',
    attempts: 1,
    status_code: 200,
    error: null
  }));
  assert.equal(acknowledgements, 1);
  run = await DB.prepare('SELECT status FROM traffic_report_runs').first();
  assert.equal(run.status, 'delivered');
});
