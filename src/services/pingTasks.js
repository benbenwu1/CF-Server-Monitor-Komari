export const PING_TASK_TYPES = new Set(['icmp', 'tcp', 'http']);
export const MAX_PING_TASKS = 100;
export const MAX_PING_TASKS_PER_SERVER = 10;
export const MIN_PING_TASK_INTERVAL_SECONDS = 60;
export const MAX_PING_TASK_INTERVAL_SECONDS = 86400;
export const MIN_PING_TASK_TIMEOUT_MS = 500;
export const MAX_PING_TASK_TIMEOUT_MS = 10000;
export const MAX_PING_RESULTS_PER_REPORT = 20;
export const MAX_PING_HISTORY_RESULTS_PER_TASK = 2048;
export const PING_RESULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PING_RESULT_BATCH_ID_PATTERN = /^[a-z0-9_-]{1,64}$/i;
const HOSTNAME_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;

export class PingTaskError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'PingTaskError';
    this.status = status;
  }
}

function booleanValue(value, fallback = false) {
  if (value === undefined) return fallback;
  if (value === true || value === 1 || value === '1') return true;
  if (value === false || value === 0 || value === '0') return false;
  throw new PingTaskError('invalidPingTaskBoolean');
}

function integerValue(value, name, min, max) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new PingTaskError(`invalid${name}`);
  }
  return value;
}

function isValidIPv4(host) {
  const parts = host.split('.');
  return parts.length === 4 && parts.every(part => {
    if (!/^\d{1,3}$/.test(part)) return false;
    const value = Number(part);
    return value >= 0 && value <= 255;
  });
}

