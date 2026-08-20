import assert from 'node:assert/strict';
import test from 'node:test';
import { Miniflare } from 'miniflare';

import { initDatabase } from '../src/database/schema.js';
import worker from '../src/index.js';
import {
  cleanupNotificationJobs,
  dispatchNotification,
  finalizeExpiredNotificationJobs,
  processNotificationQueueBatch,
  recoverStagedNotificationJobs
} from '../src/services/notificationQueue.js';
import { clearSiteSettingsCache, saveSiteOptions } from '../src/utils/settings.js';

let miniflare;
let DB;

test.before(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("OK"); } }',
    d1Databases: { DB: 'notification-queue-test' }
  });
  DB = await miniflare.getD1Database('DB');
  await initDatabase(DB);
});

test.beforeEach(async () => {
  await DB.prepare('DELETE FROM notification_jobs').run();
  await DB.prepare('DELETE FROM notification_deliveries').run();
  await DB.prepare("DELETE FROM settings WHERE key = 'site_options'").run();
  clearSiteSettingsCache();
});

test.after(async () => {
  await miniflare.dispose();
});

test('automatic notifications stay synchronous when the Queue binding is absent', async () => {
  const calls = [];
  const sender = async (settings, message, context) => {
    calls.push({ settings, message, context });
    return {
      success: true,
      provider: 'telegram',
      attempts: 1,
      status_code: 200,
      error: null
    };
  };
  const env = { DB: { name: 'test-db' } };
  const settings = {
    notification_provider: 'telegram',
    tg_bot_token: 'private-token',
    tg_chat_id: 'private-target'
  };

  const result = await dispatchNotification(
    env,
    settings,
    'offline alert',
    'offline_alert',
    sender
  );

  assert.deepEqual(result, {
    success: true,
    provider: 'telegram',
    attempts: 1,
    status_code: 200,
    error: null
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].settings, settings);
  assert.equal(calls[0].message, 'offline alert');
  assert.deepEqual(calls[0].context, {
    db: env.DB,
    source: 'offline_alert'
  });
});

test('automatic notifications enqueue an opaque job reference without credentials', async () => {
  const queueMessages = [];
  const settings = {
    notification_provider: 'telegram',
    tg_bot_token: 'private-queue-token',
    tg_chat_id: 'private-queue-target'
  };
  const message = 'queued offline alert';

  const env = {
    DB,
    NOTIFICATION_QUEUE: {
      async send(body, options) {
        queueMessages.push({ body, options });
        return { metadata: { metrics: {} } };
      }
    }
  };

  const result = await dispatchNotification(
    env,
    settings,
    message,
    'offline_alert',
    async () => assert.fail('queued notifications must not send synchronously')
  );

  assert.equal(result.success, true);
  assert.equal(result.queued, true);
  assert.match(result.job_id, /^[0-9a-f-]{36}$/i);
  assert.deepEqual(queueMessages, [{
    body: { version: 1, job_id: result.job_id },
    options: { contentType: 'json' }
  }]);

  const queuedPayload = JSON.stringify(queueMessages);
  assert.equal(queuedPayload.includes(settings.tg_bot_token), false);
  assert.equal(queuedPayload.includes(settings.tg_chat_id), false);
  assert.equal(queuedPayload.includes(message), false);

  const job = await DB.prepare(`
    SELECT source, message, status, attempts
    FROM notification_jobs
    WHERE id = ?
  `).bind(result.job_id).first();
  assert.deepEqual(job, {
    source: 'offline_alert',
    message,
    status: 'queued',
    attempts: 0
  });
});

test('messages over the UTF-8 outbox limit use the synchronous compatibility path', async () => {
  const oversizedMessage = '🔔'.repeat(5000);
  let queueSends = 0;
  let synchronousSends = 0;
  const result = await dispatchNotification(
    {
      DB,
      NOTIFICATION_QUEUE: {
        async send() { queueSends += 1; }
      }
    },
    {},
    oversizedMessage,
    'resource_alert',
    async (_settings, message) => {
      synchronousSends += 1;
      assert.equal(message, oversizedMessage);
      return {
        success: true,
        provider: 'telegram',
        attempts: 1,
        status_code: 200,
        error: null
      };
    }
  );

  assert.equal(result.success, true);
  assert.equal(queueSends, 0);
  assert.equal(synchronousSends, 1);
  const jobCount = await DB.prepare(
    'SELECT COUNT(*) AS count FROM notification_jobs'
  ).first();
  assert.equal(jobCount.count, 0);
});

