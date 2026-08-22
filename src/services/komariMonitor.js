import { loadSiteSettings } from '../utils/settings.js';
import { dispatchNotification } from './notificationQueue.js';
import { isFeishuAppConfigured } from './notification.js';

const STATE_KEY = 'komari_monitor_state_v1';
const RPC_PATH = '/api/rpc2';
const FETCH_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const OFFLINE_DELAY_MS = 3 * 60 * 1000;
const LINE_ALERT_DELAY_MS = 5 * 60 * 1000;
const LATENCY_THRESHOLD_MS = 200;
const LOSS_THRESHOLD_PERCENT = 10;
const TRAFFIC_USED_THRESHOLD_PERCENT = 80;
const TRAFFIC_ALERT_STEP_PERCENT = 5;
const EXPIRATION_ALERT_DAYS = 7;
const DAILY_REPORT_UTC_HOUR = 0;
const DAILY_REPORT_WINDOW_MINUTES = 10;
const GIBIBYTE = 1024 ** 3;
const LINE_KEYS = ['5', '6', '7'];

function cleanText(value, fallback = '', maxLength = 80) {
  return String(value ?? fallback)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\[\]_*`]/g, '')
    .trim()
    .slice(0, maxLength) || fallback;
}

function toFiniteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function formatBytes(bytes) {
  const value = Math.max(0, toFiniteNumber(bytes));
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let amount = value;
  let unitIndex = 0;
  while (amount >= 1024 && unitIndex < units.length - 1) {
    amount /= 1024;
    unitIndex += 1;
  }
  return `${amount.toFixed(unitIndex === 0 ? 0 : 2)} ${units[unitIndex]}`;
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '未设置';
  return date.toISOString().slice(0, 10);
}

function getExpirationDays(value, now) {
  const expiresAt = new Date(value).getTime();
  if (!Number.isFinite(expiresAt)) return null;
  return Math.ceil((expiresAt - now) / (24 * 60 * 60 * 1000));
}

function normalizeBaseUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return '';
    url.pathname = url.pathname.replace(/\/+$/, '');
    return url.toString().replace(/\/$/, '');
  } catch (_) {
    return '';
  }
}

function normalizeState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { version: 1, dailyReportKey: '', nodes: {} };
  }
  return {
    version: 1,
    dailyReportKey: String(value.dailyReportKey || ''),
    nodes: value.nodes && typeof value.nodes === 'object' && !Array.isArray(value.nodes)
      ? value.nodes
      : {}
  };
}

function getTrafficUsedBytes(node, status) {
  const up = Math.max(0, toFiniteNumber(status?.net_total_up));
  const down = Math.max(0, toFiniteNumber(status?.net_total_down));
  const type = String(node?.traffic_limit_type || 'sum').trim().toLowerCase();
  if (type === 'up') return up;
  if (type === 'down') return down;
  if (type === 'max') return Math.max(up, down);
  if (type === 'min') return Math.min(up, down);
  return up + down;
}

function getTrafficSnapshot(node, status) {
  const limit = Math.max(0, toFiniteNumber(node?.traffic_limit));
  const used = getTrafficUsedBytes(node, status);
  if (limit <= 0) {
    return { limit, used, remaining: null, usedPercent: null };
  }
  return {
    limit,
    used,
    remaining: Math.max(0, limit - used),
    usedPercent: used / limit * 100
  };
}

function getLineSnapshot(status) {
  const ping = status?.ping && typeof status.ping === 'object' ? status.ping : {};
  return LINE_KEYS.map(key => {
    const item = ping[key] || {};
    return {
      key,
      name: cleanText(item.name, key, 24),
      latency: Math.max(0, toFiniteNumber(item.avg ?? item.latest)),
      loss: Math.max(0, toFiniteNumber(item.loss))
    };
  }).filter(line => line.latency > 0 || line.loss > 0);
}

function formatLineSummary(status) {
  const lines = getLineSnapshot(status);
  if (lines.length === 0) return '线路数据暂无';
  return lines.map(line => `${line.name} ${line.latency.toFixed(0)}ms/${line.loss.toFixed(1)}%`).join('；');
}

function buildTrafficText(node, status) {
  const traffic = getTrafficSnapshot(node, status);
  if (traffic.limit <= 0) return `流量 ${formatBytes(traffic.used)} / 不限`;
  return `流量 ${formatBytes(traffic.used)} / ${formatBytes(traffic.limit)}，剩余 ${formatBytes(traffic.remaining)} (${Math.max(0, 100 - traffic.usedPercent).toFixed(1)}%)`;
}

export function buildKomariDailyReport(nodesInput, statusesInput, nowInput = Date.now()) {
  const nodes = Array.isArray(nodesInput) ? nodesInput : Object.values(nodesInput || {});
  const statuses = statusesInput && typeof statusesInput === 'object' ? statusesInput : {};
  const now = Number(nowInput) || Date.now();
  const lines = nodes.map(node => {
    const id = String(node?.uuid || '');
    const status = statuses[id] || {};
    const online = status.online === true;
    const expiry = formatDate(node?.expired_at);
    return `• ${cleanText(node?.name, '未命名节点')} - ${online ? '在线' : '离线'}\n  ${buildTrafficText(node, status)}\n  线路 ${formatLineSummary(status)}\n  有效期 ${expiry}`;
  });
  return `📡 **VPS 每日状态摘要**\n\n${lines.join('\n\n')}\n\n**统计时点:** ${new Date(now).toISOString()}\n**告警阈值:** 离线 3 分钟；延迟 > 200ms 或丢包 > 10% 持续 5 分钟；流量使用 >= 80%`;
}

function analyzeNode(node, status, previous, now) {
  const next = {
    offlineSince: toFiniteNumber(previous?.offlineSince),
    offlineActive: previous?.offlineActive === true,
    lineSince: toFiniteNumber(previous?.lineSince),
    lineActive: previous?.lineActive === true,
    trafficStep: Math.max(0, toFiniteNumber(previous?.trafficStep)),
    expirationKey: String(previous?.expirationKey || '')
  };
  const alerts = [];
  const recoveries = [];
  const name = cleanText(node?.name, '未命名节点');
  const online = status?.online === true;

  if (!online) {
    if (!next.offlineSince) next.offlineSince = now;
    if (!next.offlineActive && now - next.offlineSince >= OFFLINE_DELAY_MS) {
      alerts.push(`• ${name} - 已连续离线 3 分钟`);
      next.offlineActive = true;
    }
  } else {
    if (next.offlineActive) recoveries.push(`• ${name} - 节点已恢复在线`);
    next.offlineSince = 0;
    next.offlineActive = false;
  }

  const abnormalLines = getLineSnapshot(status).filter(line => (
    line.latency > LATENCY_THRESHOLD_MS || line.loss > LOSS_THRESHOLD_PERCENT
  ));
  if (online && abnormalLines.length > 0) {
    if (!next.lineSince) next.lineSince = now;
    if (!next.lineActive && now - next.lineSince >= LINE_ALERT_DELAY_MS) {
      const details = abnormalLines.map(line => `${line.name} ${line.latency.toFixed(0)}ms/${line.loss.toFixed(1)}%`).join('；');
      alerts.push(`• ${name} - 线路质量异常：${details}`);
      next.lineActive = true;
    }
  } else {
    if (next.lineActive) recoveries.push(`• ${name} - 线路质量已恢复：${formatLineSummary(status)}`);
    next.lineSince = 0;
    next.lineActive = false;
  }

  const traffic = getTrafficSnapshot(node, status);
  if (traffic.usedPercent !== null && traffic.usedPercent >= TRAFFIC_USED_THRESHOLD_PERCENT) {
    const step = Math.min(100, Math.floor(traffic.usedPercent / TRAFFIC_ALERT_STEP_PERCENT) * TRAFFIC_ALERT_STEP_PERCENT);
    if (step > next.trafficStep) {
      alerts.push(`• ${name} - 流量已使用 ${traffic.usedPercent.toFixed(1)}%，剩余 ${formatBytes(traffic.remaining)} / ${formatBytes(traffic.limit)}`);
      next.trafficStep = step;
    }
  } else {
    next.trafficStep = 0;
  }

  const expirationDays = getExpirationDays(node?.expired_at, now);
  const expirationKey = expirationDays !== null && expirationDays >= 0 && expirationDays <= EXPIRATION_ALERT_DAYS
    ? `${formatDate(node?.expired_at)}:${expirationDays}`
    : '';
  if (expirationKey && expirationKey !== next.expirationKey) {
    alerts.push(`• ${name} - 有效期剩余 ${expirationDays} 天 (${formatDate(node?.expired_at)})`);
    next.expirationKey = expirationKey;
  } else if (!expirationKey) {
    next.expirationKey = '';
  }

  return { next, alerts, recoveries };
}

export function analyzeKomariSnapshot(nodesInput, statusesInput, previousStateInput, nowInput = Date.now()) {
  const nodes = Array.isArray(nodesInput) ? nodesInput : Object.values(nodesInput || {});
  const statuses = statusesInput && typeof statusesInput === 'object' ? statusesInput : {};
  const previousState = normalizeState(previousStateInput);
  const now = Number(nowInput) || Date.now();
  const state = { ...previousState, nodes: {} };
  const alerts = [];
  const recoveries = [];

  for (const node of nodes) {
    const id = String(node?.uuid || '').trim();
    if (!id) continue;
    const analysis = analyzeNode(node, statuses[id], previousState.nodes[id], now);
    state.nodes[id] = analysis.next;
    alerts.push(...analysis.alerts);
    recoveries.push(...analysis.recoveries);
  }

  return { state, alerts, recoveries };
}

async function rpcCall(baseUrl, method, fetchImpl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${baseUrl}${RPC_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method, id: 1 }),
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
      throw new Error('response_too_large');
    }
    const payload = JSON.parse(text);
    if (payload?.error || payload?.result === undefined) throw new Error('invalid_rpc_response');
    return payload.result;
  } finally {
    clearTimeout(timeout);
  }
}

async function loadState(db) {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(STATE_KEY).first();
  if (!row?.value) return normalizeState(null);
  try {
    return normalizeState(JSON.parse(row.value));
  } catch (_) {
    return normalizeState(null);
  }
}

async function saveState(db, state) {
  await db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).bind(STATE_KEY, JSON.stringify(state)).run();
}

export async function runKomariMonitor(env, nowInput = new Date(), sendNotification) {
  if (!env?.DB || typeof sendNotification !== 'function') return { checked: false, reason: 'invalid_environment' };
  const baseUrl = normalizeBaseUrl(env.KOMARI_MONITOR_URL);
  if (!baseUrl) return { checked: false, reason: 'disabled' };

  const settings = await loadSiteSettings(env.DB, { forceRefresh: true });
  const hasNotificationCredential = String(settings.tg_bot_token || '').trim() ||
    (String(settings.notification_provider || '').trim().toLowerCase() === 'feishu_app' &&
      isFeishuAppConfigured(env));
  if (!hasNotificationCredential) {
    return { checked: false, reason: 'missing_notification_credential' };
  }

  const fetchImpl = typeof env.KOMARI_MONITOR_FETCH === 'function'
    ? env.KOMARI_MONITOR_FETCH
    : fetch;
  const [nodes, statuses] = await Promise.all([
    rpcCall(baseUrl, 'public:getNodesInformation', fetchImpl),
    rpcCall(baseUrl, 'common:getNodesLatestStatus', fetchImpl)
  ]);
  const nowDate = nowInput instanceof Date ? new Date(nowInput.getTime()) : new Date(nowInput);
  const now = nowDate.getTime();
  if (Number.isNaN(now)) throw new TypeError('invalid monitor time');

  const previousState = await loadState(env.DB);
  const analysis = analyzeKomariSnapshot(nodes, statuses, previousState, now);
  const dailyKey = nowDate.toISOString().slice(0, 10);
  const dailyDue = nowDate.getUTCHours() === DAILY_REPORT_UTC_HOUR &&
    nowDate.getUTCMinutes() < DAILY_REPORT_WINDOW_MINUTES &&
    analysis.state.dailyReportKey !== dailyKey;

  const sections = [];
  if (analysis.alerts.length > 0) sections.push(`⚠️ **VPS 异常告警**\n\n${analysis.alerts.join('\n')}`);
  if (analysis.recoveries.length > 0) sections.push(`✅ **VPS 恢复通知**\n\n${analysis.recoveries.join('\n')}`);
  if (dailyDue) {
    sections.push(buildKomariDailyReport(nodes, statuses, now));
    analysis.state.dailyReportKey = dailyKey;
  }

  if (JSON.stringify(analysis.state) !== JSON.stringify(previousState)) {
    await saveState(env.DB, analysis.state);
  }
  if (sections.length === 0) {
    return { checked: true, notifications: 0, node_count: Array.isArray(nodes) ? nodes.length : 0 };
  }

  const message = `${sections.join('\n\n')}\n\n**数据源:** Komari 只读公开 RPC`;
  const delivery = await dispatchNotification(env, settings, message, 'komari_monitor', sendNotification);
  return {
    checked: true,
    notifications: 1,
    node_count: Array.isArray(nodes) ? nodes.length : 0,
    delivery
  };
}
