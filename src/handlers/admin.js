import { getAuthContext, simpleAuthResponse, validateCredentials, generateToken } from '../middleware/auth.js';
import { getLatestMetricsForAllServers } from '../database/schema.js';
import { getAllServers, clearServersListCache } from '../utils/cache.js';
import { clearAppearanceSettingsCache, isWssReportEnabled, normalizeBooleanSetting, normalizeDisplayMode, normalizeExpireReminder, normalizeLongHistoryPoints, normalizeResourceAlertRules, normalizeTgNotify, normalizeTrafficReportSchedule, saveSiteOptions, SITE_FIELDS, APPEARANCE_FIELDS } from '../utils/settings.js';
import { mergeMetricsIntoServer } from '../utils/metrics.js';
import { verifyTurnstileToken, hashPassword } from '../utils/common.js';
import { AppError, createSuccessResponse, createBadRequestResponse, createUnauthorizedResponse, createErrorResponse } from '../utils/errors.js';
import { addServerColumns } from '../database/updateDatabase.js';
import { clearResourceAlertState, sendNotification } from '../services/notification.js';
import { listAuditEvents, recordAuditEvent } from '../services/audit.js';
import { listNotificationDeliveries } from '../services/notificationDelivery.js';
import { createAdminSession, createAdminSessionFromOAuthExchange, listAdminSessions, refreshAdminSession, revokeAdminSession, revokeCurrentAdminSession } from '../services/adminSession.js';
import { beginAdminTotpSetup, confirmAdminTotpSetup, disableAdminTotp, isAdminTotpEnabled, isTotpEncryptionAvailable, requiresTotpForSettings, verifyAdminSecondFactor } from '../services/totp.js';
import { createGithubOAuthAuthorization, getGithubOAuthBinding, getGithubOAuthExchangeCode, isGithubOAuthAvailable, reserveGithubOAuthStart, unbindGithubOAuthIdentity } from '../services/githubOAuth.js';
import { createPingTask, defaultPingTaskAssignmentStatement, deletePingTask, listPingTasks, PingTaskError, reorderPingTasks, updatePingTask } from '../services/pingTasks.js';
import { getNextServerHistoryPartitionId, HISTORY_MAX_PARTITION_ID } from '../database/indexOptimization.js';
import { isValidTrafficCorrection, normalizeConnectionMode, validateAgentConfigInput, validatePingNode, validateNetworkInterfaces } from '../utils/agentConfig.js';
import { scheduleAgentConfigChanged, scheduleAgentReportModeChanged } from '../utils/agentConfigNotify.js';
import { detectBillingCycle, detectCurrencySymbol, normalizeBillingCycle, normalizeCurrency, normalizePrice, renewExpireDateIfNeeded } from '../utils/serverBilling.js';
import { createLogicalBackup, isR2BackupAvailable, LogicalBackupError, storeLogicalBackupInR2 } from '../services/logicalBackup.js';

const PING_NODE_FIELDS = ['custom_ct', 'custom_cu', 'custom_cm', 'custom_bd'];
const THEME_PREVIEW_AUTH_COOKIE = 'cfsm_theme_preview_auth';
const THEME_PREVIEW_AUTH_TTL = 600;
const DURABLE_OBJECTS_WEBSOCKET_MESSAGE_BILLING_RATIO = 20;
const LOGIN_FAILURE_DEDUPE_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_FAILURE_AUDIT_WRITE_LIMIT = 20;
const GITHUB_OAUTH_FAILURE_DEDUPE_WINDOW_MS = 5 * 60 * 1000;
const GITHUB_OAUTH_FAILURE_AUDIT_WRITE_LIMIT = 20;
const GITHUB_OAUTH_AUDIT_REASONS = new Set([
  'already_bound',
  'exchange_invalid',
  'exchange_replayed',
  'identity_mismatch',
  'invalid_second_factor',
  'not_bound',
  'second_factor_rate_limited',
  'start_failed',
  'start_rate_limited',
  'unavailable'
]);
const GITHUB_OAUTH_AUDIT_METHODS = new Set(['bind', 'exchange', 'session', 'start', 'totp', 'recovery', 'unbind']);
const GITHUB_OAUTH_START_ERROR_CODES = new Set([
  'github_oauth_unavailable',
  'invalid_oauth_return_url'
]);

function createSecondFactorResponse(code, status = 401) {
  return new Response(JSON.stringify({
    error: code,
    code
  }), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

function createSecondFactorRateLimitResponse(retryAfter = 300) {
  return new Response(JSON.stringify({
    error: 'second_factor_rate_limited',
    code: 'second_factor_rate_limited'
  }), {
    status: 429,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Retry-After': String(retryAfter)
    }
  });
}

function createGithubOAuthErrorResponse(code, status = 400, headers = {}) {
  return new Response(JSON.stringify({ error: code, code }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...headers
    }
  });
}