function normalizeHost(raw, { allowIPv6 = true } = {}) {
  const host = String(raw || '').trim().toLowerCase();
  if (!host || host.length > 253 || /[\s/@?#\\]/.test(host)) return null;
  if (isValidIPv4(host)) return host;
  if (allowIPv6 && host.includes(':') && /^[0-9a-f:.]+$/i.test(host)) {
    try {
      return new URL(`http://[${host}]/`).hostname.replace(/^\[|\]$/g, '');
    } catch (_) {
      return null;
    }
  }
  if (host.startsWith('.') || host.endsWith('.') || host.includes('..')) return null;
  return host.split('.').every(label => HOSTNAME_LABEL_PATTERN.test(label)) ? host : null;
}

function normalizeTarget(type, value) {
  const raw = String(value || '').trim();
  if (!raw || raw.length > 255 || CONTROL_CHARACTER_PATTERN.test(raw)) {
    throw new PingTaskError('invalidPingTaskTarget');
  }

  if (type === 'icmp') {
    const unwrapped = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw;
    const host = normalizeHost(unwrapped);
    if (!host) throw new PingTaskError('invalidPingTaskTarget');
    return host;
  }

  if (type === 'tcp') {
    let parsed;
    try {
      parsed = new URL(`tcp://${raw}`);
    } catch (_) {
      throw new PingTaskError('invalidPingTaskTarget');
    }
    if (parsed.username || parsed.password || parsed.pathname !== '' || parsed.search || parsed.hash) {
      throw new PingTaskError('invalidPingTaskTarget');
    }
    const host = normalizeHost(parsed.hostname.replace(/^\[|\]$/g, ''));
    const port = Number(parsed.port);
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new PingTaskError('invalidPingTaskTarget');
    }
    return host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch (_) {
    throw new PingTaskError('invalidPingTaskTarget');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) {
    throw new PingTaskError('invalidPingTaskTarget');
  }
  parsed.hash = '';
  const normalized = parsed.toString();
  if (normalized.length > 255) throw new PingTaskError('invalidPingTaskTarget');
  return normalized;
}

function normalizeServerIds(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) {
    throw new PingTaskError('invalidPingTaskServers');
  }
  const serverIds = [...new Set(value.map(item => String(item || '').trim()))].sort();
  if (serverIds.some(id => !UUID_PATTERN.test(id))) {
    throw new PingTaskError('invalidPingTaskServers');
  }
  return serverIds;
}

export function normalizePingTaskInput(input = {}) {
  const name = String(input.name || '').trim();
  if (!name || [...name].length > 100 || CONTROL_CHARACTER_PATTERN.test(name)) {
    throw new PingTaskError('invalidPingTaskName');
  }

  const type = String(input.type || '').trim().toLowerCase();
  if (!PING_TASK_TYPES.has(type)) throw new PingTaskError('invalidPingTaskType');

  return {
    name,
    type,
    target: normalizeTarget(type, input.target),
    interval_seconds: integerValue(
      input.interval_seconds,
      'PingTaskInterval',
      MIN_PING_TASK_INTERVAL_SECONDS,
      MAX_PING_TASK_INTERVAL_SECONDS
    ),
    timeout_ms: integerValue(
      input.timeout_ms,
      'PingTaskTimeout',
      MIN_PING_TASK_TIMEOUT_MS,
      MAX_PING_TASK_TIMEOUT_MS
    ),
    enabled: booleanValue(input.enabled, true),
    apply_to_new_servers: booleanValue(input.apply_to_new_servers, false),
    server_ids: normalizeServerIds(input.server_ids)
  };
}

function placeholders(count) {
  return Array.from({ length: count }, () => '?').join(', ');
}

async function assertServersExist(db, serverIds) {
  if (serverIds.length === 0) return;
  const row = await db.prepare(`
    SELECT COUNT(*) AS count
    FROM servers
    WHERE id IN (${placeholders(serverIds.length)})
  `).bind(...serverIds).first();
  if (Number(row?.count) !== serverIds.length) {
    throw new PingTaskError('pingTaskServerNotFound', 404);
  }
}

async function assertServerTaskCapacity(db, serverIds, excludeTaskId = null) {
  if (serverIds.length === 0) return;
  const rows = await db.prepare(`
    SELECT pts.server_id, COUNT(*) AS count
    FROM ping_task_servers pts
    JOIN ping_tasks pt ON pt.id = pts.task_id
    WHERE pt.enabled = 1
      AND pts.server_id IN (${placeholders(serverIds.length)})
      AND (? IS NULL OR pt.id != ?)
    GROUP BY pts.server_id
  `).bind(...serverIds, excludeTaskId, excludeTaskId).all();
  if ((rows.results || []).some(row => Number(row.count) >= MAX_PING_TASKS_PER_SERVER)) {
    throw new PingTaskError('pingTaskServerLimitExceeded', 409);
  }
}

async function assertDefaultPingTaskCapacity(db, task, excludeTaskId = null) {
  if (!task.enabled || !task.apply_to_new_servers) return;
  const row = await db.prepare(`
    SELECT COUNT(*) AS count
    FROM ping_tasks
    WHERE enabled = 1
      AND apply_to_new_servers = 1
      AND (? IS NULL OR id != ?)
  `).bind(excludeTaskId, excludeTaskId).first();
  if (Number(row?.count) >= MAX_PING_TASKS_PER_SERVER) {
    throw new PingTaskError('pingTaskServerLimitExceeded', 409);
  }
}

function taskFromRow(row, serverIds = []) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    target: row.target,
    interval_seconds: Number(row.interval_seconds),
    timeout_ms: Number(row.timeout_ms),
    enabled: Number(row.enabled) === 1,
    sort_order: Number(row.sort_order),
    apply_to_new_servers: Number(row.apply_to_new_servers) === 1,
    server_ids: [...serverIds].sort(),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at)
  };
}

