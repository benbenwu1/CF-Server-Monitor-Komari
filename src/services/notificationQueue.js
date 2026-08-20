import { loadSiteSettings } from '../utils/settings.js';
import { createNotificationDeliveryStatement } from './notificationDelivery.js';

const NOTIFICATION_QUEUE_MESSAGE_VERSION = 1;
const NOTIFICATION_JOB_MESSAGE_MAX_BYTES = 16 * 1024;
const NOTIFICATION_JOB_SOURCE_MAX_LENGTH = 64;
const NOTIFICATION_JOB_STAGED_RECOVERY_DELAY_MS = 5 * 60 * 1000;
const NOTIFICATION_JOB_LEASE_MS = 45 * 1000;
const NOTIFICATION_QUEUE_RETRY_DELAY_SECONDS = 60;
const NOTIFICATION_QUEUE_MAX_ATTEMPTS = 4;
const NOTIFICATION_JOB_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function cleanSource(value) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, NOTIFICATION_JOB_SOURCE_MAX_LENGTH) || 'unknown';
}

async function finalizeStagedJobAfterFallback(db, jobId, result) {
  if (!db || !jobId) return;
  if (!result?.success && isRetryableDeliveryResult(result)) return;

  const now = Date.now();
  try {
    await db.prepare(`
      UPDATE notification_jobs
      SET status = ?,
          attempts = ?,
          provider = ?,
          status_code = ?,
          error = ?,
          locked_until = NULL,
          updated_at = ?,
          completed_at = ?
      WHERE id = ? AND status = 'staged'
    `).bind(
      result?.success ? 'delivered' : 'failed',
      Number.isInteger(result?.attempts) ? result.attempts : 0,
      String(result?.provider || 'unknown').slice(0, 32),
      Number.isInteger(result?.status_code) ? result.status_code : null,
      result?.success ? null : String(result?.error || 'delivery_failed').slice(0, 100),
      now,
      now,
      jobId
    ).run();
  } catch (error) {
    console.error(JSON.stringify({
      event: 'notification.queue.fallback_state_failed',
      error: error?.name || 'Error'
    }));
  }
}

function getD1Changes(result) {
  const changes = Number(result?.meta?.changes ?? result?.changes ?? 0);
  return Number.isFinite(changes) && changes > 0 ? changes : 0;
}

function parseQueueMessage(body) {
  if (!body || typeof body !== 'object') return null;
  if (body.version !== NOTIFICATION_QUEUE_MESSAGE_VERSION) return null;
  const jobId = String(body.job_id || '').trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(jobId)) {
    return null;
  }
  return { jobId };
}

function getQueueRetryDelaySeconds(attempts) {
  const normalizedAttempts = Math.max(1, Number(attempts) || 1);
  return Math.min(
    NOTIFICATION_QUEUE_RETRY_DELAY_SECONDS * (2 ** (normalizedAttempts - 1)),
    60 * 60
  );
}

function retryQueueMessage(message, attempts = message.attempts) {
  message.retry({ delaySeconds: getQueueRetryDelaySeconds(attempts) });
}

async function claimNotificationJob(db, jobId, now) {
  const result = await db.prepare(`
    UPDATE notification_jobs
    SET status = 'processing',
        attempts = attempts + 1,
        locked_until = ?,
        updated_at = ?
    WHERE id = ?
      AND (
        status IN ('staged', 'queued')
        OR (status = 'processing' AND locked_until <= ?)
      )
  `).bind(now + NOTIFICATION_JOB_LEASE_MS, now, jobId, now).run();
  return getD1Changes(result) > 0;
}

async function markJobDelivered(db, job, result, attempts) {
  const now = Date.now();
  const update = db.prepare(`
    UPDATE notification_jobs
    SET status = 'delivered',
        attempts = ?,
        provider = ?,
        status_code = ?,
        error = NULL,
        locked_until = NULL,
        updated_at = ?,
        completed_at = ?
    WHERE id = ? AND status = 'processing'
  `).bind(
    attempts,
    String(result.provider || 'unknown').slice(0, 32),
    Number.isInteger(result.status_code) ? result.status_code : null,
    now,
    now,
    job.id
  );
  const statements = [
    update,
    createNotificationDeliveryStatement(db, job.source, {
      ...result,
      attempts
    })
  ];
  if (job.source === 'traffic_report') {
    statements.push(db.prepare(`
      UPDATE traffic_report_runs
      SET status = 'delivered',
          error = NULL,
          updated_at = ?,
          completed_at = ?
      WHERE notification_job_id = ? AND status IN ('staged', 'queued')
    `).bind(now, now, job.id));
  }
  await db.batch(statements);
}

