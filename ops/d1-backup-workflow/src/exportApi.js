const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';
const MAX_API_RESPONSE_BYTES = 64 * 1024;
const ACCOUNT_ID_PATTERN = /^[a-f0-9]{32}$/;
const DATABASE_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const BACKUP_PREFIX_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9/_-]{0,127}$/;

class BackupConfigurationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BackupConfigurationError';
    this.code = code;
    this.retryable = false;
  }
}

function configurationError(code, field) {
  return new BackupConfigurationError(code, `Invalid or missing ${field} configuration`);
}

function operationError(code, message, retryable) {
  const error = new Error(message);
  error.name = 'BackupOperationError';
  error.code = code;
  error.retryable = retryable;
  return error;
}

async function readBoundedApiResponse(response) {
  if (!response.body) return '';

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      bytes += chunk.byteLength;
      if (bytes > MAX_API_RESPONSE_BYTES) {
        try {
          await reader.cancel();
        } catch {}
        throw operationError(
          'HTTP_RESPONSE_TOO_LARGE',
          'D1 export API response exceeded the size limit',
          false
        );
      }
      text += decoder.decode(chunk, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    if (error?.code === 'HTTP_RESPONSE_TOO_LARGE') throw error;
    try {
      await reader.cancel();
    } catch {}
    throw operationError('HTTP_RESPONSE_READ_FAILED', 'D1 export API response could not be read', true);
  } finally {
    reader.releaseLock();
  }
}

export function buildD1ExportUrl(accountId, databaseId) {
  return `${CLOUDFLARE_API_BASE}/accounts/${accountId}/d1/database/${databaseId}/export`;
}

export function classifyHttpFailure(status) {
  if (status === 401) return { code: 'HTTP_AUTHENTICATION_FAILED', retryable: false };
  if (status === 403) return { code: 'HTTP_PERMISSION_DENIED', retryable: false };
  if (status === 429) return { code: 'HTTP_RATE_LIMITED', retryable: true };
  if (status >= 500) return { code: 'HTTP_UPSTREAM_UNAVAILABLE', retryable: true };
  return { code: 'HTTP_REQUEST_REJECTED', retryable: false };
}

export async function requestD1Export({ url, token, body, fetchImpl = fetch }) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify(body)
    });
  } catch {
    throw operationError('HTTP_NETWORK_ERROR', 'D1 export API request failed', true);
  }

  if (!response.ok) {
    const failure = classifyHttpFailure(response.status);
    throw operationError(failure.code, `D1 export API returned HTTP ${response.status}`, failure.retryable);
  }

  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_API_RESPONSE_BYTES) {
    try {
      await response.body?.cancel();
    } catch {}
    throw operationError('HTTP_RESPONSE_TOO_LARGE', 'D1 export API response exceeded the size limit', false);
  }

  const text = await readBoundedApiResponse(response);

  try {
    return JSON.parse(text);
  } catch {
    throw operationError('HTTP_RESPONSE_INVALID', 'D1 export API returned invalid JSON', true);
  }
}