function createPingTaskErrorResponse(error) {
  const status = error instanceof PingTaskError ? error.status : 500;
  const message = error instanceof PingTaskError ? error.message : 'pingTaskOperationFailed';
  return new Response(JSON.stringify({ error: message, code: status }), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

function getGithubOAuthStartErrorCode(error) {
  const code = String(error?.message || '');
  return GITHUB_OAUTH_START_ERROR_CODES.has(code)
    ? code
    : 'github_oauth_start_failed';
}

async function tryRecordAuditEvent(db, event) {
  try {
    await recordAuditEvent(db, event);
    return true;
  } catch (error) {
    console.error(JSON.stringify({
      event: 'audit.persist_failed',
      event_type: String(event?.eventType || 'unknown').slice(0, 100),
      error: error?.name || 'Error'
    }));
    return false;
  }
}

function getLoginFailureDedupeKey(request, occurredAt = Date.now()) {
  const ipAddress = request.headers.get('CF-Connecting-IP') || null;
  return ipAddress
    ? `auth.login.failure:${ipAddress}:${Math.floor(occurredAt / LOGIN_FAILURE_DEDUPE_WINDOW_MS)}`
    : null;
}

function getLoginSecondFactorRateLimitScope(request) {
  return `login:${request.headers.get('CF-Connecting-IP') || 'unknown'}`;
}

function getAuthenticatedSecondFactorRateLimitScope(env, sys) {
  return `admin:${sys?.username || env.API_USER_NAME || 'admin'}`;
}

function normalizeGithubOAuthAuditReason(reason) {
  return GITHUB_OAUTH_AUDIT_REASONS.has(reason) ? reason : 'start_failed';
}

function normalizeGithubOAuthAuditMethod(method) {
  return GITHUB_OAUTH_AUDIT_METHODS.has(method) ? method : null;
}

function getGithubOAuthFailureDedupeKey(request, eventType, reason, occurredAt = Date.now()) {
  const ipAddress = request.headers.get('CF-Connecting-IP') || 'unknown';
  return `${eventType}:${reason}:${ipAddress}:${Math.floor(occurredAt / GITHUB_OAUTH_FAILURE_DEDUPE_WINDOW_MS)}`;
}

async function recordGithubOAuthFailureAudit(db, request, reason, method = null) {
  const occurredAt = Date.now();
  const normalizedReason = normalizeGithubOAuthAuditReason(reason);
  const normalizedMethod = normalizeGithubOAuthAuditMethod(method);
  await tryRecordAuditEvent(db, {
    eventType: 'auth.oauth.github.failure',
    outcome: 'failure',
    actor: 'anonymous',
    targetType: 'admin_session',
    targetId: 'github',
    ipAddress: request.headers.get('CF-Connecting-IP'),
    userAgent: request.headers.get('User-Agent'),
    detail: {
      provider: 'github',
      reason: normalizedReason,
      ...(normalizedMethod ? { method: normalizedMethod } : {})
    },
    dedupeKey: getGithubOAuthFailureDedupeKey(
      request,
      'auth.oauth.github.failure',
      normalizedReason,
      occurredAt
    ),
    maxCount: GITHUB_OAUTH_FAILURE_AUDIT_WRITE_LIMIT,
    occurredAt
  });
}

async function recordGithubOAuthAdminAudit(db, request, eventType, outcome, detail = {}) {
  const occurredAt = Date.now();
  const normalizedReason = outcome === 'failure'
    ? normalizeGithubOAuthAuditReason(detail.reason)
    : null;
  const normalizedMethod = normalizeGithubOAuthAuditMethod(detail.method);
  await tryRecordAuditEvent(db, {
    eventType,
    outcome,
    actor: 'admin',
    targetType: 'admin_oauth_identity',
    targetId: 'github',
    ipAddress: request.headers.get('CF-Connecting-IP'),
    userAgent: request.headers.get('User-Agent'),
    detail: {
      provider: 'github',
      ...(normalizedReason ? { reason: normalizedReason } : {}),
      ...(normalizedMethod ? { method: normalizedMethod } : {})
    },
    dedupeKey: normalizedReason
      ? getGithubOAuthFailureDedupeKey(request, eventType, normalizedReason, occurredAt)
      : null,
    maxCount: normalizedReason ? GITHUB_OAUTH_FAILURE_AUDIT_WRITE_LIMIT : undefined,
    occurredAt
  });
}

async function recordLoginAuditEvent(db, request, eventType, outcome, detail) {
  const occurredAt = Date.now();
  const ipAddress = request.headers.get('CF-Connecting-IP') || null;
  const dedupeKey = eventType === 'auth.login.failure'
    ? getLoginFailureDedupeKey(request, occurredAt)
    : null;

  await tryRecordAuditEvent(db, {
    eventType,
    outcome,
    actor: outcome === 'success' ? 'admin' : 'anonymous',
    targetType: 'admin_session',
    ipAddress,
    userAgent: request.headers.get('User-Agent'),
    detail,
    dedupeKey,
    maxCount: eventType === 'auth.login.failure' ? LOGIN_FAILURE_AUDIT_WRITE_LIMIT : undefined,
    occurredAt
  });
}

async function recordAdminAuditEvent(db, request, event) {
  await tryRecordAuditEvent(db, {
    eventType: event.eventType,
    outcome: event.outcome || 'success',
    actor: 'admin',
    targetType: event.targetType,
    targetId: event.targetId,
    ipAddress: request.headers.get('CF-Connecting-IP'),
    userAgent: request.headers.get('User-Agent'),
    detail: event.detail || {},
    occurredAt: Date.now()
  });
}

function toUsageNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function isDurableObjectsHibernationInvocationType(value) {
  const type = String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (!type) return false;
  return type.includes('hibernation') || (type.includes('websocket') && type.includes('message'));
}

function normalizeBooleanFlag(value) {
  return value === true || value === 1 || value === '1' || value === 'true' ? '1' : '0';
}

function normalizeServerRegion(value) {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 16);
}

function normalizeServerBillingData(data = {}) {
  const billingCycle = normalizeBillingCycle(data.billing_cycle || detectBillingCycle(data.price));
  const autoRenewal = normalizeBooleanFlag(data.auto_renewal);

  return {
    price: normalizePrice(data.price),
    billing_cycle: billingCycle,
    auto_renewal: autoRenewal,
    currency: normalizeCurrency(data.currency || detectCurrencySymbol(data.price) || '¥'),
    expire_date: renewExpireDateIfNeeded(
      data.expire_date || '',
      billingCycle,
      autoRenewal
    ).expire_date
  };
}

function isValidUUID(id) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

function isValidName(name) {
  return name && typeof name === 'string' && name.trim().length > 0 && name.length <= 100;
}

function isMissingColumnError(error) {
  const message = error?.message || String(error);
  return /no such column|has no column/i.test(message);
}

async function handleServerMutationError(db, error, fallbackMessage) {
  if (isMissingColumnError(error)) {
    console.warn('检测到数据库字段缺失，尝试添加缺失字段...');
    await addServerColumns(db);
    return createBadRequestResponse('dbColumnsAdded');
  }

  const errMsg = error?.message || String(error);
  return createBadRequestResponse(errMsg || fallbackMessage);
}

function sanitizeCspDomains(input) {
  if (!input || typeof input !== 'string') return '';
  return input
    .split(',')
    .map(s => s.trim())
    .map(normalizeCspOrigin)
    .filter(Boolean)
    .filter((domain, index, arr) => arr.indexOf(domain) === index)
    .join(',');
}

function normalizeCspOrigin(value) {
  const raw = String(value || '').trim();
  if (!raw || /[\s;"']/.test(raw)) return '';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return '';
    if (url.username || url.password || url.search || url.hash) return '';
    if (url.pathname && url.pathname !== '/') return '';
    return url.origin;
  } catch (_) {
    return '';
  }
}

function normalizePingNodeFields(source, fields = PING_NODE_FIELDS) {
  const values = {};
  for (const field of fields) {
    if (source?.[field] === undefined) continue;
    const result = validatePingNode(source?.[field]);
    if (!result.valid) {
      return { valid: false, field };
    }
    values[field] = result.value;
  }
  return { valid: true, values };
}

function normalizeNetworkInterfaceField(value) {
  const result = validateNetworkInterfaces(value);
  if (!result.valid) {
    return { valid: false, value: '' };
  }
  return { valid: true, value: result.value };
}

function hasAppearanceInput(settings) {
  if (settings.appearance_options !== undefined) return true;
  return APPEARANCE_FIELDS
    .filter(field => field !== 'theme_options')
    .some(field => settings[field] !== undefined);
}

function extractBearerToken(request) {
  const authHeader = request.headers.get('Authorization') || '';
  const parts = authHeader.trim().split(/\s+/);
  return parts[0] === 'Bearer' && parts[1] ? parts[1] : '';
}

function buildThemePreviewUrl(request, themeUrl) {
  const previewUrl = new URL('/', request.url);
  previewUrl.searchParams.set('theme_url', themeUrl);
  return previewUrl.toString();
}

function buildThemePreviewAuthCookie(request, token) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${THEME_PREVIEW_AUTH_COOKIE}=${encodeURIComponent(token)}; Max-Age=${THEME_PREVIEW_AUTH_TTL}; Path=/; HttpOnly; SameSite=Lax${secure}`;
}

function buildClearThemePreviewAuthCookie(request) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${THEME_PREVIEW_AUTH_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax${secure}`;
}

function normalizeThemeUrl(value) {
  if (value === undefined) return undefined;
  const raw = String(value || '').trim();
  if (!raw) return '';

  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return null;
    if (url.hostname !== 'github.com') return null;
    if (url.username || url.password || url.search || url.hash) return null;

    const parts = url.pathname.split('/').filter(Boolean);
    const ref = parts[3];
    if (
      parts.length < 4 ||
      parts[2] !== 'tree' ||
      !/^[A-Za-z0-9._-]+$/.test(parts[0]) ||
      !/^[A-Za-z0-9._-]+$/.test(parts[1]) ||
      !/^[A-Za-z0-9._-]+$/.test(ref) ||
      parts.some(part => part === '.' || part === '..' || /[%\\]/.test(part))
    ) {
      return null;
    }

    return `https://github.com/${parts.join('/')}`;
  } catch (_) {
    return null;
  }
}

function getThemeRawIndexUrl(themeUrl) {
  const normalized = normalizeThemeUrl(themeUrl);
  if (!normalized) return '';

  const url = new URL(normalized);
  const parts = url.pathname.split('/').filter(Boolean);
  const owner = parts[0];
  const repo = parts[1];
  const ref = parts[3];
  const themePath = [owner, repo, ref, ...parts.slice(4)]
    .map(part => encodeURIComponent(part))
    .join('/');
  return `https://raw.githubusercontent.com/${themePath}/index.html`;
}

async function validateThemeUrlAvailable(themeUrl) {
  if (!themeUrl) return true;

  const rawIndexUrl = getThemeRawIndexUrl(themeUrl);
  if (!rawIndexUrl) return false;

  try {
    const res = await fetch(rawIndexUrl, {
      method: 'GET',
      headers: { 'User-Agent': 'CFSM-Theme-Validate' }
    });
    return res.ok;
  } catch (_) {
    return false;
  }
}

async function deleteServer(db, id) {
  try {
    const stmt1 = db.prepare(`PRAGMA foreign_key_list(metrics_history)`);
    const result1 = await stmt1.all();
    if (result1.results.length > 0) {
      await db.prepare('DELETE FROM metrics_history WHERE server_id = ?').bind(id).run();
    }

    const stmt2 = db.prepare(`PRAGMA foreign_key_list(metrics_history_old)`);
    const result2 = await stmt2.all();
    if (result2.results.length > 0) {
      await db.prepare('DELETE FROM metrics_history_old WHERE server_id = ?').bind(id).run();
    }

    await db.prepare('DELETE FROM servers WHERE id = ?').bind(id).run();
  } catch (err) {
    throw err;
  }
}

function getUtcTodayRange() {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const end = new Date(start.getTime() + 86400000 - 1);
  return {
    date: start.toISOString().slice(0, 10),
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
    startTime: start.toISOString(),
    endTime: end.toISOString()
  };
}

function getUtcYesterdayRange() {
  const now = new Date();
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = new Date(todayStart.getTime() - 86400000);
  const end = new Date(todayStart.getTime() - 1);
  return {
    date: start.toISOString().slice(0, 10),
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
    startTime: start.toISOString(),
    endTime: end.toISOString()
  };
}

async function cloudflareGraphql(query, variables, token) {
  const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query, variables })
  });
  const data = await response.json();
  if (!response.ok || data.errors) {
    const message = data.errors && data.errors.length > 0 ? data.errors.map(e => e.message).join('; ') : 'Cloudflare GraphQL request failed';
    throw new Error(message);
  }
  return data.data;
}

function estimateDurableObjectsWebSocketBillableRequests(messages) {
  const count = toUsageNumber(messages);
  if (count <= 0) return 0;
  return Math.ceil(count / DURABLE_OBJECTS_WEBSOCKET_MESSAGE_BILLING_RATIO);
}

export function estimateDurableObjectsBillableRequests(breakdown = {}) {
  if (breakdown === null || typeof breakdown !== 'object') {
    return estimateDurableObjectsWebSocketBillableRequests(breakdown);
  }

  const httpRequests = toUsageNumber(breakdown.httpRequests);
  const hibernationWakeups = toUsageNumber(breakdown.hibernationWakeups);
  const inboundWebSocketMessages = toUsageNumber(breakdown.inboundWebSocketMessages);

  return Math.ceil(httpRequests) +
    Math.ceil(hibernationWakeups) +
    estimateDurableObjectsWebSocketBillableRequests(inboundWebSocketMessages);
}