function isRetryableDeliveryResult(result) {
  if (!result || result.success) return false;
  if (result.error === 'network_error') return true;
  const statusCode = Number(result.status_code);
  return statusCode === 408
    || statusCode === 425
    || statusCode === 429
    || statusCode >= 500;
}

async function markJobFailed(db, job, result, queueAttempts) {
  const now = Date.now();
  const providerAttempts = Number.isInteger(result?.attempts) && result.attempts > 0
    ? Math.max(result.attempts, queueAttempts)
    : 0;
  const update = db.prepare(`
    UPDATE notification_jobs
    SET status = 'failed',
        attempts = ?,
        provider = ?,
        status_code = ?,
        error = ?,
        locked_until = NULL,
        updated_at = ?,
        completed_at = ?
    WHERE id = ? AND status = 'processing'
  `).bind(
    queueAttempts,
    String(result?.provider || 'unknown').slice(0, 32),
    Number.isInteger(result?.status_code) ? result.status_code : null,
    String(result?.error || 'delivery_failed').slice(0, 100),
    now,
    now,
    job.id
  );
  const statements = [
    update,
    createNotificationDeliveryStatement(db, job.source, {
      ...result,
      attempts: providerAttempts
    })
  ];
  if (job.source === 'traffic_report') {
    statements.push(db.prepare(`
      UPDATE traffic_report_runs
      SET status = 'failed',
          error = ?,
          updated_at = ?,
          completed_at = ?
      WHERE notification_job_id = ? AND status IN ('staged', 'queued')
    `).bind(
      String(result?.error || 'delivery_failed').slice(0, 100),
      now,
      now,
      job.id
    ));
  }
  await db.batch(statements);
}

export async function dispatchNotification(env, settings, message, source, sendNotification) {
  if (typeof sendNotification !== 'function') {
    throw new TypeError('sendNotification adapter is required');
  }

  let stagedJobId = null;
  if (env?.NOTIFICATION_QUEUE && env?.DB) {
    const normalizedMessage = String(message || '');
    const messageBytes = new TextEncoder().encode(normalizedMessage).byteLength;
    if (messageBytes <= NOTIFICATION_JOB_MESSAGE_MAX_BYTES) {
      const jobId = crypto.randomUUID();
      const now = Date.now();

      try {
        await env.DB.prepare(`
          INSERT INTO notification_jobs (
            id,
            source,
            message,
            status,
            attempts,
            available_at,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, 'staged', 0, ?, ?, ?)
        `).bind(
          jobId,
          cleanSource(source),
          normalizedMessage,
          now + NOTIFICATION_JOB_STAGED_RECOVERY_DELAY_MS,
          now,
          now
        ).run();
        stagedJobId = jobId;
      } catch (error) {
        console.warn(JSON.stringify({
          event: 'notification.queue.stage_failed',
          source: cleanSource(source),
          error: error?.name || 'Error'
        }));
      }

      if (stagedJobId) {
        let queueAccepted = false;
        try {
          await env.NOTIFICATION_QUEUE.send({
            version: NOTIFICATION_QUEUE_MESSAGE_VERSION,
            job_id: jobId
          }, {
            contentType: 'json'
          });
          queueAccepted = true;
        } catch (error) {
          console.warn(JSON.stringify({
            event: 'notification.queue.enqueue_failed',
            source: cleanSource(source),
            error: error?.name || 'Error'
          }));
        }

        if (queueAccepted) {
          try {
            await env.DB.prepare(`
              UPDATE notification_jobs
              SET status = 'queued', updated_at = ?
              WHERE id = ? AND status = 'staged'
            `).bind(Date.now(), jobId).run();
          } catch (error) {
            console.error(JSON.stringify({
              event: 'notification.queue.state_update_failed',
              source: cleanSource(source),
              error: error?.name || 'Error'
            }));
          }

          return {
            success: true,
            queued: true,
            job_id: jobId
          };
        }
      }
    } else {
      console.warn(JSON.stringify({
        event: 'notification.queue.message_too_large',
        source: cleanSource(source),
        bytes: messageBytes
      }));
    }
  }

  const result = await sendNotification(settings, message, {
    db: env?.DB,
    source
  });
  await finalizeStagedJobAfterFallback(env?.DB, stagedJobId, result);
  if (stagedJobId && !result?.success && isRetryableDeliveryResult(result)) {
    return {
      ...result,
      pending: true,
      job_id: stagedJobId
    };
  }
  return result;
}