test('an enqueue failure falls back to synchronous delivery and completes the staged job', async () => {
  const settings = {
    notification_provider: 'telegram',
    tg_bot_token: 'private-fallback-token',
    tg_chat_id: 'private-fallback-target'
  };
  const senderCalls = [];
  const env = {
    DB,
    NOTIFICATION_QUEUE: {
      async send() {
        throw new Error('queue unavailable');
      }
    }
  };

  const result = await dispatchNotification(
    env,
    settings,
    'fallback alert',
    'recovery',
    async (actualSettings, message, context) => {
      senderCalls.push({ actualSettings, message, context });
      return {
        success: true,
        provider: 'telegram',
        attempts: 1,
        status_code: 200,
        error: null
      };
    }
  );

  assert.equal(result.success, true);
  assert.equal(result.queued, undefined);
  assert.equal(senderCalls.length, 1);
  assert.equal(senderCalls[0].actualSettings, settings);
  assert.equal(senderCalls[0].message, 'fallback alert');
  assert.deepEqual(senderCalls[0].context, { db: DB, source: 'recovery' });

  const jobs = await DB.prepare(`
    SELECT status, attempts, provider, status_code, error, completed_at
    FROM notification_jobs
  `).all();
  assert.equal(jobs.results.length, 1);
  assert.equal(jobs.results[0].status, 'delivered');
  assert.equal(jobs.results[0].attempts, 1);
  assert.equal(jobs.results[0].provider, 'telegram');
  assert.equal(jobs.results[0].status_code, 200);
  assert.equal(jobs.results[0].error, null);
  assert.equal(Number.isInteger(jobs.results[0].completed_at), true);
});

test('a post-enqueue state update failure does not trigger duplicate synchronous delivery', async () => {
  let queueSends = 0;
  let synchronousSends = 0;
  const dbWithQueuedUpdateFailure = {
    prepare(sql) {
      const statement = DB.prepare(sql);
      if (!sql.includes("SET status = 'queued', updated_at = ?")) return statement;
      return {
        bind(...values) {
          statement.bind(...values);
          return {
            async run() {
              throw new Error('simulated post-enqueue D1 failure');
            }
          };
        }
      };
    }
  };
  const result = await dispatchNotification(
    {
      DB: dbWithQueuedUpdateFailure,
      NOTIFICATION_QUEUE: {
        async send() {
          queueSends += 1;
          return { metadata: { metrics: {} } };
        }
      }
    },
    {
      notification_provider: 'telegram',
      tg_bot_token: 'post-enqueue-token',
      tg_chat_id: 'post-enqueue-target'
    },
    'accepted Queue alert',
    'offline_alert',
    async () => {
      synchronousSends += 1;
      return {
        success: true,
        provider: 'telegram',
        attempts: 1,
        status_code: 200,
        error: null
      };
    }
  );

  assert.equal(queueSends, 1);
  assert.equal(synchronousSends, 0);
  assert.equal(result.queued, true);
  const job = await DB.prepare(
    'SELECT status FROM notification_jobs WHERE id = ?'
  ).bind(result.job_id).first();
  assert.equal(job.status, 'staged');
});

test('a permanent synchronous fallback failure closes the staged job without future retries', async () => {
  const env = {
    DB,
    NOTIFICATION_QUEUE: {
      async send() {
        throw new Error('queue unavailable');
      }
    }
  };

  const result = await dispatchNotification(
    env,
    {
      notification_provider: 'telegram',
      tg_bot_token: 'permanent-fallback-token',
      tg_chat_id: ''
    },
    'permanent fallback alert',
    'expiration',
    async () => ({
      success: false,
      provider: 'telegram',
      attempts: 0,
      status_code: null,
      error: 'missing_target'
    })
  );

  assert.equal(result.success, false);
  const job = await DB.prepare(`
    SELECT status, attempts, provider, status_code, error, completed_at
    FROM notification_jobs
  `).first();
  assert.equal(job.status, 'failed');
  assert.equal(job.attempts, 0);
  assert.equal(job.provider, 'telegram');
  assert.equal(job.status_code, null);
  assert.equal(job.error, 'missing_target');
  assert.equal(Number.isInteger(job.completed_at), true);
});