export function buildBackupObjectKeys({ prefix, triggeredAt, instanceId }) {
  const date = new Date(triggeredAt);
  if (!Number.isFinite(date.getTime())) {
    throw operationError('TRIGGER_TIME_INVALID', 'Workflow trigger time is invalid', false);
  }
  const normalizedInstanceId = String(instanceId || '').trim();
  if (!normalizedInstanceId || normalizedInstanceId.length > 100) {
    throw operationError('INSTANCE_ID_INVALID', 'Workflow instance ID is invalid', false);
  }

  const year = String(date.getUTCFullYear()).padStart(4, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const baseKey = `${prefix}/${year}/${month}/${day}/${encodeURIComponent(normalizedInstanceId)}`;
  return {
    sqlKey: `${baseKey}.sql`,
    manifestKey: `${baseKey}.manifest.json`
  };
}

export function createBackupManifest({
  databaseLabel,
  workflowName,
  instanceId,
  triggeredAt,
  schedule,
  bookmark,
  sourceFilename,
  sqlKey,
  uploadedAt,
  size,
  etag,
  md5
}) {
  const workflow = {
    name: workflowName,
    instance_id: instanceId,
    triggered_at: new Date(triggeredAt).toISOString(),
    trigger: schedule ? 'schedule' : 'manual'
  };
  if (schedule) {
    workflow.cron = schedule.cron;
    workflow.scheduled_time = new Date(schedule.scheduledTime).toISOString();
  }

  return {
    format: 'cfsm-d1-full-backup',
    format_version: 1,
    generated_at: new Date(uploadedAt).toISOString(),
    database_ref: databaseLabel,
    workflow,
    export: {
      bookmark,
      source_filename: sourceFilename
    },
    object: {
      sql_key: sqlKey,
      size_bytes: size,
      etag,
      checksums: { md5 }
    },
    restore: {
      automatic: false,
      requires_maintenance_window: true
    }
  };
}

export function validateBackupConfig(env) {
  const accountId = String(env?.ACCOUNT_ID || '').trim().toLowerCase();
  const databaseId = String(env?.DATABASE_ID || '').trim().toLowerCase();
  const databaseLabel = String(env?.DATABASE_LABEL || '').trim();
  const prefix = String(env?.BACKUP_PREFIX || 'cfsm-d1-full-backups')
    .trim()
    .replace(/^\/+|\/+$/g, '');

  if (!ACCOUNT_ID_PATTERN.test(accountId)) {
    throw configurationError('CONFIG_ACCOUNT_ID', 'ACCOUNT_ID');
  }
  if (!DATABASE_ID_PATTERN.test(databaseId)) {
    throw configurationError('CONFIG_DATABASE_ID', 'DATABASE_ID');
  }
  if (!databaseLabel || databaseLabel.length > 80 || /[\u0000-\u001f\u007f]/.test(databaseLabel)) {
    throw configurationError('CONFIG_DATABASE_LABEL', 'DATABASE_LABEL');
  }
  if (!BACKUP_PREFIX_PATTERN.test(prefix) || prefix.includes('..') || prefix.includes('//')) {
    throw configurationError('CONFIG_BACKUP_PREFIX', 'BACKUP_PREFIX');
  }
  if (!String(env?.D1_REST_API_TOKEN || '').trim()) {
    throw configurationError('CONFIG_API_TOKEN', 'D1_REST_API_TOKEN');
  }
  if (
    !env?.BACKUP_BUCKET
    || typeof env.BACKUP_BUCKET.head !== 'function'
    || typeof env.BACKUP_BUCKET.put !== 'function'
  ) {
    throw configurationError('CONFIG_R2_BINDING', 'BACKUP_BUCKET');
  }

  return { accountId, databaseId, databaseLabel, prefix };
}

export function parseStartExportResponse(payload) {
  if (payload?.success === false) {
    throw operationError('EXPORT_API_REJECTED', 'D1 export API rejected the request', false);
  }
  const bookmark = payload?.result?.at_bookmark;
  if (typeof bookmark !== 'string' || !bookmark) {
    throw operationError(
      'EXPORT_BOOKMARK_MISSING',
      'D1 export response did not include a polling bookmark',
      true
    );
  }
  return { bookmark };
}

export function parsePollExportResponse(payload) {
  if (payload?.success === false) {
    throw operationError('EXPORT_API_REJECTED', 'D1 export API rejected the request', false);
  }
  const result = payload?.result;
  if (result?.status === 'error') {
    throw operationError('EXPORT_TASK_FAILED', 'D1 export task failed', false);
  }
  const completed = result?.result || result;
  const sourceFilename = completed?.filename;
  const signedUrl = completed?.signed_url;

  if (typeof sourceFilename === 'string' && typeof signedUrl === 'string') {
    let parsedUrl;
    try {
      parsedUrl = new URL(signedUrl);
    } catch {
      throw operationError('EXPORT_SIGNED_URL_INVALID', 'D1 export returned an invalid download URL', false);
    }
    if (parsedUrl.protocol !== 'https:' || parsedUrl.username || parsedUrl.password) {
      throw operationError('EXPORT_SIGNED_URL_INVALID', 'D1 export returned an unsafe download URL', false);
    }
    if (!sourceFilename || sourceFilename.length > 255 || /[\u0000-\u001f\u007f]/.test(sourceFilename)) {
      throw operationError('EXPORT_FILENAME_INVALID', 'D1 export returned an invalid source filename', false);
    }
    return { status: 'complete', sourceFilename, signedUrl };
  }

  if (result?.status === 'complete') {
    throw operationError('EXPORT_RESULT_INCOMPLETE', 'D1 export is complete but the result is incomplete', true);
  }

  return { status: 'active' };
}