export async function recoverStagedNotificationJobs(env, now = Date.now()) {
  if (!env?.DB || !env?.NOTIFICATION_QUEUE) return 0;

  let jobs;
  try {
    const result = await env.DB.prepare(`
      SELECT id
      FROM notification_jobs
      WHERE status = 'staged' AND available_at <= ?
      ORDER BY created_at ASC
      LIMIT 10
    `).bind(now).all();
    jobs = result.results || [];
  } catch (error) {
    console.error(JSON.stringify({
      event: 'notification.queue.recovery_query_failed',
      error: error?.name || 'Error'
    }));
    return 0;
  }

  let recovered = 0;
  for (const job of jobs) {
    try {
      await env.NOTIFICATION_QUEUE.send({
        version: NOTIFICATION_QUEUE_MESSAGE_VERSION,
        job_id: job.id
      }, {
        contentType: 'json'
      });
      const markQueued = env.DB.prepare(`
        UPDATE notification_jobs
        SET status = 'queued', updated_at = ?
        WHERE id = ? AND status = 'staged'
      `).bind(Date.now(), job.id);
      await env.DB.batch([
        markQueued,
        env.DB.prepare(`
          UPDATE traffic_report_runs
          SET status = 'queued', updated_at = ?
          WHERE notification_job_id = ? AND status = 'staged'
        `).bind(Date.now(), job.id)
      ]);
      recovered += 1;
    } catch (error) {
      console.warn(JSON.stringify({
        event: 'notification.queue.recovery_enqueue_failed',
        error: error?.name || 'Error'
      }));
    }
  }
  return recovered;
}

export async function finalizeExpiredNotificationJobs(env, now = Date.now()) {
  if (!env?.DB || !env?.NOTIFICATION_QUEUE) return 0;

  let jobs;
  try {
    const result = await env.DB.prepare(`
      SELECT id, source, attempts, provider, status_code
      FROM notification_jobs
      WHERE status = 'processing'
        AND attempts >= ?
        AND locked_until <= ?
      ORDER BY locked_until ASC
      LIMIT 10
    `).bind(NOTIFICATION_QUEUE_MAX_ATTEMPTS, now).all();
    jobs = result.results || [];
  } catch (error) {
    console.error(JSON.stringify({
      event: 'notification.queue.finalize_query_failed',
      error: error?.name || 'Error'
    }));
    return 0;
  }

  let finalized = 0;
  for (const job of jobs) {
    try {
      const claimed = await env.DB.prepare(`
        UPDATE notification_jobs
        SET locked_until = ?, updated_at = ?
        WHERE id = ?
          AND status = 'processing'
          AND attempts >= ?
          AND locked_until <= ?
      `).bind(
        now + NOTIFICATION_JOB_LEASE_MS,
        now,
        job.id,
        NOTIFICATION_QUEUE_MAX_ATTEMPTS,
        now
      ).run();
      if (getD1Changes(claimed) === 0) continue;

      await markJobFailed(env.DB, job, {
        success: false,
        provider: job.provider || 'unknown',
        attempts: NOTIFICATION_QUEUE_MAX_ATTEMPTS,
        status_code: Number.isInteger(job.status_code) ? job.status_code : null,
        error: 'attempt_budget_exhausted'
      }, NOTIFICATION_QUEUE_MAX_ATTEMPTS);
      finalized += 1;
    } catch (error) {
      console.error(JSON.stringify({
        event: 'notification.queue.finalize_failed',
        error: error?.name || 'Error'
      }));
    }
  }
  return finalized;
}

export async function cleanupNotificationJobs(db, now = Date.now()) {
  const result = await db.prepare(`
    DELETE FROM notification_jobs
    WHERE created_at < ?
  `).bind(now - NOTIFICATION_JOB_RETENTION_MS).run();
  return getD1Changes(result);
}

