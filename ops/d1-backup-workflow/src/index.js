import { WorkflowEntrypoint } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';

import {
  buildBackupObjectKeys,
  buildD1ExportUrl,
  classifyHttpFailure,
  createBackupManifest,
  parsePollExportResponse,
  parseStartExportResponse,
  requestD1Export,
  validateBackupConfig
} from './exportApi.js';
import { handleFetch } from './http.js';

const API_STEP_CONFIG = Object.freeze({
  retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' },
  timeout: '2 minutes'
});

const POLL_STEP_CONFIG = Object.freeze({
  retries: { limit: 30, delay: '1 minute', backoff: 'constant' },
  timeout: '2 minutes'
});

const STREAM_STEP_CONFIG = Object.freeze({
  retries: { limit: 5, delay: '30 seconds', backoff: 'exponential' },
  timeout: '30 minutes'
});

function safeErrorCode(error) {
  return typeof error?.code === 'string' && /^[A-Z0-9_]{3,80}$/.test(error.code)
    ? error.code
    : 'UNEXPECTED_BACKUP_ERROR';
}

function throwWorkflowError(error) {
  const code = safeErrorCode(error);
  if (error?.retryable === false) {
    throw new NonRetryableError(code, 'D1BackupNonRetryableError');
  }
  const retryableError = new Error(code);
  retryableError.name = 'D1BackupRetryableError';
  retryableError.code = code;
  throw retryableError;
}

async function runStepOperation(operation) {
  try {
    return await operation();
  } catch (error) {
    throwWorkflowError(error);
  }
}

function retryableError(code) {
  const error = new Error(code);
  error.name = 'BackupOperationError';
  error.code = code;
  error.retryable = true;
  return error;
}

function nonRetryableError(code) {
  const error = new Error(code);
  error.name = 'BackupOperationError';
  error.code = code;
  error.retryable = false;
  return error;
}

function arrayBufferToHex(value) {
  if (!(value instanceof ArrayBuffer)) return null;
  return Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function serializeR2Object(object) {
  if (!object) throw retryableError('R2_OBJECT_METADATA_MISSING');
  return {
    size: object.size,
    etag: object.etag,
    uploadedAt: object.uploaded.toISOString(),
    md5: arrayBufferToHex(object.checksums?.md5)
  };
}

async function storeSqlDump(bucket, key, stream, metadata) {
  const existing = await bucket.head(key);
  if (existing) return serializeR2Object(existing);

  const object = await bucket.put(key, stream, {
    onlyIf: { etagDoesNotMatch: '*' },
    httpMetadata: { contentType: 'application/sql; charset=utf-8' },
    customMetadata: {
      format: 'cfsm-d1-full-backup',
      database_ref: metadata.databaseLabel,
      workflow_instance: metadata.instanceId
    }
  });
  if (object) return serializeR2Object(object);

  const concurrentlyStored = await bucket.head(key);
  return serializeR2Object(concurrentlyStored);
}

async function storeManifest(bucket, key, manifest) {
  const existing = await bucket.head(key);
  if (existing) return key;

  const object = await bucket.put(key, `${JSON.stringify(manifest, null, 2)}\n`, {
    onlyIf: { etagDoesNotMatch: '*' },
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
    customMetadata: {
      format: manifest.format,
      database_ref: manifest.database_ref,
      sql_key: manifest.object.sql_key
    }
  });
  if (object) return key;

  const concurrentlyStored = await bucket.head(key);
  if (!concurrentlyStored) throw retryableError('R2_MANIFEST_WRITE_FAILED');
  return key;
}

export class D1BackupWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const prepared = await step.do('prepare backup metadata', async () => runStepOperation(async () => {
      const config = validateBackupConfig(this.env);
      const triggerTime = event.schedule?.scheduledTime ?? event.timestamp;
      const triggeredAt = new Date(triggerTime).toISOString();
      const keys = buildBackupObjectKeys({
        prefix: config.prefix,
        triggeredAt,
        instanceId: event.instanceId
      });
      return {
        ...config,
        ...keys,
        triggeredAt,
        instanceId: event.instanceId,
        workflowName: event.workflowName,
        schedule: event.schedule || null
      };
    }));

    const exportUrl = buildD1ExportUrl(prepared.accountId, prepared.databaseId);
    const started = await step.do('start D1 export', API_STEP_CONFIG, async () => runStepOperation(async () => {
      const payload = await requestD1Export({
        url: exportUrl,
        token: this.env.D1_REST_API_TOKEN,
        body: { output_format: 'polling' }
      });
      return parseStartExportResponse(payload);
    }));

    const completed = await step.do('poll D1 export until ready', POLL_STEP_CONFIG, async () => runStepOperation(async () => {
      const payload = await requestD1Export({
        url: exportUrl,
        token: this.env.D1_REST_API_TOKEN,
        body: {
          output_format: 'polling',
          current_bookmark: started.bookmark
        }
      });
      const result = parsePollExportResponse(payload);
      if (result.status !== 'complete') throw retryableError('EXPORT_NOT_READY');
      return result;
    }));

    const storedSql = await step.do('stream D1 SQL dump to private R2', STREAM_STEP_CONFIG, async () => runStepOperation(async () => {
      const existing = await this.env.BACKUP_BUCKET.head(prepared.sqlKey);
      if (existing) return serializeR2Object(existing);

      let response;
      try {
        response = await fetch(completed.signedUrl);
      } catch {
        throw retryableError('EXPORT_DOWNLOAD_NETWORK_ERROR');
      }
      if (!response.ok) {
        const failure = classifyHttpFailure(response.status);
        const error = failure.retryable
          ? retryableError(`EXPORT_DOWNLOAD_${failure.code}`)
          : nonRetryableError(`EXPORT_DOWNLOAD_${failure.code}`);
        throw error;
      }
      if (!response.body) throw retryableError('EXPORT_DOWNLOAD_BODY_MISSING');

      return storeSqlDump(this.env.BACKUP_BUCKET, prepared.sqlKey, response.body, prepared);
    }));

    const manifest = createBackupManifest({
      databaseLabel: prepared.databaseLabel,
      workflowName: prepared.workflowName,
      instanceId: prepared.instanceId,
      triggeredAt: prepared.triggeredAt,
      schedule: prepared.schedule,
      bookmark: started.bookmark,
      sourceFilename: completed.sourceFilename,
      sqlKey: prepared.sqlKey,
      uploadedAt: storedSql.uploadedAt,
      size: storedSql.size,
      etag: storedSql.etag,
      md5: storedSql.md5
    });

    await step.do('write private backup manifest', API_STEP_CONFIG, async () => runStepOperation(async () => {
      return storeManifest(this.env.BACKUP_BUCKET, prepared.manifestKey, manifest);
    }));

    return {
      status: 'complete',
      sql_key: prepared.sqlKey,
      manifest_key: prepared.manifestKey,
      size_bytes: storedSql.size
    };
  }
}

export default {
  fetch: handleFetch
};