test('the Queue consumer loads current credentials, delivers once, and acknowledges the message', async () => {
  const queueMessages = [];
  const env = {
    DB,
    NOTIFICATION_QUEUE: {
      async send(body) {
        queueMessages.push(body);
        return { metadata: { metrics: {} } };
      }
    }
  };
  await saveSiteOptions(DB, {
    notification_provider: 'telegram',
    tg_bot_token: 'current-consumer-token',
    tg_chat_id: 'current-consumer-target'
  });
  clearSiteSettingsCache();

  await dispatchNotification(
    env,
    {
      notification_provider: 'telegram',
      tg_bot_token: 'stale-producer-token',
      tg_chat_id: 'stale-producer-target'
    },
    'consumer success alert',
    'expiration',
    async () => assert.fail('the producer must not send synchronously')
  );

  let acknowledgements = 0;
  let retries = 0;
  const senderCalls = [];
  const queueMessage = {
    body: queueMessages[0],
    attempts: 1,
    ack() { acknowledgements += 1; },
    retry() { retries += 1; }
  };

  await processNotificationQueueBatch({
    queue: 'cf-server-monitor-notifications',
    messages: [queueMessage]
  }, env, async (settings, message, context) => {
    senderCalls.push({ settings, message, context });
    return {
      success: true,
      provider: 'telegram',
      attempts: 1,
      status_code: 200,
      error: null
    };
  });

  assert.equal(acknowledgements, 1);
  assert.equal(retries, 0);
  assert.equal(senderCalls.length, 1);
  assert.equal(senderCalls[0].settings.tg_bot_token, 'current-consumer-token');
  assert.equal(senderCalls[0].settings.tg_chat_id, 'current-consumer-target');
  assert.equal(senderCalls[0].message, 'consumer success alert');
  assert.deepEqual(senderCalls[0].context, { maxRetries: 1 });

  const job = await DB.prepare(`
    SELECT status, attempts, provider, status_code, error, completed_at
    FROM notification_jobs
  `).first();
  assert.equal(job.status, 'delivered');
  assert.equal(job.attempts, 1);
  assert.equal(job.provider, 'telegram');
  assert.equal(job.status_code, 200);
  assert.equal(job.error, null);
  assert.equal(Number.isInteger(job.completed_at), true);

  const delivery = await DB.prepare(`
    SELECT source, provider, status, attempts, status_code, error
    FROM notification_deliveries
  `).first();
  assert.deepEqual(delivery, {
    source: 'expiration',
    provider: 'telegram',
    status: 'delivered',
    attempts: 1,
    status_code: 200,
    error: null
  });
});

test('a transient Provider failure retries only that Queue message with exponential delay', async () => {
  const queueMessages = [];
  const env = {
    DB,
    NOTIFICATION_QUEUE: {
      async send(body) {
        queueMessages.push(body);
        return { metadata: { metrics: {} } };
      }
    }
  };
  await saveSiteOptions(DB, {
    notification_provider: 'telegram',
    tg_bot_token: 'transient-token',
    tg_chat_id: 'transient-target'
  });
  clearSiteSettingsCache();
  await dispatchNotification(
    env,
    {},
    'retry alert',
    'resource_alert',
    async () => assert.fail('the producer must not send synchronously')
  );

  let acknowledgements = 0;
  const retryOptions = [];
  const senderContexts = [];
  await processNotificationQueueBatch({
    queue: 'cf-server-monitor-notifications',
    messages: [{
      body: queueMessages[0],
      attempts: 1,
      ack() { acknowledgements += 1; },
      retry(options) { retryOptions.push(options); }
    }]
  }, env, async (_settings, _message, context) => {
    senderContexts.push(context);
    return {
      success: false,
      provider: 'telegram',
      attempts: 1,
      status_code: 503,
      error: 'HTTP_503'
    };
  });

  assert.equal(acknowledgements, 0);
  assert.deepEqual(retryOptions, [{ delaySeconds: 60 }]);
  assert.deepEqual(senderContexts, [{ maxRetries: 1 }]);
  const job = await DB.prepare(`
    SELECT status, attempts, provider, status_code, error, completed_at
    FROM notification_jobs
  `).first();
  assert.deepEqual(job, {
    status: 'queued',
    attempts: 1,
    provider: 'telegram',
    status_code: 503,
    error: 'HTTP_503',
    completed_at: null
  });
  const deliveryCount = await DB.prepare(
    'SELECT COUNT(*) AS count FROM notification_deliveries'
  ).first();
  assert.equal(deliveryCount.count, 0);
});