export async function processNotificationQueueBatch(batch, env, sendNotification) {
  if (typeof sendNotification !== 'function') {
    throw new TypeError('sendNotification adapter is required');
  }

  for (const message of batch?.messages || []) {
    const parsed = parseQueueMessage(message.body);
    if (!parsed) {
      console.warn(JSON.stringify({ event: 'notification.queue.invalid_message' }));
      message.ack();
      continue;
    }

    let claimedAttempts = null;
    let claimedJob = null;
    let deliveryResult = null;
    try {
      const claimed = await claimNotificationJob(env.DB, parsed.jobId, Date.now());
      if (!claimed) {
        const existing = await env.DB.prepare(`
          SELECT status, attempts, locked_until
          FROM notification_jobs
          WHERE id = ?
        `).bind(parsed.jobId).first();
        if (!existing || existing.status === 'delivered' || existing.status === 'failed') {
          message.ack();
        } else {
          retryQueueMessage(message, existing.attempts);
        }
        continue;
      }

      const job = await env.DB.prepare(`
        SELECT id, source, message, attempts, provider, status_code
        FROM notification_jobs
        WHERE id = ?
      `).bind(parsed.jobId).first();
      if (!job) {
        message.ack();
        continue;
      }

      claimedJob = job;
      claimedAttempts = Math.max(1, Number(job.attempts) || 1);
      if (claimedAttempts > NOTIFICATION_QUEUE_MAX_ATTEMPTS) {
        await markJobFailed(env.DB, job, {
          success: false,
          provider: job.provider || 'unknown',
          attempts: NOTIFICATION_QUEUE_MAX_ATTEMPTS,
          status_code: Number.isInteger(job.status_code) ? job.status_code : null,
          error: 'attempt_budget_exhausted'
        }, NOTIFICATION_QUEUE_MAX_ATTEMPTS);
        message.ack();
        continue;
      }

      const settings = await loadSiteSettings(env.DB, { forceRefresh: true });
      deliveryResult = await sendNotification(settings, job.message, { maxRetries: 1 });
      const result = deliveryResult;
      const attempts = claimedAttempts;

      if (result?.success) {
        await markJobDelivered(env.DB, job, result, attempts);
        message.ack();
      } else if (isRetryableDeliveryResult(result) && attempts < NOTIFICATION_QUEUE_MAX_ATTEMPTS) {
        await env.DB.prepare(`
          UPDATE notification_jobs
          SET status = 'queued',
              attempts = ?,
              provider = ?,
              status_code = ?,
              error = ?,
              locked_until = NULL,
              updated_at = ?
          WHERE id = ? AND status = 'processing'
        `).bind(
          attempts,
          String(result?.provider || 'unknown').slice(0, 32),
          Number.isInteger(result?.status_code) ? result.status_code : null,
          String(result?.error || 'delivery_failed').slice(0, 100),
          Date.now(),
          job.id
        ).run();
        retryQueueMessage(message, attempts);
      } else {
        await markJobFailed(env.DB, job, result, attempts);
        message.ack();
      }
    } catch (error) {
      console.error(JSON.stringify({
        event: 'notification.queue.consume_failed',
        error: error?.name || 'Error'
      }));
      if (claimedJob && claimedAttempts >= NOTIFICATION_QUEUE_MAX_ATTEMPTS) {
        try {
          await markJobFailed(env.DB, claimedJob, {
            success: false,
            provider: deliveryResult?.provider || claimedJob.provider || 'unknown',
            attempts: NOTIFICATION_QUEUE_MAX_ATTEMPTS,
            status_code: Number.isInteger(deliveryResult?.status_code)
              ? deliveryResult.status_code
              : (Number.isInteger(claimedJob.status_code) ? claimedJob.status_code : null),
            error: 'consumer_exception'
          }, NOTIFICATION_QUEUE_MAX_ATTEMPTS);
          message.ack();
          continue;
        } catch (stateError) {
          console.error(JSON.stringify({
            event: 'notification.queue.final_state_failed',
            error: stateError?.name || 'Error'
          }));
        }
      }
      retryQueueMessage(message, claimedAttempts || message.attempts);
    }
  }
}
