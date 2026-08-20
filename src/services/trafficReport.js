import { getLatestMetricsForAllServers } from '../database/schema.js';
import { getAllServers } from '../utils/cache.js';
import { loadSiteSettings, normalizeTrafficReportSchedule } from '../utils/settings.js';
import { getTrafficUsageBytes } from '../utils/traffic.js';
import { dispatchNotification } from './notificationQueue.js';

const TRAFFIC_REPORT_MAX_SERVERS = 50;
const TRAFFIC_REPORT_LOCK_MS = 5 * 60 * 1000;
const TRAFFIC_REPORT_RETENTION_MS = 400 * 24 * 60 * 60 * 1000;
const GIBIBYTE = 1024 ** 3;

function getD1Changes(result) {
  const changes = Number(result?.meta?.changes ?? result?.changes ?? 0);
  return Number.isFinite(changes) && changes > 0 ? changes : 0;
}

function formatUtcDate(date) {
  return date.toISOString().slice(0, 10);
}

function getTrafficReportPeriodKey(schedule, date) {
  if (schedule === 'daily') return `daily:${formatUtcDate(date)}`;
  if (schedule === 'monthly') return `monthly:${date.toISOString().slice(0, 7)}`;

  const monday = new Date(date.getTime());
  const utcDay = monday.getUTCDay() || 7;
  monday.setUTCDate(monday.getUTCDate() - utcDay + 1);
  return `weekly:${formatUtcDate(monday)}`;
}

function getScheduleLabel(schedule) {
  if (schedule === 'weekly') return '每周';
  if (schedule === 'monthly') return '每月';
  return '每日';
}

function formatBytes(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let amount = value;
  let unitIndex = 0;
  while (amount >= 1024 && unitIndex < units.length - 1) {
    amount /= 1024;
    unitIndex += 1;
  }
  return `${amount.toFixed(unitIndex === 0 ? 0 : 2)} ${units[unitIndex]}`;
}