test('duplicate Queue messages share one persisted Provider attempt budget', async () => {
  const queueMessages = [];
  const env = {
    DB,
    NOTIFICATION_QUEUE: {
      async send(body) {
        queueMessages.push(body);
        return { metadata: { metrics: {} } };
      }
    }
  };
  await dispatchNotification(
    env,
    {},
    'duplicate delivery budget',
    'resource_alert',
    async () => assert.fail('the producer must not send synchronously')
  );

  let acknowledgements = 0;
  const retryOptions = [];
  let providerCalls = 0;
  const consumeDuplicate = async () => processNotificationQueueBatch({
    queue: 'cf-server-monitor-notifications',
    messages: [{
      body: queueMessages[0],
      attempts: 1,
      ack() { acknowledgements += 1; },
      retry(options) { retryOptions.push(options); }
    }]
  }, env, async () => {
    providerCalls += 1;
    return {
      success: false,
      provider: 'telegram',
      attempts: 1,
      status_code: 503,
      error: 'HTTP_503'
    };
  });

  await consumeDuplicate();
  await consumeDuplicate();
  await consumeDuplicate();
  await consumeDuplicate();

  assert.equal(providerCalls, 4);
  assert.equal(acknowledgements, 1);
  assert.deepEqual(retryOptions, [
    { delaySeconds: 60 },
    { delaySeconds: 120 },
    { delaySeconds: 240 }
  ]);
  const job = await DB.prepare(
    'SELECT status, attempts, error FROM notification_jobs'
  ).first();
  assert.deepEqual(job, { status: 'failed', attempts: 4, error: 'HTTP_503' });
  const delivery = await DB.prepare(
    'SELECT status, attempts, error FROM notification_deliveries'
  ).first();
  assert.deepEqual(delivery, { status: 'failed', attempts: 4, error: 'HTTP_503' });

  await consumeDuplicate();
  assert.equal(providerCalls, 4);
  assert.equal(acknowledgements, 2);
  const deliveryCount = await DB.prepare(
    'SELECT COUNT(*) AS count FROM notification_deliveries'
  ).first();
  assert.equal(deliveryCount.count, 1);
});

test('the final transient failure is persisted after the configured Queue attempt budget', async () => {
  const queueMessages = [];
  const env = {
    DB,
    NOTIFICATION_QUEUE: {
      async send(body) {
        queueMessages.push(body);
        return { metadata: { metrics: {} } };
      }
    }
  };
  await dispatchNotification(
    env,
    {},
    'final transient failure',
    'recovery',
    async () => assert.fail('the producer must not send synchronously')
  );

  let acknowledgements = 0;
  let retries = 0;
  for (let attempts = 1; attempts <= 4; attempts += 1) {
    await processNotificationQueueBatch({
      queue: 'cf-server-monitor-notifications',
      messages: [{
        body: queueMessages[0],
        attempts,
        ack() { acknowledgements += 1; },
        retry() { retries += 1; }
      }]
    }, env, async () => ({
      success: false,
      provider: 'telegram',
      attempts: 1,
      status_code: 503,
      error: 'HTTP_503'
    }));
  }

  assert.equal(acknowledgements, 1);
  assert.equal(retries, 3);
  const job = await DB.prepare(
    'SELECT status, attempts, error FROM notification_jobs'
  ).first();
  assert.deepEqual(job, {
    status: 'failed',
    attempts: 4,
    error: 'HTTP_503'
  });
  const delivery = await DB.prepare(
    'SELECT status, attempts, error FROM notification_deliveries'
  ).first();
  assert.deepEqual(delivery, {
    status: 'failed',
    attempts: 4,
    error: 'HTTP_503'
  });
});