export async function listPingTasks(db) {
  const [taskRows, assignmentRows] = await Promise.all([
    db.prepare(`
      SELECT id, name, type, target, interval_seconds, timeout_ms, enabled,
             sort_order, apply_to_new_servers, created_at, updated_at
      FROM ping_tasks
      ORDER BY sort_order ASC, created_at ASC, id ASC
    `).all(),
    db.prepare(`
      SELECT task_id, server_id
      FROM ping_task_servers
      ORDER BY server_id ASC
    `).all()
  ]);
  const assignments = new Map();
  for (const row of assignmentRows.results || []) {
    if (!assignments.has(row.task_id)) assignments.set(row.task_id, []);
    assignments.get(row.task_id).push(row.server_id);
  }
  return (taskRows.results || []).map(row => taskFromRow(row, assignments.get(row.id) || []));
}

async function getPingTask(db, id) {
  const tasks = await listPingTasks(db);
  return tasks.find(task => task.id === id) || null;
}

function assignmentStatements(db, taskId, serverIds) {
  return serverIds.map(serverId => db.prepare(`
    INSERT INTO ping_task_servers (task_id, server_id)
    VALUES (?, ?)
  `).bind(taskId, serverId));
}

function translatePingTaskDatabaseError(error) {
  const message = String(error?.message || error || '');
  if (message.includes('ping_task_server_limit_exceeded')) {
    return new PingTaskError('pingTaskServerLimitExceeded', 409);
  }
  if (message.includes('ping_task_limit_exceeded')) {
    return new PingTaskError('pingTaskLimitExceeded', 409);
  }
  return error;
}

async function runPingTaskBatch(db, statements) {
  try {
    return await db.batch(statements);
  } catch (error) {
    throw translatePingTaskDatabaseError(error);
  }
}