export function summarizeDurableObjectsUsage(invocationGroups = [], periodicGroups = []) {
  const summary = {
    httpRequests: 0,
    hibernationWakeups: 0,
    inboundWebSocketMessages: 0,
    outboundWebSocketMessages: 0,
    rawRequests: 0,
    billableRequests: 0
  };

  for (const group of invocationGroups || []) {
    const requests = toUsageNumber(group?.sum?.requests);
    summary.rawRequests += requests;
    if (isDurableObjectsHibernationInvocationType(group?.dimensions?.type)) {
      summary.hibernationWakeups += requests;
    } else {
      summary.httpRequests += requests;
    }
  }

  for (const group of periodicGroups || []) {
    summary.inboundWebSocketMessages += toUsageNumber(group?.sum?.inboundWebsocketMsgCount);
    summary.outboundWebSocketMessages += toUsageNumber(group?.sum?.outboundWebsocketMsgCount);
  }

  summary.billableRequests = estimateDurableObjectsBillableRequests(summary);
  return summary;
}

async function fetchCloudflareUsage(token, accountId, range) {
  const query = `query CloudflareUsage($accountTag: string!, $start: Date, $end: Date, $startTime: Time!, $endTime: Time!) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        d1AnalyticsAdaptiveGroups(
          limit: 10000
          filter: { date_geq: $start, date_leq: $end }
        ) {
          sum { rowsRead rowsWritten }
          dimensions { databaseId }
        }
        workersInvocationsAdaptive(
          limit: 10000
          filter: { datetime_geq: $startTime, datetime_leq: $endTime }
        ) {
          sum { requests }
        }
        durableObjectsInvocationsAdaptiveGroups(
          limit: 10000
          filter: { date_geq: $start, date_leq: $end }
        ) {
          sum { requests }
          dimensions { type }
        }
        durableObjectsPeriodicGroups(
          limit: 10000
          filter: { date_geq: $start, date_leq: $end }
        ) {
          sum { duration inboundWebsocketMsgCount outboundWebsocketMsgCount }
        }
      }
    }
  }`;
  const data = await cloudflareGraphql(query, {
    accountTag: accountId,
    start: range.start,
    end: range.end,
    startTime: range.startTime,
    endTime: range.endTime
  }, token);
  const account = data.viewer?.accounts?.[0] || {};
  const groups = account.d1AnalyticsAdaptiveGroups || [];
  const usage = groups.reduce((total, group) => {
    total.rowsRead += Number(group.sum?.rowsRead || 0);
    total.rowsWritten += Number(group.sum?.rowsWritten || 0);
    return total;
  }, { rowsRead: 0, rowsWritten: 0 });
  const workersRequests = (account.workersInvocationsAdaptive || []).reduce((total, group) => {
    return total + Number(group.sum?.requests || 0);
  }, 0);
  const durableObjectsUsage = summarizeDurableObjectsUsage(
    account.durableObjectsInvocationsAdaptiveGroups || [],
    account.durableObjectsPeriodicGroups || []
  );
  const durableObjectsDuration = (account.durableObjectsPeriodicGroups || []).reduce((total, group) => {
    return total + Number(group.sum?.duration || 0);
  }, 0);
  return {
    rowsRead: usage.rowsRead,
    rowsWritten: usage.rowsWritten,
    workersRequests,
    durableObjectsRequests: durableObjectsUsage.billableRequests,
    durableObjectsHttpRequests: durableObjectsUsage.httpRequests,
    durableObjectsHibernationWakeups: durableObjectsUsage.hibernationWakeups,
    durableObjectsInboundWebSocketMessages: durableObjectsUsage.inboundWebSocketMessages,
    durableObjectsOutboundWebSocketMessages: durableObjectsUsage.outboundWebSocketMessages,
    durableObjectsRawRequests: durableObjectsUsage.rawRequests,
    durableObjectsRequestsEstimated: true,
    durableObjectsRequestBillingRatio: DURABLE_OBJECTS_WEBSOCKET_MESSAGE_BILLING_RATIO,
    durableObjectsDuration,
    databaseCount: groups.length
  };
}

async function getD1DailyUsage(token, accountId) {
  if (!token) throw new Error('cloudflareTokenRequired');
  if (!accountId) throw new Error('cloudflareAccountIdRequired');

  const todayRange = getUtcTodayRange();
  const yesterdayRange = getUtcYesterdayRange();

  const [todayUsage, yesterdayUsage] = await Promise.all([
    fetchCloudflareUsage(token, accountId, todayRange),
    fetchCloudflareUsage(token, accountId, yesterdayRange)
  ]);

  const yesterday = {
    rowsRead: yesterdayUsage.rowsRead,
    rowsWritten: yesterdayUsage.rowsWritten,
    workersRequests: yesterdayUsage.workersRequests,
    durableObjectsRequests: yesterdayUsage.durableObjectsRequests,
    durableObjectsHttpRequests: yesterdayUsage.durableObjectsHttpRequests,
    durableObjectsHibernationWakeups: yesterdayUsage.durableObjectsHibernationWakeups,
    durableObjectsInboundWebSocketMessages: yesterdayUsage.durableObjectsInboundWebSocketMessages,
    durableObjectsOutboundWebSocketMessages: yesterdayUsage.durableObjectsOutboundWebSocketMessages,
    durableObjectsRawRequests: yesterdayUsage.durableObjectsRawRequests,
    durableObjectsRequestsEstimated: yesterdayUsage.durableObjectsRequestsEstimated,
    durableObjectsRequestBillingRatio: yesterdayUsage.durableObjectsRequestBillingRatio,
    durableObjectsDuration: yesterdayUsage.durableObjectsDuration
  };

  return {
    today: {
      rowsRead: todayUsage.rowsRead,
      rowsWritten: todayUsage.rowsWritten,
      workersRequests: todayUsage.workersRequests,
      durableObjectsRequests: todayUsage.durableObjectsRequests,
      durableObjectsHttpRequests: todayUsage.durableObjectsHttpRequests,
      durableObjectsHibernationWakeups: todayUsage.durableObjectsHibernationWakeups,
      durableObjectsInboundWebSocketMessages: todayUsage.durableObjectsInboundWebSocketMessages,
      durableObjectsOutboundWebSocketMessages: todayUsage.durableObjectsOutboundWebSocketMessages,
      durableObjectsRawRequests: todayUsage.durableObjectsRawRequests,
      durableObjectsRequestsEstimated: todayUsage.durableObjectsRequestsEstimated,
      durableObjectsRequestBillingRatio: todayUsage.durableObjectsRequestBillingRatio,
      durableObjectsDuration: todayUsage.durableObjectsDuration
    },
    yesterday
  };
}