test('an exception on the final claimed attempt closes the job before acknowledging', async () => {
  const queueMessages = [];
  const env = {
    DB,
    NOTIFICATION_QUEUE: {
      async send(body) {
        queueMessages.push(body);
        return { metadata: { metrics: {} } };
      }
    }
  };
  const queued = await dispatchNotification(
    env,
    {},
    'final attempt exception',
    'offline_alert',
    async () => assert.fail('the producer must not send synchronously')
  );
  await DB.prepare(
    'UPDATE notification_jobs SET attempts = 3 WHERE id = ?'
  ).bind(queued.job_id).run();

  let acknowledgements = 0;
  let retries = 0;
  await processNotificationQueueBatch({
    queue: 'cf-server-monitor-notifications',
    messages: [{
      body: queueMessages[0],
      attempts: 4,
      ack() { acknowledgements += 1; },
      retry() { retries += 1; }
    }]
  }, env, async () => {
    throw new Error('simulated consumer exception');
  });

  assert.equal(acknowledgements, 1);
  assert.equal(retries, 0);
  const job = await DB.prepare(
    'SELECT status, attempts, error FROM notification_jobs WHERE id = ?'
  ).bind(queued.job_id).first();
  assert.deepEqual(job, {
    status: 'failed',
    attempts: 4,
    error: 'consumer_exception'
  });
  const delivery = await DB.prepare(
    'SELECT status, attempts, error FROM notification_deliveries'
  ).first();
  assert.deepEqual(delivery, {
    status: 'failed',
    attempts: 4,
    error: 'consumer_exception'
  });
});

test('Cron finalizes an expired processing lease after the persisted attempt budget is exhausted', async () => {
  const queued = await dispatchNotification(
    {
      DB,
      NOTIFICATION_QUEUE: {
        async send() {
          return { metadata: { metrics: {} } };
        }
      }
    },
    {},
    'expired final attempt lease',
    'resource_alert',
    async () => assert.fail('the producer must not send synchronously')
  );
  const now = Date.now();
  await DB.prepare(`
    UPDATE notification_jobs
    SET status = 'processing', attempts = 4, locked_until = ?
    WHERE id = ?
  `).bind(now - 1, queued.job_id).run();

  const finalized = await finalizeExpiredNotificationJobs({
    DB,
    NOTIFICATION_QUEUE: {}
  }, now);

  assert.equal(finalized, 1);
  const job = await DB.prepare(
    'SELECT status, attempts, error, locked_until FROM notification_jobs WHERE id = ?'
  ).bind(queued.job_id).first();
  assert.deepEqual(job, {
    status: 'failed',
    attempts: 4,
    error: 'attempt_budget_exhausted',
    locked_until: null
  });
  const delivery = await DB.prepare(
    'SELECT status, attempts, error FROM notification_deliveries'
  ).first();
  assert.deepEqual(delivery, {
    status: 'failed',
    attempts: 4,
    error: 'attempt_budget_exhausted'
  });
});

test('a permanent Provider configuration error is recorded and acknowledged without retry', async () => {
  const queueMessages = [];
  const env = {
    DB,
    NOTIFICATION_QUEUE: {
      async send(body) {
        queueMessages.push(body);
        return { metadata: { metrics: {} } };
      }
    }
  };
  await saveSiteOptions(DB, {
    notification_provider: 'telegram',
    tg_bot_token: 'permanent-error-token',
    tg_chat_id: ''
  });
  clearSiteSettingsCache();
  await dispatchNotification(
    env,
    {},
    'permanent error alert',
    'offline_alert',
    async () => assert.fail('the producer must not send synchronously')
  );

  let acknowledgements = 0;
  let retries = 0;
  await processNotificationQueueBatch({
    queue: 'cf-server-monitor-notifications',
    messages: [{
      body: queueMessages[0],
      attempts: 1,
      ack() { acknowledgements += 1; },
      retry() { retries += 1; }
    }]
  }, env, async () => ({
    success: false,
    provider: 'telegram',
    attempts: 0,
    status_code: null,
    error: 'missing_target'
  }));

  assert.equal(acknowledgements, 1);
  assert.equal(retries, 0);
  const job = await DB.prepare(`
    SELECT status, attempts, provider, status_code, error, completed_at
    FROM notification_jobs
  `).first();
  assert.equal(job.status, 'failed');
  assert.equal(job.attempts, 1);
  assert.equal(job.provider, 'telegram');
  assert.equal(job.status_code, null);
  assert.equal(job.error, 'missing_target');
  assert.equal(Number.isInteger(job.completed_at), true);

  const delivery = await DB.prepare(`
    SELECT source, provider, status, attempts, status_code, error
    FROM notification_deliveries
  `).first();
  assert.deepEqual(delivery, {
    source: 'offline_alert',
    provider: 'telegram',
    status: 'failed',
    attempts: 0,
    status_code: null,
    error: 'missing_target'
  });
});