export async function createPingTask(db, input) {
  const task = normalizePingTaskInput(input);
  await assertServersExist(db, task.server_ids);
  if (task.enabled) await assertServerTaskCapacity(db, task.server_ids);
  await assertDefaultPingTaskCapacity(db, task);

  const count = await db.prepare('SELECT COUNT(*) AS count FROM ping_tasks').first();
  if (Number(count?.count) >= MAX_PING_TASKS) {
    throw new PingTaskError('pingTaskLimitExceeded', 409);
  }
  const order = await db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS max_order FROM ping_tasks').first();
  const id = crypto.randomUUID();
  const now = Date.now();
  await runPingTaskBatch(db, [
    db.prepare(`
      INSERT INTO ping_tasks (
        id, name, type, target, interval_seconds, timeout_ms, enabled,
        sort_order, apply_to_new_servers, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      task.name,
      task.type,
      task.target,
      task.interval_seconds,
      task.timeout_ms,
      task.enabled ? 1 : 0,
      Number(order?.max_order ?? -1) + 1,
      task.apply_to_new_servers ? 1 : 0,
      now,
      now
    ),
    ...assignmentStatements(db, id, task.server_ids)
  ]);

  return {
    task: await getPingTask(db, id),
    affected_server_ids: task.server_ids
  };
}

function normalizeTaskId(value) {
  const id = String(value || '').trim();
  if (!UUID_PATTERN.test(id)) throw new PingTaskError('invalidPingTaskId');
  return id;
}

export async function updatePingTask(db, input) {
  const id = normalizeTaskId(input.id);
  const existing = await getPingTask(db, id);
  if (!existing) throw new PingTaskError('pingTaskNotFound', 404);

  const task = normalizePingTaskInput({ ...existing, ...input });
  await assertServersExist(db, task.server_ids);
  if (task.enabled) await assertServerTaskCapacity(db, task.server_ids, id);
  await assertDefaultPingTaskCapacity(db, task, id);
  const now = Date.now();
  await runPingTaskBatch(db, [
    db.prepare(`
      UPDATE ping_tasks
      SET name = ?, type = ?, target = ?, interval_seconds = ?, timeout_ms = ?,
          enabled = ?, apply_to_new_servers = ?, updated_at = ?
      WHERE id = ?
    `).bind(
      task.name,
      task.type,
      task.target,
      task.interval_seconds,
      task.timeout_ms,
      task.enabled ? 1 : 0,
      task.apply_to_new_servers ? 1 : 0,
      now,
      id
    ),
    db.prepare('DELETE FROM ping_task_servers WHERE task_id = ?').bind(id),
    ...assignmentStatements(db, id, task.server_ids)
  ]);

  return {
    task: await getPingTask(db, id),
    affected_server_ids: [...new Set([...existing.server_ids, ...task.server_ids])].sort()
  };
}

export async function deletePingTask(db, rawId) {
  const id = normalizeTaskId(rawId);
  const existing = await getPingTask(db, id);
  if (!existing) throw new PingTaskError('pingTaskNotFound', 404);
  await db.prepare('DELETE FROM ping_tasks WHERE id = ?').bind(id).run();
  return { id, affected_server_ids: existing.server_ids };
}

export async function reorderPingTasks(db, rawIds) {
  if (!Array.isArray(rawIds) || rawIds.length === 0 || rawIds.length > MAX_PING_TASKS) {
    throw new PingTaskError('invalidPingTaskOrder');
  }
  const ids = rawIds.map(normalizeTaskId);
  if (new Set(ids).size !== ids.length) throw new PingTaskError('invalidPingTaskOrder');
  const row = await db.prepare(`
    SELECT COUNT(*) AS count FROM ping_tasks WHERE id IN (${placeholders(ids.length)})
  `).bind(...ids).first();
  const total = await db.prepare('SELECT COUNT(*) AS count FROM ping_tasks').first();
  if (Number(row?.count) !== ids.length || Number(total?.count) !== ids.length) {
    throw new PingTaskError('invalidPingTaskOrder');
  }
  const now = Date.now();
  await db.batch(ids.map((id, index) => db.prepare(`
    UPDATE ping_tasks SET sort_order = ?, updated_at = ? WHERE id = ?
  `).bind(index, now, id)));
  return listPingTasks(db);
}

export function defaultPingTaskAssignmentStatement(db, serverId) {
  const id = normalizeTaskId(serverId);
  return db.prepare(`
    INSERT OR IGNORE INTO ping_task_servers (task_id, server_id)
    SELECT id, ?
    FROM ping_tasks
    WHERE apply_to_new_servers = 1
    ORDER BY sort_order ASC, id ASC
  `).bind(id);
}

export async function assignDefaultPingTasksToServer(db, serverId) {
  await defaultPingTaskAssignmentStatement(db, serverId).run();
}

export async function listAgentPingTasks(db, serverId) {
  const result = await db.prepare(`
    SELECT pt.id, pt.name, pt.type, pt.target, pt.interval_seconds, pt.timeout_ms
    FROM ping_tasks pt
    JOIN ping_task_servers pts ON pts.task_id = pt.id
    WHERE pts.server_id = ? AND pt.enabled = 1
    ORDER BY pt.sort_order ASC, pt.created_at ASC, pt.id ASC
    LIMIT ?
  `).bind(serverId, MAX_PING_TASKS_PER_SERVER).all();
  return (result.results || []).map(row => ({
    id: row.id,
    name: row.name,
    type: row.type,
    target: row.target,
    interval_seconds: Number(row.interval_seconds),
    timeout_ms: Number(row.timeout_ms)
  }));
}

export async function listVisiblePingTasks(db, includeHiddenServers = false) {
  const result = await db.prepare(`
    SELECT
      pt.id,
      pt.name,
      pt.type,
      pt.interval_seconds,
      pt.timeout_ms,
      pt.sort_order,
      pts.server_id
    FROM ping_tasks pt
    JOIN ping_task_servers pts ON pts.task_id = pt.id
    JOIN servers s ON s.id = pts.server_id
    WHERE pt.enabled = 1
      AND (? = 1 OR COALESCE(s.is_hidden, '0') != '1')
    ORDER BY pt.sort_order ASC, pt.created_at ASC, pt.id ASC, pts.server_id ASC
  `).bind(includeHiddenServers ? 1 : 0).all();
  const tasks = new Map();
  for (const row of result.results || []) {
    if (!tasks.has(row.id)) {
      tasks.set(row.id, {
        id: row.id,
        name: row.name,
        type: row.type,
        interval_seconds: Number(row.interval_seconds),
        timeout_ms: Number(row.timeout_ms),
        sort_order: Number(row.sort_order),
        server_ids: []
      });
    }
    tasks.get(row.id).server_ids.push(row.server_id);
  }
  return [...tasks.values()];
}

export async function getVisiblePingTaskForServer(db, taskId, serverId, includeHiddenServer = false) {
  const normalizedTaskId = normalizeTaskId(taskId);
  const normalizedServerId = normalizeTaskId(serverId);
  const row = await db.prepare(`
    SELECT pt.id, pt.name, pt.type, pt.interval_seconds, pt.timeout_ms
    FROM ping_tasks pt
    JOIN ping_task_servers pts ON pts.task_id = pt.id
    JOIN servers s ON s.id = pts.server_id
    WHERE pt.id = ?
      AND pts.server_id = ?
      AND pt.enabled = 1
      AND (? = 1 OR COALESCE(s.is_hidden, '0') != '1')
    LIMIT 1
  `).bind(normalizedTaskId, normalizedServerId, includeHiddenServer ? 1 : 0).first();
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    interval_seconds: Number(row.interval_seconds),
    timeout_ms: Number(row.timeout_ms)
  };
}

function normalizePingResult(result, now) {
  const taskId = String(result?.task_id || '').trim();
  const timestamp = Number(result?.timestamp);
  const success = result?.success === true;
  const latency = result?.latency_ms;
  if (!UUID_PATTERN.test(taskId) || !Number.isInteger(timestamp)) return null;
  if (timestamp < now - PING_RESULT_RETENTION_MS || timestamp > now + 5 * 60 * 1000) return null;
  if (success && (!Number.isInteger(latency) || latency < 0 || latency > MAX_PING_TASK_TIMEOUT_MS)) return null;
  if (!success && latency !== null && latency !== -1 && latency !== undefined) return null;
  return {
    task_id: taskId,
    timestamp,
    latency_ms: success ? latency : null,
    success: success ? 1 : 0
  };
}

export async function savePingTaskResults(
  db,
  serverId,
  rawResults,
  now = Date.now(),
  rawBatchId = undefined
) {
  const batchId = rawBatchId === undefined || rawBatchId === null
    ? null
    : String(rawBatchId).trim();
  if (batchId !== null && !PING_RESULT_BATCH_ID_PATTERN.test(batchId)) {
    throw new PingTaskError('invalidPingTaskResults');
  }
  if (rawResults === undefined) {
    if (batchId !== null) throw new PingTaskError('invalidPingTaskResults');
    return { accepted: 0, rejected: 0 };
  }
  if (!Array.isArray(rawResults) || rawResults.length > MAX_PING_RESULTS_PER_REPORT) {
    throw new PingTaskError('invalidPingTaskResults');
  }
  const normalized = rawResults.map(result => normalizePingResult(result, now));
  if (normalized.some(result => result === null)) {
    throw new PingTaskError('invalidPingTaskResults');
  }
  if (normalized.length === 0) {
    return batchId === null
      ? { accepted: 0, rejected: 0 }
      : { accepted: 0, rejected: 0, batch_id: batchId, received: 0 };
  }

  const writes = await db.batch(normalized.map(result => db.prepare(`
    INSERT OR IGNORE INTO ping_task_results (
      task_id, server_id, timestamp, latency_ms, success
    )
    SELECT ?, ?, ?, ?, ?
    WHERE EXISTS (
      SELECT 1
      FROM ping_tasks pt
      JOIN ping_task_servers pts ON pts.task_id = pt.id
      WHERE pt.id = ? AND pts.server_id = ? AND pt.enabled = 1
    )
  `).bind(
    result.task_id,
    serverId,
    result.timestamp,
    result.latency_ms,
    result.success,
    result.task_id,
    serverId
  )));
  const accepted = writes.reduce((sum, write) => sum + Number(write?.meta?.changes || 0), 0);
  const result = { accepted, rejected: normalized.length - accepted };
  if (batchId !== null) {
    result.batch_id = batchId;
    result.received = normalized.length;
  }
  return result;
}

function normalizePingTaskHistoryHours(hours) {
  const normalizedHours = Number(hours);
  if (![1, 6, 12, 24, 48, 96, 168].includes(normalizedHours)) {
    throw new PingTaskError('invalidPingTaskHistoryHours');
  }
  return normalizedHours;
}

export async function listPingTaskHistory(db, { taskId, serverId, hours = 24 } = {}) {
  const normalizedTaskId = normalizeTaskId(taskId);
  const normalizedServerId = normalizeTaskId(serverId);
  const normalizedHours = normalizePingTaskHistoryHours(hours);
  const result = await db.prepare(`
    SELECT timestamp, latency_ms, success
    FROM (
      SELECT timestamp, latency_ms, success
      FROM ping_task_results
      WHERE task_id = ? AND server_id = ? AND timestamp >= ?
      ORDER BY timestamp DESC
      LIMIT ?
    )
    ORDER BY timestamp ASC
  `).bind(
    normalizedTaskId,
    normalizedServerId,
    Date.now() - normalizedHours * 60 * 60 * 1000,
    MAX_PING_HISTORY_RESULTS_PER_TASK
  ).all();
  return (result.results || []).map(row => ({
    timestamp: Number(row.timestamp),
    latency_ms: row.latency_ms === null ? null : Number(row.latency_ms),
    success: Number(row.success) === 1
  }));
}

export async function listPingTaskHistoryForServer(
  db,
  { serverId, hours = 24, includeHiddenServer = false } = {}
) {
  const normalizedServerId = normalizeTaskId(serverId);
  const normalizedHours = normalizePingTaskHistoryHours(hours);
  const taskResult = await db.prepare(`
    SELECT
      pt.id,
      pt.name,
      pt.type,
      pt.interval_seconds,
      pt.timeout_ms
    FROM ping_tasks pt
    JOIN ping_task_servers pts ON pts.task_id = pt.id
    JOIN servers s ON s.id = pts.server_id
    WHERE pts.server_id = ?
      AND pt.enabled = 1
      AND (? = 1 OR COALESCE(s.is_hidden, '0') != '1')
    ORDER BY pt.sort_order ASC, pt.created_at ASC, pt.id ASC
  `).bind(
    normalizedServerId,
    includeHiddenServer ? 1 : 0
  ).all();

  const tasks = taskResult.results || [];
  if (tasks.length === 0) return [];
  const since = Date.now() - normalizedHours * 60 * 60 * 1000;
  const historyResults = await db.batch(tasks.map(task => db.prepare(`
    SELECT timestamp, latency_ms, success
    FROM (
      SELECT timestamp, latency_ms, success
      FROM ping_task_results
      WHERE task_id = ? AND server_id = ? AND timestamp >= ?
      ORDER BY timestamp DESC
      LIMIT ?
    )
    ORDER BY timestamp ASC
  `).bind(task.id, normalizedServerId, since, MAX_PING_HISTORY_RESULTS_PER_TASK)));

  return tasks.map((task, index) => ({
    task: {
      id: task.id,
      name: task.name,
      type: task.type,
      interval_seconds: Number(task.interval_seconds),
      timeout_ms: Number(task.timeout_ms)
    },
    results: (historyResults[index]?.results || []).map(row => ({
      timestamp: Number(row.timestamp),
      latency_ms: row.latency_ms === null ? null : Number(row.latency_ms),
      success: Number(row.success) === 1
    }))
  }));
}

export async function cleanupPingTaskResults(db, now = Date.now()) {
  const result = await db.prepare('DELETE FROM ping_task_results WHERE timestamp < ?')
    .bind(now - PING_RESULT_RETENTION_MS)
    .run();
  return Number(result?.meta?.changes || 0);
}
