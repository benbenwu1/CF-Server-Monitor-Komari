import { getCurrentVersion } from '../utils/settings.js';

export const LOGICAL_BACKUP_FORMAT = 'cfsm-logical-backup';
export const LOGICAL_BACKUP_FORMAT_VERSION = 1;
export const LOGICAL_BACKUP_MAX_BYTES = 1024 * 1024;
export const LOGICAL_BACKUP_MAX_SERVERS = 5000;
export const LOGICAL_BACKUP_MAX_ASSIGNMENTS = 50000;
export const LOGICAL_BACKUP_R2_PREFIX = 'cfsm-logical-backups';

const SAFE_SITE_FIELDS = Object.freeze([
  'is_public',
  'show_price',
  'show_expire',
  'show_tf',
  'show_time',
  'wss_report_enabled',
  'long_history_points',
  'tg_notify',
  'notification_provider',
  'turnstile_enabled',
  'turnstile_login_enabled',
  'turnstile_site_key',
  'custom_ct',
  'custom_cu',
  'custom_cm',
  'custom_bd',
  'expire_reminder',
  'resource_alert_rules',
  'theme_url',
  'history_id_optimized',
  'servers_optimized'
]);

const SAFE_APPEARANCE_FIELDS = Object.freeze([
  'site_title',
  'custom_bg',
  'favicon',
  'custom_head',
  'custom_script',
  'csp_static',
  'csp_api',
  'display_mode',
  'theme_options'
]);

const SERVER_COLUMNS = Object.freeze([
  'id',
  'name',
  'server_group',
  'region',
  'tags',
  'note',
  'internal_note',
  'public_note',
  'price',
  'billing_cycle',
  'auto_renewal',
  'currency',
  'expire_date',
  'traffic_limit',
  'traffic_calc_type',
  'interface',
  'reset_day',
  'collect_interval',
  'report_interval',
  'connection_mode',
  'auto_update',
  'custom_ct',
  'custom_cu',
  'custom_cm',
  'custom_bd',
  'rx_correction',
  'tx_correction',
  'offline_notify_disabled',
  'is_hidden',
  'sort_order',
  'history_partition_id',
  'timestamp'
]);

const OMITTED_CREDENTIAL_FIELDS = Object.freeze([
  'settings.username',
  'settings.password',
  'settings.jwt_secret',
  'settings.turnstile_secret_key',
  'settings.cloudflare_account_id',
  'settings.cloudflare_token',
  'settings.tg_bot_token',
  'settings.tg_chat_id',
  'settings.admin_totp_secret',
  'settings.admin_totp_recovery_codes',
  'settings.admin_totp_pending',
  'environment.API_SECRET',
  'environment.TOTP_ENCRYPTION_KEY',
  'environment.GITHUB_OAUTH_CLIENT_SECRET',
  'other environment bindings and secrets'
]);

const EXCLUDED_DATASETS = Object.freeze([
  'metrics_history',
  'metrics_history_old',
  'ping_task_results',
  'audit_events',
  'notification_deliveries',
  'admin_sessions',
  'admin_second_factor_attempts',
  'admin_oauth_states',
  'admin_oauth_identities',
  'admin_oauth_exchange_codes',
  'admin_oauth_start_limits',
  'runtime alert state'
]);

export class LogicalBackupError extends Error {
  constructor(code) {
    super(code);
    this.name = 'LogicalBackupError';
    this.code = code;
  }
}

function parseObject(value) {
  if (!value || typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function pickFields(source, fields) {
  const result = {};
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(source, field)) {
      result[field] = source[field];
    }
  }
  return result;
}