function cleanServerName(value) {
  return String(value || 'Unnamed')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\[\]_*`]/g, '')
    .trim()
    .slice(0, 64) || 'Unnamed';
}

function buildTrafficReportMessage(schedule, servers, metricsMap, date) {
  const rows = servers.map(server => {
    const metrics = metricsMap.get(server.id) || metricsMap.get(String(server.id)) || {};
    const usage = getTrafficUsageBytes({ ...server, ...metrics });
    const limitGb = Number.parseFloat(server.traffic_limit);
    const limitBytes = Number.isFinite(limitGb) && limitGb > 0 ? limitGb * GIBIBYTE : 0;
    return { server, usage, limitBytes };
  }).sort((a, b) => b.usage - a.usage);

  const visibleRows = rows.slice(0, TRAFFIC_REPORT_MAX_SERVERS);
  const lines = visibleRows.map(({ server, usage, limitBytes }) => {
    const limitText = limitBytes > 0 ? formatBytes(limitBytes) : '不限';
    const percentText = limitBytes > 0
      ? ` (${(usage / limitBytes * 100).toFixed(1)}%)`
      : '';
    return `• ${cleanServerName(server.name)} - ${formatBytes(usage)} / ${limitText}${percentText}`;
  });
  if (rows.length > visibleRows.length) {
    lines.push(`• 另有 ${rows.length - visibleRows.length} 台服务器未展开`);
  }

  const totalUsage = rows.reduce((sum, row) => sum + row.usage, 0);
  return `📊 **${getScheduleLabel(schedule)} · 当前账期流量快照**\n\n${lines.join('\n')}\n\n**合计:** ${formatBytes(totalUsage)}\n**统计时点:** ${date.toISOString()}\n**口径:** 各服务器 Agent 当前账期累计值；重置日可不同`;
}

async function claimTrafficReportRun(db, periodKey, schedule, now) {
  const inserted = await db.prepare(`
    INSERT INTO traffic_report_runs (
      period_key, schedule, status, locked_until, created_at, updated_at
    ) VALUES (?, ?, 'processing', ?, ?, ?)
    ON CONFLICT(period_key) DO NOTHING
  `).bind(periodKey, schedule, now + TRAFFIC_REPORT_LOCK_MS, now, now).run();
  if (getD1Changes(inserted) > 0) return true;

  const reclaimed = await db.prepare(`
    UPDATE traffic_report_runs
    SET locked_until = ?, updated_at = ?
    WHERE period_key = ?
      AND status = 'processing'
      AND locked_until <= ?
  `).bind(now + TRAFFIC_REPORT_LOCK_MS, now, periodKey, now).run();
  return getD1Changes(reclaimed) > 0;
}

async function finalizeTrafficReportRun(db, periodKey, delivery) {
  const now = Date.now();
  const status = delivery?.queued
    ? 'queued'
    : (delivery?.pending ? 'staged' : (delivery?.success ? 'delivered' : 'failed'));
  const jobId = delivery?.job_id || null;
  const completedAt = status === 'delivered' || status === 'failed' ? now : null;
  const linkRun = db.prepare(`
    UPDATE traffic_report_runs
    SET status = ?,
        notification_job_id = ?,
        error = ?,
        locked_until = NULL,
        updated_at = ?,
        completed_at = ?
    WHERE period_key = ? AND status = 'processing'
  `).bind(
    status,
    jobId,
    delivery?.error ? String(delivery.error).slice(0, 100) : null,
    now,
    completedAt,
    periodKey
  );
  const reconcileCompletedJob = db.prepare(`
    WITH terminal_job AS (
      SELECT status, error
      FROM notification_jobs
      WHERE id = ? AND status IN ('delivered', 'failed')
    )
    UPDATE traffic_report_runs
    SET status = (SELECT status FROM terminal_job),
        error = CASE
          WHEN (SELECT status FROM terminal_job) = 'delivered' THEN NULL
          ELSE COALESCE((SELECT error FROM terminal_job), error)
        END,
        updated_at = ?,
        completed_at = ?
    WHERE period_key = ?
      AND notification_job_id = ?
      AND status IN ('staged', 'queued')
      AND EXISTS (SELECT 1 FROM terminal_job)
  `).bind(jobId, now, now, periodKey, jobId);

  await db.batch([linkRun, reconcileCompletedJob]);
}

export async function runScheduledTrafficReport(env, nowInput = new Date(), sendNotification) {
  if (typeof sendNotification !== 'function') {
    throw new TypeError('sendNotification adapter is required');
  }
  const settings = await loadSiteSettings(env.DB, { forceRefresh: true });
  const schedule = normalizeTrafficReportSchedule(settings.traffic_report_schedule);
  if (schedule === 'off') return { sent: false, reason: 'disabled' };
  if (!String(settings.tg_bot_token || '').trim()) {
    return { sent: false, reason: 'missing_credential' };
  }

  const date = nowInput instanceof Date ? new Date(nowInput.getTime()) : new Date(nowInput);
  if (Number.isNaN(date.getTime())) throw new TypeError('invalid report time');
  const periodKey = getTrafficReportPeriodKey(schedule, date);
  const servers = await getAllServers(env.DB);
  if (servers.length === 0) {
    return { sent: false, reason: 'no_servers', period_key: periodKey };
  }

  const claimed = await claimTrafficReportRun(env.DB, periodKey, schedule, date.getTime());
  if (!claimed) {
    return { sent: false, reason: 'already_processed', period_key: periodKey };
  }

  const metricsMap = await getLatestMetricsForAllServers(env.DB);
  const message = buildTrafficReportMessage(schedule, servers, metricsMap, date);
  const delivery = await dispatchNotification(
    env,
    settings,
    message,
    'traffic_report',
    sendNotification
  );
  await finalizeTrafficReportRun(env.DB, periodKey, delivery);

  return {
    sent: Boolean(delivery?.success),
    period_key: periodKey,
    delivery
  };
}

export async function cleanupTrafficReportRuns(db, now = Date.now()) {
  const result = await db.prepare(
    'DELETE FROM traffic_report_runs WHERE created_at < ?'
  ).bind(now - TRAFFIC_REPORT_RETENTION_MS).run();
  return getD1Changes(result);
}