test('a staged job survives transient enqueue and fallback failures for later Queue recovery', async () => {
  const recoveredMessages = [];
  let queueAvailable = false;
  const env = {
    DB,
    NOTIFICATION_QUEUE: {
      async send(body, options) {
        if (!queueAvailable) throw new Error('queue unavailable');
        recoveredMessages.push({ body, options });
        return { metadata: { metrics: {} } };
      }
    }
  };

  const result = await dispatchNotification(
    env,
    {
      notification_provider: 'telegram',
      tg_bot_token: 'recovery-token',
      tg_chat_id: 'recovery-target'
    },
    'recover staged alert',
    'resource_alert',
    async () => ({
      success: false,
      provider: 'telegram',
      attempts: 3,
      status_code: null,
      error: 'network_error'
    })
  );
  assert.equal(result.success, false);

  const staged = await DB.prepare(
    'SELECT id, status, available_at FROM notification_jobs'
  ).first();
  assert.equal(staged.status, 'staged');

  queueAvailable = true;
  const recovered = await recoverStagedNotificationJobs(env, staged.available_at + 1);
  assert.equal(recovered, 1);
  assert.deepEqual(recoveredMessages, [{
    body: { version: 1, job_id: staged.id },
    options: { contentType: 'json' }
  }]);
  const queued = await DB.prepare(
    'SELECT status FROM notification_jobs WHERE id = ?'
  ).bind(staged.id).first();
  assert.equal(queued.status, 'queued');
});

test('the Worker queue entrypoint consumes notification jobs with the production sender', async () => {
  const queuedBodies = [];
  const env = {
    DB,
    NOTIFICATION_QUEUE: {
      async send(body) {
        queuedBodies.push(body);
        return { metadata: { metrics: {} } };
      }
    }
  };
  await saveSiteOptions(DB, {
    notification_provider: 'telegram',
    tg_bot_token: 'entrypoint-token',
    tg_chat_id: 'entrypoint-target'
  });
  clearSiteSettingsCache();
  await dispatchNotification(
    env,
    {},
    'entrypoint alert',
    'expiration',
    async () => assert.fail('the producer must not send synchronously')
  );

  const realFetch = globalThis.fetch;
  let acknowledgements = 0;
  let providerRequests = 0;
  globalThis.fetch = async () => {
    providerRequests += 1;
    return new Response('', { status: 200 });
  };
  try {
    assert.equal(typeof worker.queue, 'function');
    const createMessage = () => ({
        body: queuedBodies[0],
        attempts: 1,
        ack() { acknowledgements += 1; },
        retry() { assert.fail('successful delivery must not retry'); }
    });
    await worker.queue({
      queue: 'cf-server-monitor-notifications',
      messages: [createMessage()]
    }, env, {});
    await worker.queue({
      queue: 'cf-server-monitor-notifications',
      messages: [createMessage()]
    }, env, {});
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(acknowledgements, 2);
  assert.equal(providerRequests, 1);
  const job = await DB.prepare('SELECT status FROM notification_jobs').first();
  assert.equal(job.status, 'delivered');
});

test('completed and abandoned notification jobs expire after the bounded retention window', async () => {
  const now = Date.now();
  const old = now - (31 * 24 * 60 * 60 * 1000);
  const recentId = crypto.randomUUID();
  const oldDeliveredId = crypto.randomUUID();
  const oldStagedId = crypto.randomUUID();
  const statement = `
    INSERT INTO notification_jobs (
      id, source, message, status, attempts, available_at, created_at, updated_at, completed_at
    ) VALUES (?, 'offline_alert', 'bounded retention', ?, 0, ?, ?, ?, ?)
  `;
  await DB.batch([
    DB.prepare(statement).bind(recentId, 'queued', now, now, now, null),
    DB.prepare(statement).bind(oldDeliveredId, 'delivered', old, old, old, old),
    DB.prepare(statement).bind(oldStagedId, 'staged', old, old, old, null)
  ]);

  const deleted = await cleanupNotificationJobs(DB, now);
  assert.equal(deleted, 2);
  const remaining = await DB.prepare(
    'SELECT id FROM notification_jobs ORDER BY id'
  ).all();
  assert.deepEqual(remaining.results.map(row => row.id), [recentId]);
});