function sanitizeSettings(rows = []) {
  const byKey = new Map(rows.map(row => [String(row.key || ''), row.value]));
  const siteOptions = pickFields(parseObject(byKey.get('site_options')), SAFE_SITE_FIELDS);
  const appearanceOptions = pickFields(
    parseObject(byKey.get('appearance_options')),
    SAFE_APPEARANCE_FIELDS
  );

  for (const field of SAFE_SITE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(siteOptions, field) && byKey.has(field)) {
      siteOptions[field] = byKey.get(field);
    }
  }
  for (const field of SAFE_APPEARANCE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(appearanceOptions, field) && byKey.has(field)) {
      appearanceOptions[field] = byKey.get(field);
    }
  }

  return { siteOptions, appearanceOptions };
}

function rowsFromBatchResult(result) {
  return Array.isArray(result?.results) ? result.results : [];
}

function toCount(value) {
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

function bytesToHex(bytes) {
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(value) {
  const encoded = new TextEncoder().encode(value);
  return bytesToHex(await crypto.subtle.digest('SHA-256', encoded));
}

function compactUtcTimestamp(isoTimestamp) {
  return isoTimestamp.replace(/[-:.]/g, '');
}

function buildSettingsQuery() {
  const keys = ['site_options', 'appearance_options', ...SAFE_SITE_FIELDS, ...SAFE_APPEARANCE_FIELDS];
  const placeholders = keys.map(() => '?').join(', ');
  return { keys, sql: `SELECT key, value FROM settings WHERE key IN (${placeholders}) ORDER BY key ASC` };
}

export function isR2BackupAvailable(env) {
  return !!env?.BACKUP_BUCKET && typeof env.BACKUP_BUCKET.put === 'function';
}

export async function createLogicalBackup(db, options = {}) {
  const maxBytes = Number.isSafeInteger(options.maxBytes) && options.maxBytes > 0
    ? options.maxBytes
    : LOGICAL_BACKUP_MAX_BYTES;
  const generatedAt = new Date(options.now ?? Date.now()).toISOString();

  const [serverCountResult, assignmentCountResult] = await db.batch([
    db.prepare('SELECT COUNT(*) AS count FROM servers'),
    db.prepare('SELECT COUNT(*) AS count FROM ping_task_servers')
  ]);
  const serverCount = toCount(rowsFromBatchResult(serverCountResult)[0]?.count);
  const assignmentCount = toCount(rowsFromBatchResult(assignmentCountResult)[0]?.count);

  if (serverCount > LOGICAL_BACKUP_MAX_SERVERS) {
    throw new LogicalBackupError('logicalBackupServerLimitExceeded');
  }
  if (assignmentCount > LOGICAL_BACKUP_MAX_ASSIGNMENTS) {
    throw new LogicalBackupError('logicalBackupAssignmentLimitExceeded');
  }

  const settingsQuery = buildSettingsQuery();
  const [settingsResult, serversResult, tasksResult, assignmentsResult] = await db.batch([
    db.prepare(settingsQuery.sql).bind(...settingsQuery.keys),
    db.prepare(`
      SELECT ${SERVER_COLUMNS.map(column => column === 'interface' ? '"interface"' : column).join(', ')}
      FROM servers
      ORDER BY sort_order ASC, id ASC
    `),
    db.prepare(`
      SELECT id, name, type, target, interval_seconds, timeout_ms, enabled,
             sort_order, apply_to_new_servers, created_at, updated_at
      FROM ping_tasks
      ORDER BY sort_order ASC, id ASC
    `),
    db.prepare(`
      SELECT task_id, server_id
      FROM ping_task_servers
      ORDER BY task_id ASC, server_id ASC
    `)
  ]);

  const { siteOptions, appearanceOptions } = sanitizeSettings(rowsFromBatchResult(settingsResult));
  const servers = rowsFromBatchResult(serversResult);
  const pingTasks = rowsFromBatchResult(tasksResult);
  const pingTaskAssignments = rowsFromBatchResult(assignmentsResult);

  if (servers.length > LOGICAL_BACKUP_MAX_SERVERS) {
    throw new LogicalBackupError('logicalBackupServerLimitExceeded');
  }
  if (pingTaskAssignments.length > LOGICAL_BACKUP_MAX_ASSIGNMENTS) {
    throw new LogicalBackupError('logicalBackupAssignmentLimitExceeded');
  }

  const data = {
    site_options: siteOptions,
    appearance_options: appearanceOptions,
    servers,
    ping_tasks: pingTasks,
    ping_task_assignments: pingTaskAssignments
  };
  const dataJson = JSON.stringify(data);
  const dataChecksum = await sha256Hex(dataJson);
  const backup = {
    format: LOGICAL_BACKUP_FORMAT,
    format_version: LOGICAL_BACKUP_FORMAT_VERSION,
    manifest: {
      generated_at: generatedAt,
      application_version: getCurrentVersion(),
      database_schema: 'cfsm-config-v1',
      scope: 'configuration-only',
      restorable_by_application: false,
      record_counts: {
        site_option_fields: Object.keys(siteOptions).length,
        appearance_option_fields: Object.keys(appearanceOptions).length,
        servers: servers.length,
        ping_tasks: pingTasks.length,
        ping_task_assignments: pingTaskAssignments.length
      },
      checksum: {
        algorithm: 'SHA-256',
        canonicalization: 'UTF-8 JSON.stringify(data)',
        value: dataChecksum
      },
      omitted_credential_fields: [...OMITTED_CREDENTIAL_FIELDS],
      excluded_datasets: [...EXCLUDED_DATASETS],
      warnings: [
        'This file can contain private server notes, identifiers, and probe targets.',
        'This format is not accepted by an automatic restore endpoint.'
      ]
    },
    data
  };
  const serialized = JSON.stringify(backup, null, 2);
  const sizeBytes = new TextEncoder().encode(serialized).byteLength;
  if (sizeBytes > maxBytes) {
    throw new LogicalBackupError('logicalBackupTooLarge');
  }

  return {
    backup,
    serialized,
    sizeBytes,
    checksum: dataChecksum
  };
}

export async function storeLogicalBackupInR2(bucket, artifact) {
  if (!bucket || typeof bucket.put !== 'function') {
    throw new LogicalBackupError('logicalBackupR2Unavailable');
  }

  const generatedAt = artifact?.backup?.manifest?.generated_at;
  const checksum = artifact?.checksum;
  if (!generatedAt || !/^[a-f0-9]{64}$/.test(String(checksum || ''))) {
    throw new LogicalBackupError('logicalBackupInvalidArtifact');
  }

  const filename = `cfsm-config-${compactUtcTimestamp(generatedAt)}-${checksum.slice(0, 12)}.json`;
  const uniqueFilename = filename.replace('.json', `-${crypto.randomUUID().slice(0, 8)}.json`);
  const datePrefix = generatedAt.slice(0, 10).replace(/-/g, '/');
  const key = `${LOGICAL_BACKUP_R2_PREFIX}/${datePrefix}/${uniqueFilename}`;
  const stored = await bucket.put(key, artifact.serialized, {
    httpMetadata: {
      contentType: 'application/json; charset=utf-8',
      contentDisposition: `attachment; filename="${uniqueFilename}"`,
      cacheControl: 'no-store'
    },
    customMetadata: {
      format: LOGICAL_BACKUP_FORMAT,
      format_version: String(LOGICAL_BACKUP_FORMAT_VERSION),
      application_version: String(artifact.backup.manifest.application_version),
      data_sha256: checksum
    }
  });

  if (!stored) {
    throw new LogicalBackupError('logicalBackupR2Failed');
  }

  return {
    key,
    filename: uniqueFilename,
    size: Number(stored.size) || artifact.sizeBytes,
    etag: stored.etag || '',
    uploaded_at: stored.uploaded instanceof Date
      ? stored.uploaded.toISOString()
      : generatedAt,
    checksum_sha256: checksum
  };
}