export async function handleAdminAPI(request, env, sys, loadFullSettings = null, ctx = null) {
  try {
    const data = await request.json();

    if (data.action === 'github_oauth_start') {
      if (!isGithubOAuthAvailable(env)) {
        await recordGithubOAuthFailureAudit(env.DB, request, 'unavailable', 'start');
        return createGithubOAuthErrorResponse('github_oauth_unavailable');
      }
      try {
        const reservation = await reserveGithubOAuthStart(env.DB, request);
        if (!reservation.allowed) {
          await recordGithubOAuthFailureAudit(env.DB, request, 'start_rate_limited', 'start');
          return createGithubOAuthErrorResponse(
            'github_oauth_start_rate_limited',
            429,
            { 'Retry-After': String(reservation.retryAfter) }
          );
        }
        const authorization = await createGithubOAuthAuthorization(
          env.DB,
          env,
          request,
          { returnUrl: data.return_url }
        );
        return createSuccessResponse({
          success: true,
          authorize_url: authorization.authorizeUrl
        }, { 'Cache-Control': 'no-store' });
      } catch (error) {
        await recordGithubOAuthFailureAudit(env.DB, request, 'start_failed', 'start');
        return createGithubOAuthErrorResponse(getGithubOAuthStartErrorCode(error));
      }
    }

    if (data.action === 'github_oauth_exchange') {
      const exchange = await getGithubOAuthExchangeCode(env.DB, data.oauth_code);
      if (!exchange) {
        await recordGithubOAuthFailureAudit(env.DB, request, 'exchange_invalid', 'exchange');
        return createGithubOAuthErrorResponse('github_oauth_exchange_invalid');
      }
      const binding = await getGithubOAuthBinding(env.DB);
      if (!binding || String(binding.provider_user_id) !== String(exchange.provider_user_id)) {
        await recordGithubOAuthFailureAudit(env.DB, request, 'identity_mismatch', 'exchange');
        return createGithubOAuthErrorResponse('github_oauth_exchange_invalid');
      }

      const hasSecondFactorInput = !!String(data.totp_code || data.recovery_code || '').trim();
      const secondFactor = await verifyAdminSecondFactor(env.DB, env.TOTP_ENCRYPTION_KEY, {
        totpCode: data.totp_code,
        recoveryCode: data.recovery_code,
        rateLimitScope: getLoginSecondFactorRateLimitScope(request)
      });
      if (secondFactor.rateLimited) {
        await recordGithubOAuthFailureAudit(
          env.DB,
          request,
          'second_factor_rate_limited',
          'exchange'
        );
        return createSecondFactorRateLimitResponse(secondFactor.retryAfter);
      }
      if (secondFactor.required && !secondFactor.valid) {
        if (hasSecondFactorInput) {
          await recordGithubOAuthFailureAudit(
            env.DB,
            request,
            'invalid_second_factor',
            'exchange'
          );
        }
        return createSecondFactorResponse(
          hasSecondFactorInput ? 'invalid_second_factor' : 'totp_required'
        );
      }

      const authMethod = secondFactor.method === 'recovery'
        ? 'github_oauth_recovery'
        : secondFactor.method === 'totp'
          ? 'github_oauth_totp'
          : 'github_oauth';
      const session = await createAdminSessionFromOAuthExchange(
        env.DB,
        request,
        authMethod,
        exchange
      );
      if (!session) {
        await recordGithubOAuthFailureAudit(env.DB, request, 'exchange_replayed', 'exchange');
        return createGithubOAuthErrorResponse('github_oauth_exchange_invalid');
      }
      const token = await generateToken(env, sys, {
        sessionId: session.id,
        issuedAt: session.created_at,
        expiresAt: session.expires_at
      });
      await recordLoginAuditEvent(
        env.DB,
        request,
        'auth.login.success',
        'success',
        { method: authMethod }
      );
      return createSuccessResponse({
        success: true,
        token,
        message: 'loginSuccessful'
      }, { 'Cache-Control': 'no-store' });
    }

    if (data.action === 'login') {
      const { username, password } = data;
      
      if (!username || !password) {
        return createBadRequestResponse('missingCredentials');
      }

      const turnstileEnabled = sys && (sys.turnstile_enabled === 'true' || sys.turnstile_enabled === true);
      const turnstileLoginEnabled = sys && (sys.turnstile_login_enabled === 'true' || sys.turnstile_login_enabled === true);
      const turnstileSecretKey = sys && sys.turnstile_secret_key || '';
      
      if (turnstileEnabled || turnstileLoginEnabled) {
        const turnstileToken = request.headers.get('X-Turnstile-Token');
        const isTurnstileVerified = await verifyTurnstileToken(turnstileToken, turnstileSecretKey);
        
        if (!isTurnstileVerified) {
          return createErrorResponse(new AppError('verificationFailed', 403));
        }
      }

      const authHeader = 'Basic ' + btoa(username + ':' + password);
      const mockRequest = {
        headers: {
          get: (key) => key === 'Authorization' ? authHeader : null
        }
      };

      const credentialResult = await validateCredentials(mockRequest, env, sys);
      
      if (!credentialResult.valid) {
        await recordLoginAuditEvent(
          env.DB,
          request,
          'auth.login.failure',
          'failure',
          { reason: 'invalid_credentials' }
        );
        return createUnauthorizedResponse('invalidCredentials');
      }

      if (credentialResult.needsPasswordUpgrade) {
        try {
          const upgradedPasswordHash = await hashPassword(password);
          await saveSiteOptions(env.DB, { password: upgradedPasswordHash });
          if (sys) {
            sys.password = upgradedPasswordHash;
          }
        } catch (e) {
          console.error('Password hash upgrade failed:', e);
        }
      }

      let secondFactor;
      const hasSecondFactorInput = !!String(data.totp_code || data.recovery_code || '').trim();
      try {
        secondFactor = await verifyAdminSecondFactor(env.DB, env.TOTP_ENCRYPTION_KEY, {
          totpCode: data.totp_code,
          recoveryCode: data.recovery_code,
          rateLimitScope: getLoginSecondFactorRateLimitScope(request)
        });
      } catch (error) {
        return createErrorResponse(error);
      }

      if (secondFactor.rateLimited) {
        return createSecondFactorRateLimitResponse(secondFactor.retryAfter);
      }

      if (secondFactor.required && !secondFactor.valid) {
        if (hasSecondFactorInput) {
          await recordLoginAuditEvent(
            env.DB,
            request,
            'auth.login.failure',
            'failure',
            { reason: 'invalid_second_factor' }
          );
        }
        return createSecondFactorResponse(hasSecondFactorInput ? 'invalid_second_factor' : 'totp_required');
      }

      try {
        const authMethod = secondFactor.method === 'recovery'
          ? 'password_recovery'
          : secondFactor.method === 'totp'
            ? 'password_totp'
            : 'password';
        const session = await createAdminSession(env.DB, request, authMethod);
        const token = await generateToken(env, sys, {
          sessionId: session.id,
          issuedAt: session.created_at,
          expiresAt: session.expires_at
        });
        await recordLoginAuditEvent(
          env.DB,
          request,
          'auth.login.success',
          'success',
          { method: authMethod }
        );
        return createSuccessResponse({
          success: true,
          token: token,
          message: 'loginSuccessful'
        }, { 'Cache-Control': 'no-store' });
      } catch (e) {
        return createErrorResponse(e);
      }
    }

    if (data.action === 'clear_theme_preview_auth') {
      return createSuccessResponse({
        success: true
      }, {
        'Set-Cookie': buildClearThemePreviewAuthCookie(request)
      });
    }

    const authContext = await getAuthContext(request, env, sys, ctx);
    if (!authContext) {
      return simpleAuthResponse();
    }

    if (data.action === 'logical_backup_status') {
      return createSuccessResponse({
        success: true,
        r2_available: isR2BackupAvailable(env),
        scope: 'configuration-only',
        restore_supported: false
      }, { 'Cache-Control': 'no-store' });
    }
    else if (data.action === 'logical_backup_export') {
      try {
        const artifact = await createLogicalBackup(env.DB);
        await recordAdminAuditEvent(env.DB, request, {
          eventType: 'admin.backup.export',
          targetType: 'logical_backup',
          detail: {
            size_bytes: artifact.sizeBytes,
            checksum_sha256: artifact.checksum,
            record_counts: artifact.backup.manifest.record_counts
          }
        });
        return createSuccessResponse({
          success: true,
          backup: artifact.backup,
          size_bytes: artifact.sizeBytes,
          checksum_sha256: artifact.checksum
        }, {
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff'
        });
      } catch (error) {
        const code = error instanceof LogicalBackupError
          ? error.code
          : 'logicalBackupExportFailed';
        await recordAdminAuditEvent(env.DB, request, {
          eventType: 'admin.backup.export',
          outcome: 'failure',
          targetType: 'logical_backup',
          detail: { reason: code }
        });
        return createBadRequestResponse(code);
      }
    }
    else if (data.action === 'logical_backup_r2_create') {
      if (!isR2BackupAvailable(env)) {
        await recordAdminAuditEvent(env.DB, request, {
          eventType: 'admin.backup.r2_create',
          outcome: 'failure',
          targetType: 'logical_backup',
          detail: { reason: 'logicalBackupR2Unavailable' }
        });
        return createBadRequestResponse('logicalBackupR2Unavailable');
      }

      try {
        const artifact = await createLogicalBackup(env.DB);
        const stored = await storeLogicalBackupInR2(env.BACKUP_BUCKET, artifact);
        await recordAdminAuditEvent(env.DB, request, {
          eventType: 'admin.backup.r2_create',
          targetType: 'r2_object',
          targetId: stored.key,
          detail: {
            size_bytes: stored.size,
            checksum_sha256: stored.checksum_sha256,
            record_counts: artifact.backup.manifest.record_counts
          }
        });
        return createSuccessResponse({
          success: true,
          object: stored
        }, { 'Cache-Control': 'no-store' });
      } catch (error) {
        const code = error instanceof LogicalBackupError
          ? error.code
          : 'logicalBackupR2Failed';
        await recordAdminAuditEvent(env.DB, request, {
          eventType: 'admin.backup.r2_create',
          outcome: 'failure',
          targetType: 'logical_backup',
          detail: { reason: code }
        });
        return createBadRequestResponse(code);
      }
    }
    else if (data.action === 'ping_task_list') {
      try {
        return createSuccessResponse({ success: true, tasks: await listPingTasks(env.DB) });
      } catch (error) {
        return createPingTaskErrorResponse(error);
      }
    }
    else if (data.action === 'ping_task_create') {
      try {
        const result = await createPingTask(env.DB, data);
        for (const serverId of result.affected_server_ids) {
          scheduleAgentConfigChanged(env, ctx, serverId);
        }
        await recordAdminAuditEvent(env.DB, request, {
          eventType: 'admin.ping_task.create',
          targetType: 'ping_task',
          targetId: result.task.id,
          detail: { type: result.task.type, server_count: result.task.server_ids.length }
        });
        return createSuccessResponse({ success: true, task: result.task });
      } catch (error) {
        return createPingTaskErrorResponse(error);
      }
    }
    else if (data.action === 'ping_task_update') {
      try {
        const result = await updatePingTask(env.DB, data);
        for (const serverId of result.affected_server_ids) {
          scheduleAgentConfigChanged(env, ctx, serverId);
        }
        await recordAdminAuditEvent(env.DB, request, {
          eventType: 'admin.ping_task.update',
          targetType: 'ping_task',
          targetId: result.task.id,
          detail: { type: result.task.type, server_count: result.task.server_ids.length }
        });
        return createSuccessResponse({ success: true, task: result.task });
      } catch (error) {
        return createPingTaskErrorResponse(error);
      }
    }
    else if (data.action === 'ping_task_delete') {
      try {
        const result = await deletePingTask(env.DB, data.id);
        for (const serverId of result.affected_server_ids) {
          scheduleAgentConfigChanged(env, ctx, serverId);
        }
        await recordAdminAuditEvent(env.DB, request, {
          eventType: 'admin.ping_task.delete',
          targetType: 'ping_task',
          targetId: result.id,
          detail: { server_count: result.affected_server_ids.length }
        });
        return createSuccessResponse({ success: true });
      } catch (error) {
        return createPingTaskErrorResponse(error);
      }
    }
    else if (data.action === 'ping_task_reorder') {
      try {
        const tasks = await reorderPingTasks(env.DB, data.ids);
        await recordAdminAuditEvent(env.DB, request, {
          eventType: 'admin.ping_task.reorder',
          targetType: 'ping_task_collection',
          detail: { count: tasks.length }
        });
        return createSuccessResponse({ success: true, tasks });
      } catch (error) {
        return createPingTaskErrorResponse(error);
      }
    }
    else if (data.action === 'session_list') {
      const sessions = await listAdminSessions(env.DB, authContext.sessionId);
      return createSuccessResponse({
        success: true,
        sessions
      });
    }
    else if (data.action === 'github_oauth_bind_start') {
      if (!isGithubOAuthAvailable(env)) {
        await recordGithubOAuthAdminAudit(
          env.DB,
          request,
          'admin.oauth.github.bind',
          'failure',
          { reason: 'unavailable', method: 'bind' }
        );
        return createGithubOAuthErrorResponse('github_oauth_unavailable');
      }
      const hasSecondFactorInput = !!String(data.totp_code || data.recovery_code || '').trim();
      const verification = await verifyAdminSecondFactor(env.DB, env.TOTP_ENCRYPTION_KEY, {
        totpCode: data.totp_code,
        recoveryCode: data.recovery_code,
        rateLimitScope: getAuthenticatedSecondFactorRateLimitScope(env, sys)
      });
      if (verification.rateLimited) {
        await recordGithubOAuthAdminAudit(
          env.DB,
          request,
          'admin.oauth.github.bind',
          'failure',
          { reason: 'second_factor_rate_limited', method: 'bind' }
        );
        return createSecondFactorRateLimitResponse(verification.retryAfter);
      }
      if (verification.required && !verification.valid) {
        if (hasSecondFactorInput) {
          await recordGithubOAuthAdminAudit(
            env.DB,
            request,
            'admin.oauth.github.bind',
            'failure',
            { reason: 'invalid_second_factor', method: 'bind' }
          );
        }
        return createSecondFactorResponse(
          hasSecondFactorInput ? 'invalid_second_factor' : 'totp_required',
          428
        );
      }
      if (await getGithubOAuthBinding(env.DB)) {
        await recordGithubOAuthAdminAudit(
          env.DB,
          request,
          'admin.oauth.github.bind',
          'failure',
          { reason: 'already_bound', method: 'bind' }
        );
        return createGithubOAuthErrorResponse('github_oauth_already_bound');
      }
      try {
        const authorization = await createGithubOAuthAuthorization(
          env.DB,
          env,
          request,
          {
            purpose: 'bind',
            sessionId: authContext.sessionId,
            returnUrl: data.return_url
          }
        );
        return createSuccessResponse({
          success: true,
          authorize_url: authorization.authorizeUrl
        }, { 'Cache-Control': 'no-store' });
      } catch (error) {
        await recordGithubOAuthAdminAudit(
          env.DB,
          request,
          'admin.oauth.github.bind',
          'failure',
          { reason: 'start_failed', method: 'bind' }
        );
        return createGithubOAuthErrorResponse(getGithubOAuthStartErrorCode(error));
      }
    }
    else if (data.action === 'github_oauth_unbind') {
      const hasSecondFactorInput = !!String(data.totp_code || data.recovery_code || '').trim();
      const verification = await verifyAdminSecondFactor(env.DB, env.TOTP_ENCRYPTION_KEY, {
        totpCode: data.totp_code,
        recoveryCode: data.recovery_code,
        rateLimitScope: getAuthenticatedSecondFactorRateLimitScope(env, sys)
      });
      if (verification.rateLimited) {
        await recordGithubOAuthAdminAudit(
          env.DB,
          request,
          'admin.oauth.github.unbind',
          'failure',
          { reason: 'second_factor_rate_limited', method: 'unbind' }
        );
        return createSecondFactorRateLimitResponse(verification.retryAfter);
      }
      if (verification.required && !verification.valid) {
        if (hasSecondFactorInput) {
          await recordGithubOAuthAdminAudit(
            env.DB,
            request,
            'admin.oauth.github.unbind',
            'failure',
            { reason: 'invalid_second_factor', method: 'unbind' }
          );
        }
        return createSecondFactorResponse(
          hasSecondFactorInput ? 'invalid_second_factor' : 'totp_required',
          428
        );
      }

      const result = await unbindGithubOAuthIdentity(env.DB, authContext.sessionId);
      if (!result.unbound) {
        await recordGithubOAuthAdminAudit(
          env.DB,
          request,
          'admin.oauth.github.unbind',
          'failure',
          { reason: 'not_bound', method: 'session' }
        );
        return createGithubOAuthErrorResponse('github_oauth_not_bound');
      }
      await recordGithubOAuthAdminAudit(
        env.DB,
        request,
        'admin.oauth.github.unbind',
        'success',
        { method: verification.method || 'session' }
      );
      return createSuccessResponse({
        success: true,
        unbound: true,
        revoked_sessions: result.revokedSessions,
        current_session_revoked: result.currentSessionRevoked
      }, { 'Cache-Control': 'no-store' });
    }
    else if (data.action === 'totp_setup') {
      if (!isTotpEncryptionAvailable(env.TOTP_ENCRYPTION_KEY)) {
        return createBadRequestResponse('totp_encryption_key_unavailable');
      }
      const setup = await beginAdminTotpSetup(
        env.DB,
        env.TOTP_ENCRYPTION_KEY,
        sys?.username || env.API_USER_NAME || 'admin'
      );
      if (!setup.success) return createBadRequestResponse(setup.reason);
      return createSuccessResponse({
        success: true,
        secret: setup.secret,
        otpauth_uri: setup.otpauthUri
      }, { 'Cache-Control': 'no-store' });
    }
    else if (data.action === 'totp_confirm') {
      if (!isTotpEncryptionAvailable(env.TOTP_ENCRYPTION_KEY)) {
        return createBadRequestResponse('totp_encryption_key_unavailable');
      }
      const confirmation = await confirmAdminTotpSetup(
        env.DB,
        env.TOTP_ENCRYPTION_KEY,
        data.code,
        { rateLimitScope: getAuthenticatedSecondFactorRateLimitScope(env, sys) }
      );
      if (!confirmation.success) {
        if (confirmation.reason === 'second_factor_rate_limited') {
          return createSecondFactorRateLimitResponse(confirmation.retryAfter);
        }
        if (confirmation.reason === 'invalid_totp_code') {
          await recordAdminAuditEvent(env.DB, request, {
            eventType: 'admin.totp.enable',
            outcome: 'failure',
            targetType: 'admin_security',
            detail: { reason: confirmation.reason }
          });
        }
        return createBadRequestResponse(confirmation.reason);
      }
      await recordAdminAuditEvent(env.DB, request, {
        eventType: 'admin.totp.enable',
        targetType: 'admin_security'
      });
      return createSuccessResponse({
        success: true,
        enabled: true,
        recovery_codes: confirmation.recoveryCodes
      }, { 'Cache-Control': 'no-store' });
    }
    else if (data.action === 'totp_disable') {
      const disabled = await disableAdminTotp(env.DB, env.TOTP_ENCRYPTION_KEY, {
        totpCode: data.code,
        recoveryCode: data.recovery_code,
        rateLimitScope: getAuthenticatedSecondFactorRateLimitScope(env, sys)
      });
      if (!disabled.success) {
        if (disabled.reason === 'second_factor_rate_limited') {
          return createSecondFactorRateLimitResponse(disabled.retryAfter);
        }
        if (disabled.reason === 'invalid_second_factor') {
          await recordAdminAuditEvent(env.DB, request, {
            eventType: 'admin.totp.disable',
            outcome: 'failure',
            targetType: 'admin_security',
            detail: { reason: disabled.reason }
          });
        }
        return disabled.reason === 'totp_not_enabled'
          ? createBadRequestResponse(disabled.reason)
          : createSecondFactorResponse(disabled.reason, 428);
      }
      await recordAdminAuditEvent(env.DB, request, {
        eventType: 'admin.totp.disable',
        targetType: 'admin_security',
        detail: { method: disabled.method }
      });
      return createSuccessResponse({ success: true, enabled: false });
    }
    else if (data.action === 'session_logout') {
      const revoked = await revokeCurrentAdminSession(env.DB, authContext.sessionId);
      if (!revoked) {
        return createBadRequestResponse('session_not_active');
      }
      await recordAdminAuditEvent(env.DB, request, {
        eventType: 'admin.session.logout',
        targetType: 'admin_session',
        targetId: authContext.sessionId
      });
      return createSuccessResponse({
        success: true,
        revoked: true
      });
    }
    else if (data.action === 'session_refresh') {
      const replacement = await refreshAdminSession(
        env.DB,
        authContext.sessionId,
        request,
        session => generateToken(env, sys, {
          sessionId: session.id,
          issuedAt: session.issued_at,
          expiresAt: session.expires_at
        })
      );
      if (!replacement) {
        return createBadRequestResponse('session_not_active');
      }
      await recordAdminAuditEvent(env.DB, request, {
        eventType: 'admin.session.refresh',
        targetType: 'admin_session',
        targetId: replacement.id
      });
      return createSuccessResponse({
        success: true,
        token: replacement.token,
        expires_at: replacement.expires_at
      }, { 'Cache-Control': 'no-store' });
    }
    else if (data.action === 'session_revoke') {
      const result = await revokeAdminSession(
        env.DB,
        data.session_id,
        authContext.sessionId
      );
      if (!result.revoked) {
        return createBadRequestResponse(result.reason);
      }
      await recordAdminAuditEvent(env.DB, request, {
        eventType: 'admin.session.revoke',
        targetType: 'admin_session',
        targetId: data.session_id
      });
      return createSuccessResponse({
        success: true,
        revoked: true
      });
    }
    else if (data.action === 'get_settings') {
      const fullSettings = loadFullSettings ? await loadFullSettings() : sys;
      const githubBinding = await getGithubOAuthBinding(env.DB);
      const {
        jwt_secret,
        password,
        tg_bot_token,
        tg_chat_id,
        ...safeSettings
      } = fullSettings || {};
      return createSuccessResponse({
        success: true,
        settings: {
          ...safeSettings,
          totp_enabled: await isAdminTotpEnabled(env.DB),
          totp_available: isTotpEncryptionAvailable(env.TOTP_ENCRYPTION_KEY),
          github_oauth_available: isGithubOAuthAvailable(env),
          github_oauth_bound: !!githubBinding,
          github_login: githubBinding?.provider_login || '',
          has_notification_credential: !!String(tg_bot_token || '').trim(),
          has_notification_target: !!String(tg_chat_id || '').trim()
        },
        api_secret: env.API_SECRET
      });
    }
    else if (data.action === 'audit_list') {
      const auditPage = await listAuditEvents(env.DB, {
        eventType: data.event_type,
        page: data.page,
        pageSize: data.page_size
      });
      return createSuccessResponse({
        success: true,
        ...auditPage
      });
    }
    else if (data.action === 'notification_delivery_list') {
      const deliveries = await listNotificationDeliveries(env.DB);
      return createSuccessResponse({
        success: true,
        deliveries
      });
    }
    else if (data.action === 'start_theme_preview') {
      const normalizedThemeUrl = normalizeThemeUrl(data.theme_url);
      if (!normalizedThemeUrl) {
        return createBadRequestResponse('invalidThemeUrl');
      }
      if (!await validateThemeUrlAvailable(normalizedThemeUrl)) {
        return createBadRequestResponse('invalidThemeUrl');
      }

      const token = extractBearerToken(request);
      if (!token) {
        return simpleAuthResponse();
      }

      return createSuccessResponse({
        success: true,
        preview_url: buildThemePreviewUrl(request, normalizedThemeUrl)
      }, {
        'Set-Cookie': buildThemePreviewAuthCookie(request, token)
      });
    }
    else if (data.action === 'list') {
      const servers = await getAllServers(env.DB);
      const latestMetricsMap = await getLatestMetricsForAllServers(env.DB);
      
      const now = Date.now();
      const ONLINE_THRESHOLD = 300000;
      const stats = {
        total: servers.length,
        online: 0,
        offline: 0,
        total_cpu: 0,
        total_net_in: 0,
        total_net_out: 0,
        avg_cpu: 0
      };
      
      const serversWithStatus = servers.map(server => {
        const latestMetrics = latestMetricsMap.get(server.id);
        const item = { ...server, region_override: server.region || '' };
        let isOnline = false;
        
        if (latestMetrics) {
          isOnline = (now - latestMetrics.timestamp) < ONLINE_THRESHOLD;
          mergeMetricsIntoServer(item, latestMetrics);
        } else {
          item.last_updated = 0;
          item.is_online = false;
          item.cpu_cores = 0;
          item.cpu_info = '';
          item.arch = '';
          item.os = '';
          item.agent_version = '';
          item.ip_v4 = '0';
          item.ip_v6 = '0';
          item.boot_time = '';
        }
        
        item.is_online = isOnline;
        if (!item.region) item.region = server.region || '';
        delete item.bandwidth;

        if (isOnline) {
          stats.online++;
          stats.total_cpu += parseFloat(item.cpu) || 0;
          stats.total_net_in += parseFloat(item.net_in_speed) || 0;
          stats.total_net_out += parseFloat(item.net_out_speed) || 0;
        } else {
          stats.offline++;
        }
        
        return item;
      });
      
      if (stats.online > 0) {
        stats.avg_cpu = (stats.total_cpu / stats.online).toFixed(2);
      }

      return createSuccessResponse({
        success: true,
        servers: serversWithStatus,
        stats
      });
    }
    else if (data.action === 'd1_usage') {
      const hasCloudflareToken = Object.prototype.hasOwnProperty.call(data, 'cloudflare_token');
      const hasCloudflareAccountId = Object.prototype.hasOwnProperty.call(data, 'cloudflare_account_id');
      const cloudflareToken = hasCloudflareToken ? data.cloudflare_token : (sys?.cloudflare_token || '');
      const cloudflareAccountId = hasCloudflareAccountId ? data.cloudflare_account_id : (sys?.cloudflare_account_id || '');

      try {
        const usage = await getD1DailyUsage(String(cloudflareToken || '').trim(), String(cloudflareAccountId || '').trim());
        return createSuccessResponse({
          success: true,
          usage,
          message: 'd1UsageQueried'
        });
      } catch (e) {
        return createBadRequestResponse(e.message);
      }
    }
    else if (data.action === 'send_test_notification') {
      const { notification_provider, tg_bot_token, tg_chat_id } = data;
      const effectiveNotificationProvider = notification_provider || sys?.notification_provider || 'auto';
      const effectiveNotificationCredential = String(tg_bot_token || sys?.tg_bot_token || '').trim();
      const effectiveNotificationTarget = String(tg_chat_id || sys?.tg_chat_id || '').trim();
      if (!effectiveNotificationCredential) {
        return createBadRequestResponse('tgBotTokenRequired');
      }
      try {
        const testMsg = `✅ **测试通知**\n\n这是一条来自 CF Server Monitor 的测试消息。\n\n**时间:** ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
        const delivery = await sendNotification({
          notification_provider: effectiveNotificationProvider,
          tg_bot_token: effectiveNotificationCredential,
          tg_chat_id: effectiveNotificationTarget
        }, testMsg, {
          db: env.DB,
          source: 'test'
        });
        await recordAdminAuditEvent(env.DB, request, {
          eventType: 'admin.notification.test',
          outcome: delivery.success ? 'success' : 'failure',
          targetType: 'notification_provider',
          targetId: delivery.provider,
          detail: {
            provider: delivery.provider,
            ...(delivery.error ? { error: delivery.error } : {})
          }
        });
        if (!delivery.success) {
          console.warn(JSON.stringify({
            event: 'notification.test.failed',
            provider: delivery.provider,
            attempts: delivery.attempts,
            error: delivery.error
          }));
          return new Response(JSON.stringify({
            error: 'testNotificationFailed',
            code: 400,
            delivery
          }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          });
        }
        return createSuccessResponse({
          success: true,
          message: 'testNotificationSent',
          delivery
        });
      } catch (e) {
        return createBadRequestResponse('testNotificationFailed');
      }
    }
    else if (data.action === 'save_settings') {
      const settings = data.settings || {};
      if (
        await isAdminTotpEnabled(env.DB) &&
        requiresTotpForSettings(settings, sys)
      ) {
        const verification = await verifyAdminSecondFactor(env.DB, env.TOTP_ENCRYPTION_KEY, {
          totpCode: data.totp_code,
          rateLimitScope: getAuthenticatedSecondFactorRateLimitScope(env, sys)
        });
        if (verification.rateLimited) {
          return createSecondFactorRateLimitResponse(verification.retryAfter);
        }
        if (!verification.valid) {
          if (String(data.totp_code || '').trim()) {
            await recordAdminAuditEvent(env.DB, request, {
              eventType: 'admin.settings.second_factor',
              outcome: 'failure',
              targetType: 'settings',
              detail: { reason: 'invalid_second_factor' }
            });
          }
          return createSecondFactorResponse(
            String(data.totp_code || '').trim() ? 'invalid_second_factor' : 'totp_required',
            428
          );
        }
      }
      const currentNotificationProvider = String(sys?.notification_provider || 'auto').trim().toLowerCase();
      const requestedNotificationProvider = String(
        settings.notification_provider ?? currentNotificationProvider
      ).trim().toLowerCase() || 'auto';
      const notificationProviderChanged = settings.notification_provider !== undefined &&
        requestedNotificationProvider !== currentNotificationProvider;
      if (notificationProviderChanged && !String(settings.tg_bot_token || '').trim()) {
        return createBadRequestResponse('tgBotTokenRequired');
      }

      const normalizedThemeUrl = normalizeThemeUrl(settings.theme_url);
      if (normalizedThemeUrl === null) {
        return createBadRequestResponse('invalidThemeUrl');
      }
      if (normalizedThemeUrl && !await validateThemeUrlAvailable(normalizedThemeUrl)) {
        return createBadRequestResponse('invalidThemeUrl');
      }

      // 如果 turnstile_enabled 或 turnstile_login_enabled 开启，验证 turnstile_site_key 和 turnstile_secret_key 都不为空
      if (settings.turnstile_enabled === 'true' || settings.turnstile_enabled === true || settings.turnstile_login_enabled === 'true' || settings.turnstile_login_enabled === true) {
        if (!settings.turnstile_site_key || settings.turnstile_site_key.trim().length === 0) {
          return createBadRequestResponse('turnstileSiteKeyRequired');
        }
        if (!settings.turnstile_secret_key || settings.turnstile_secret_key.trim().length === 0) {
          return createBadRequestResponse('turnstileSecretKeyRequired');
        }
      }

      // 如果 tg_notify 或 expire_reminder 开启，验证 tg_bot_token 不为空
      const hasResourceAlertRulesInput = settings.resource_alert_rules !== undefined;
      const tgNotify = settings.tg_notify !== undefined
        ? normalizeTgNotify(settings.tg_notify)
        : normalizeTgNotify(sys?.tg_notify);
      const expireReminder = settings.expire_reminder !== undefined
        ? normalizeExpireReminder(settings.expire_reminder)
        : normalizeExpireReminder(sys?.expire_reminder);
      const trafficReportSchedule = settings.traffic_report_schedule !== undefined
        ? normalizeTrafficReportSchedule(settings.traffic_report_schedule)
        : normalizeTrafficReportSchedule(sys?.traffic_report_schedule);
      const currentResourceAlertRules = normalizeResourceAlertRules(sys?.resource_alert_rules);
      const normalizedResourceAlertRules = hasResourceAlertRulesInput
        ? normalizeResourceAlertRules(settings.resource_alert_rules)
        : currentResourceAlertRules;
      const resourceAlertEnabled = normalizedResourceAlertRules.length > 0;
      if (tgNotify !== '0' || expireReminder !== '0' || trafficReportSchedule !== 'off' || resourceAlertEnabled) {
        const effectiveTgBotToken = settings.tg_bot_token !== undefined
          ? settings.tg_bot_token
          : sys?.tg_bot_token;
        if (!effectiveTgBotToken || String(effectiveTgBotToken).trim().length === 0) {
          return createBadRequestResponse('tgBotTokenRequired');
        }
      }

      const pingNodes = normalizePingNodeFields(settings);
      if (!pingNodes.valid) {
        return createBadRequestResponse('invalidPingNodeFormat');
      }

      if (settings.appearance_options !== undefined && (
        settings.appearance_options === null ||
        typeof settings.appearance_options !== 'object' ||
        Array.isArray(settings.appearance_options)
      )) {
        return createBadRequestResponse('invalidThemeOptionsFormat');
      }

      const shouldSaveAppearanceOptions = hasAppearanceInput(settings);
      const appearanceOptions = {};

      if (shouldSaveAppearanceOptions) {
        const nestedAppearanceOptions = settings.appearance_options || {};
        for (const field of APPEARANCE_FIELDS) {
          const value = field === 'theme_options' ? nestedAppearanceOptions.theme_options : settings[field];
          if (value !== undefined) {
            // CSP 字段格式校验：只允许 https:// 开头的域名，逗号分隔
            if (field === 'csp_static' || field === 'csp_api') {
              appearanceOptions[field] = sanitizeCspDomains(value);
            } else if (field === 'display_mode') {
              appearanceOptions[field] = normalizeDisplayMode(value);
            } else if (field === 'theme_options') {
              if (value === null || typeof value !== 'object' || Array.isArray(value)) {
                return createBadRequestResponse('invalidThemeOptionsFormat');
              }
              appearanceOptions[field] = value;
            } else {
              appearanceOptions[field] = value;
            }
          }
        }
        await env.DB.prepare(
          'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
        ).bind('appearance_options', JSON.stringify(appearanceOptions)).run();
        clearAppearanceSettingsCache();
      }

      const siteOptions = {};
      const shouldCloseAgentWssReports = settings.wss_report_enabled !== undefined &&
        normalizeBooleanSetting(settings.wss_report_enabled) === 'false';
      for (const field of SITE_FIELDS) {
        if (settings[field] !== undefined) {
          if (field === 'password') {
            if (settings[field] && settings[field].length > 0) {
              siteOptions[field] = await hashPassword(settings[field]);
            }
          } else if (PING_NODE_FIELDS.includes(field)) {
            siteOptions[field] = pingNodes.values[field];
          } else if (field === 'tg_notify') {
            siteOptions[field] = tgNotify;
          } else if (field === 'expire_reminder') {
            siteOptions[field] = expireReminder;
          } else if (field === 'traffic_report_schedule') {
            siteOptions[field] = trafficReportSchedule;
          } else if (field === 'long_history_points') {
            siteOptions[field] = normalizeLongHistoryPoints(settings[field]);
          } else if (field === 'resource_alert_rules') {
            siteOptions[field] = normalizedResourceAlertRules;
          } else if (field === 'wss_report_enabled') {
            siteOptions[field] = normalizeBooleanSetting(settings[field]);
          } else if (field === 'theme_url') {
            siteOptions[field] = normalizedThemeUrl;
          } else {
            siteOptions[field] = settings[field];
          }
        }
      }
      await saveSiteOptions(env.DB, siteOptions);
      // Keep existing states on rule edits so threshold increases can emit recovery notifications.
      // checkResourceAlerts prunes states for removed rules or servers on the next evaluation.
      if (hasResourceAlertRulesInput && !resourceAlertEnabled) {
        await clearResourceAlertState(env.DB);
      }
      Object.assign(sys, shouldSaveAppearanceOptions ? appearanceOptions : {}, siteOptions);
      if (shouldCloseAgentWssReports) {
        scheduleAgentReportModeChanged(env, ctx);
      }
      await recordAdminAuditEvent(env.DB, request, {
        eventType: 'admin.settings.update',
        targetType: 'settings',
        detail: {
          changed_fields: [...new Set([
            ...Object.keys(siteOptions),
            ...Object.keys(appearanceOptions)
          ])].sort()
        }
      });
      return createSuccessResponse({
        success: true,
        message: 'updateSuccess'
      });
    } 
    else if (data.action === 'add') {
      const name = data.name || 'New Server';
      if (!isValidName(name)) {
        return createBadRequestResponse('invalidServerName');
      }
      const networkInterfaces = normalizeNetworkInterfaceField(data.interface);
      if (!networkInterfaces.valid) {
        return createBadRequestResponse('invalidNetworkInterface');
      }
      
      const id = crypto.randomUUID();
      const group = data.server_group || 'Default';
      const region = normalizeServerRegion(data.region);

      try {
        const { max_order } = await env.DB.prepare('SELECT COALESCE(MAX(sort_order), -1) as max_order FROM servers').first();
        const sortOrder = (max_order || 0) + 1;

        const historyPartitionId = await getNextServerHistoryPartitionId(env.DB);

        const insertServer = env.DB.prepare(`
          INSERT INTO servers
          (id, name, server_group, region, "interface", sort_order, history_partition_id, timestamp)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(id, name, group, region, networkInterfaces.value, sortOrder, historyPartitionId, Date.now());
        await env.DB.batch([
          insertServer,
          defaultPingTaskAssignmentStatement(env.DB, id)
        ]);
      } catch (e) {
        return handleServerMutationError(env.DB, e, 'serverAddFailed');
      }
      
      clearServersListCache();
      await recordAdminAuditEvent(env.DB, request, {
        eventType: 'admin.server.create',
        targetType: 'server',
        targetId: id,
        detail: {}
      });
      
      return createSuccessResponse({ 
        success: true, 
        id: id,
        message: 'serverAdded'
      });
    } 
    else if (data.action === 'delete') {
      const { id } = data;
      if (!id || !isValidUUID(id)) {
        return createBadRequestResponse('invalidServerId');
      }
      
      await deleteServer(env.DB, id);
      
      clearServersListCache();
      await recordAdminAuditEvent(env.DB, request, {
        eventType: 'admin.server.delete',
        targetType: 'server',
        targetId: id,
        detail: {}
      });
      
      return createSuccessResponse({ 
        success: true, 
        message: 'serverDeleted'
      });
    } 
    else if (data.action === 'save_order') {
      const { orders } = data;
      if (!orders || !Array.isArray(orders) || orders.length === 0) {
        return createBadRequestResponse('missingSortData');
      }
      
      for (let i = 0; i < orders.length; i++) {
        if (!isValidUUID(orders[i])) {
          return createBadRequestResponse('invalidSortId');
        }
        await env.DB.prepare('UPDATE servers SET sort_order = ? WHERE id = ?').bind(i, orders[i]).run();
      }
      
      clearServersListCache();
      await recordAdminAuditEvent(env.DB, request, {
        eventType: 'admin.server.reorder',
        targetType: 'server_collection',
        detail: { count: orders.length }
      });
      
      return createSuccessResponse({ 
        success: true, 
        message: 'sortOrderSaved'
      });
    }
    else if (data.action === 'edit') {
      const { id, name, server_group, region, tags, note, internal_note, public_note, price, billing_cycle, auto_renewal, currency, expire_date, traffic_limit, traffic_calc_type, interface: networkInterfaceInput, reset_day, collect_interval, report_interval, connection_mode, auto_update, custom_ct, custom_cu, custom_cm, custom_bd, rx_correction, tx_correction, offline_notify_disabled, is_hidden } = data;
      if (!id || !isValidUUID(id)) {
        return createBadRequestResponse('invalidServerId');
      }
      const effectiveConnectionMode = isWssReportEnabled(sys) ? connection_mode : 'http';
      const agentConfigResult = validateAgentConfigInput({
        collect_interval,
        report_interval,
        reset_day,
        connection_mode: effectiveConnectionMode
      });
      if (!agentConfigResult.valid) {
        return createBadRequestResponse(agentConfigResult.error);
      }
      const normalizedAgentConfig = agentConfigResult.config;

      const pingNodes = normalizePingNodeFields({ custom_ct, custom_cu, custom_cm, custom_bd });
      if (!pingNodes.valid) {
        return createBadRequestResponse('invalidPingNodeFormat');
      }
      const networkInterfaces = normalizeNetworkInterfaceField(networkInterfaceInput);
      if (!networkInterfaces.valid) {
        return createBadRequestResponse('invalidNetworkInterface');
      }
      const safeTags = String(tags || '')
        .split(',')
        .map(tag => tag.trim().replace(/[^\p{L}\p{N} ._\-]/gu, '').slice(0, 32))
        .filter(Boolean)
        .slice(0, 12)
        .join(',');
      const safeInternalNote = String(internal_note !== undefined ? internal_note : (note || ''))
        .trim()
        .slice(0, 500);
      const safePublicNote = String(public_note || '').trim().slice(0, 500);

      const toNullCorrection = (v) => {
        if (v === null || v === undefined || v === '') return null;
        return isValidTrafficCorrection(v) ? Number(v) : undefined;
      };
      const safeRx = toNullCorrection(rx_correction);
      const safeTx = toNullCorrection(tx_correction);
      if (safeRx === undefined || safeTx === undefined) {
        return createBadRequestResponse('invalidTrafficCorrection');
      }

      const billingData = normalizeServerBillingData({
        price,
        billing_cycle,
        auto_renewal,
        currency,
        expire_date
      });
      
      try {
        await env.DB.prepare(`
          UPDATE servers
          SET name = ?, server_group = ?, region = ?, tags = ?, note = ?, internal_note = ?, public_note = ?, price = ?, billing_cycle = ?, auto_renewal = ?, currency = ?, expire_date = ?, traffic_limit = ?, traffic_calc_type = ?, "interface" = ?, reset_day = ?, collect_interval = ?, report_interval = ?, connection_mode = ?, auto_update = ?, custom_ct = ?, custom_cu = ?, custom_cm = ?, custom_bd = ?, rx_correction = ?, tx_correction = ?, offline_notify_disabled = ?, is_hidden = ?
          WHERE id = ?
        `).bind(
          name || '',
          server_group || 'Default',
          normalizeServerRegion(region),
          safeTags,
          safeInternalNote,
          safeInternalNote,
          safePublicNote,
          billingData.price,
          billingData.billing_cycle,
          billingData.auto_renewal,
          billingData.currency,
          billingData.expire_date,
          traffic_limit || '',
          traffic_calc_type || 'total',
          networkInterfaces.value,
          normalizedAgentConfig.reset_day,
          normalizedAgentConfig.collect_interval,
          normalizedAgentConfig.report_interval,
          normalizedAgentConfig.connection_mode,
          normalizeBooleanFlag(auto_update),
          pingNodes.values.custom_ct,
          pingNodes.values.custom_cu,
          pingNodes.values.custom_cm,
          pingNodes.values.custom_bd,
          safeRx,
          safeTx,
          normalizeBooleanFlag(offline_notify_disabled),
          normalizeBooleanFlag(is_hidden),
          id
        ).run();
      } catch (e) {
        return handleServerMutationError(env.DB, e, 'serverUpdateFailed');
      }
      
      clearServersListCache();
      scheduleAgentConfigChanged(env, ctx, id);
      await recordAdminAuditEvent(env.DB, request, {
        eventType: 'admin.server.update',
        targetType: 'server',
        targetId: id,
        detail: {}
      });
      
      return createSuccessResponse({ 
        success: true, 
        message: 'serverUpdated'
      });
    }
    else if (data.action === 'batch_delete') {
      const { ids } = data;
      if (!ids || !Array.isArray(ids) || ids.length === 0) {
        return createBadRequestResponse('selectServersToDelete');
      }
      
      for (const id of ids) {
        if (!isValidUUID(id)) {
          return createBadRequestResponse('invalidServerIdInList');
        }
      }
      
      for (const id of ids) {
        await deleteServer(env.DB, id);
      }
      
      clearServersListCache();
      await recordAdminAuditEvent(env.DB, request, {
        eventType: 'admin.server.batch_delete',
        targetType: 'server_collection',
        detail: { count: ids.length }
      });
      
      return createSuccessResponse({ 
        success: true, 
        message: 'batchDeleted'
      });
    }
    
    else if (data.action === 'export_servers') {
      try {
        const servers = await env.DB.prepare('SELECT * FROM servers ORDER BY sort_order ASC').all();
        return createSuccessResponse({
          success: true,
          servers: servers.results || [],
          message: 'serversExported'
        });
      } catch (e) {
        return createBadRequestResponse('serversExportFailed');
      }
    }
    else if (data.action === 'import_servers') {
      const { servers: importData } = data;
      if (!importData || !Array.isArray(importData) || importData.length === 0) {
        return createBadRequestResponse('noServersToImport');
      }

      const existingServers = await env.DB.prepare('SELECT id FROM servers').all();
      const existingIds = new Set((existingServers.results || []).map(s => s.id));

      const existingPartitionIds = await env.DB.prepare('SELECT history_partition_id FROM servers').all();
      const usedPartitionIds = new Set(
        (existingPartitionIds.results || []).map(s => s.history_partition_id).filter(id => id > 0)
      );

      let imported = 0;
      let skipped = 0;
      const skippedIds = [];

      for (const server of importData) {
        if (!server.id || !isValidUUID(server.id)) {
          skipped++;
          skippedIds.push(server.id || '(invalid)');
          continue;
        }

        if (existingIds.has(server.id)) {
          skipped++;
          skippedIds.push(server.id);
          continue;
        }

        let partitionId = Number(server.history_partition_id) || 0;
        if (partitionId <= 0 || partitionId > HISTORY_MAX_PARTITION_ID || usedPartitionIds.has(partitionId)) {
          partitionId = 0;
          for (let id = 1; id <= HISTORY_MAX_PARTITION_ID; id++) {
            if (!usedPartitionIds.has(id)) {
              partitionId = id;
              break;
            }
          }
          if (partitionId === 0) {
            skipped++;
            skippedIds.push(server.id);
            continue;
          }
        }

        usedPartitionIds.add(partitionId);
        existingIds.add(server.id);

        const billingData = normalizeServerBillingData(server);
        const networkInterfaces = normalizeNetworkInterfaceField(server.interface);
        if (!networkInterfaces.valid) {
          skipped++;
          skippedIds.push(server.id);
          continue;
        }

        try {
          const insertServer = env.DB.prepare(`
            INSERT INTO servers (id, name, server_group, region, tags, note, internal_note, public_note, price, billing_cycle, auto_renewal,
              currency, expire_date,
              traffic_limit, traffic_calc_type, "interface", reset_day, collect_interval, report_interval, connection_mode,
              auto_update, custom_ct, custom_cu, custom_cm, custom_bd, rx_correction, tx_correction,
              offline_notify_disabled, is_hidden, sort_order, history_partition_id, timestamp)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).bind(
            server.id,
            server.name || '',
            server.server_group || 'Default',
            normalizeServerRegion(server.region),
            server.tags || '',
            server.internal_note ?? server.note ?? '',
            server.internal_note ?? server.note ?? '',
            server.public_note || '',
            billingData.price,
            billingData.billing_cycle,
            billingData.auto_renewal,
            billingData.currency,
            billingData.expire_date,
            server.traffic_limit || '',
            server.traffic_calc_type || 'total',
            networkInterfaces.value,
            server.reset_day ?? 1,
            server.collect_interval ?? 0,
            server.report_interval ?? 60,
            normalizeConnectionMode(server.connection_mode) || 'auto',
            normalizeBooleanFlag(server.auto_update),
            server.custom_ct || '',
            server.custom_cu || '',
            server.custom_cm || '',
            server.custom_bd || '',
            server.rx_correction ?? null,
            server.tx_correction ?? null,
            normalizeBooleanFlag(server.offline_notify_disabled),
            normalizeBooleanFlag(server.is_hidden),
            server.sort_order ?? 0,
            partitionId,
            server.timestamp || Date.now()
          );
          await env.DB.batch([
            insertServer,
            defaultPingTaskAssignmentStatement(env.DB, server.id)
          ]);
          imported++;
        } catch (e) {
          skipped++;
          skippedIds.push(server.id);
        }
      }

      clearServersListCache();
      await recordAdminAuditEvent(env.DB, request, {
        eventType: 'admin.server.import',
        targetType: 'server_collection',
        detail: { imported, skipped }
      });

      return createSuccessResponse({
        success: true,
        imported,
        skipped,
        skippedIds,
        message: imported > 0 ? 'serversImported' : 'noServersImported'
      });
    }
    
    return createBadRequestResponse('unknownAction');
    
  } catch (e) {
    console.error('Admin API 错误:', e);
    return createErrorResponse(e);
  }
}
