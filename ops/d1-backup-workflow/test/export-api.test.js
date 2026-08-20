import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildD1ExportUrl,
  buildBackupObjectKeys,
  classifyHttpFailure,
  createBackupManifest,
  parsePollExportResponse,
  parseStartExportResponse,
  requestD1Export,
  validateBackupConfig
} from '../src/exportApi.js';

test('buildD1ExportUrl creates the documented account-scoped export endpoint', () => {
  assert.equal(
    buildD1ExportUrl(
      '0123456789abcdef0123456789abcdef',
      '01234567-89ab-cdef-0123-456789abcdef'
    ),
    'https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/d1/database/01234567-89ab-cdef-0123-456789abcdef/export'
  );
});

test('validateBackupConfig returns only non-secret normalized configuration', () => {
  const config = validateBackupConfig({
    ACCOUNT_ID: '0123456789ABCDEF0123456789ABCDEF',
    DATABASE_ID: '01234567-89AB-CDEF-0123-456789ABCDEF',
    DATABASE_LABEL: 'cf-server-monitor-komari-db',
    BACKUP_PREFIX: 'cfsm-d1-full-backups/',
    D1_REST_API_TOKEN: 'must-not-be-returned',
    BACKUP_BUCKET: { head() {}, put() {} }
  });

  assert.deepEqual(config, {
    accountId: '0123456789abcdef0123456789abcdef',
    databaseId: '01234567-89ab-cdef-0123-456789abcdef',
    databaseLabel: 'cf-server-monitor-komari-db',
    prefix: 'cfsm-d1-full-backups'
  });
  assert.equal(JSON.stringify(config).includes('must-not-be-returned'), false);
});

test('validateBackupConfig rejects missing or malformed bindings without echoing secrets', () => {
  const valid = {
    ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
    DATABASE_ID: '01234567-89ab-cdef-0123-456789abcdef',
    DATABASE_LABEL: 'cf-server-monitor-komari-db',
    D1_REST_API_TOKEN: 'super-secret-token',
    BACKUP_BUCKET: { head() {}, put() {} }
  };

  const cases = [
    [{ ...valid, ACCOUNT_ID: '../bad' }, 'CONFIG_ACCOUNT_ID'],
    [{ ...valid, DATABASE_ID: 'not-a-uuid' }, 'CONFIG_DATABASE_ID'],
    [{ ...valid, DATABASE_LABEL: '' }, 'CONFIG_DATABASE_LABEL'],
    [{ ...valid, BACKUP_PREFIX: '../escape' }, 'CONFIG_BACKUP_PREFIX'],
    [{ ...valid, D1_REST_API_TOKEN: '' }, 'CONFIG_API_TOKEN'],
    [{ ...valid, BACKUP_BUCKET: undefined }, 'CONFIG_R2_BINDING'],
    [{ ...valid, BACKUP_BUCKET: { put() {} } }, 'CONFIG_R2_BINDING']
  ];

  for (const [env, code] of cases) {
    assert.throws(
      () => validateBackupConfig(env),
      (error) => error.code === code && !error.message.includes('super-secret-token')
    );
  }
});

test('export response parsers accept the current API schema and the official example shape', () => {
  assert.deepEqual(
    parseStartExportResponse({ success: true, result: { at_bookmark: 'bookmark-1', status: 'active' } }),
    { bookmark: 'bookmark-1' }
  );

  assert.deepEqual(
    parsePollExportResponse({
      success: true,
      result: {
        status: 'complete',
        result: {
          filename: 'dump.sql',
          signed_url: 'https://signed.example.invalid/dump.sql'
        }
      }
    }),
    {
      status: 'complete',
      sourceFilename: 'dump.sql',
      signedUrl: 'https://signed.example.invalid/dump.sql'
    }
  );

  assert.deepEqual(
    parsePollExportResponse({
      success: true,
      result: {
        filename: 'legacy.sql',
        signed_url: 'https://signed.example.invalid/legacy.sql'
      }
    }),
    {
      status: 'complete',
      sourceFilename: 'legacy.sql',
      signedUrl: 'https://signed.example.invalid/legacy.sql'
    }
  );

  assert.throws(
    () => parseStartExportResponse({ success: false, errors: [{ message: 'must not be echoed' }] }),
    (error) => error.code === 'EXPORT_API_REJECTED'
      && error.retryable === false
      && !error.message.includes('must not be echoed')
  );
});

test('parsePollExportResponse distinguishes active, failed, and unsafe results', () => {
  assert.deepEqual(
    parsePollExportResponse({ success: true, result: { status: 'active', at_bookmark: 'bookmark-1' } }),
    { status: 'active' }
  );

  assert.throws(
    () => parsePollExportResponse({
      success: true,
      result: {
        status: 'error',
        error: 'provider detail must not be echoed',
        result: {
          filename: 'must-not-be-used.sql',
          signed_url: 'https://signed.example.invalid/must-not-be-used.sql'
        }
      }
    }),
    (error) => error.code === 'EXPORT_TASK_FAILED'
      && error.retryable === false
      && !error.message.includes('provider detail')
  );

  assert.throws(
    () => parsePollExportResponse({
      success: true,
      result: {
        status: 'complete',
        result: { filename: 'dump.sql', signed_url: 'http://127.0.0.1/private' }
      }
    }),
    (error) => error.code === 'EXPORT_SIGNED_URL_INVALID' && error.retryable === false
  );

  assert.throws(
    () => parsePollExportResponse({ success: true, result: { status: 'complete', result: {} } }),
    (error) => error.code === 'EXPORT_RESULT_INCOMPLETE' && error.retryable === true
  );

  assert.throws(
    () => parsePollExportResponse({ success: false, errors: [{ message: 'must not be echoed' }] }),
    (error) => error.code === 'EXPORT_API_REJECTED'
      && error.retryable === false
      && !error.message.includes('must not be echoed')
  );
});

test('classifyHttpFailure retries only throttling, server, and network-class failures', () => {
  assert.deepEqual(classifyHttpFailure(401), { code: 'HTTP_AUTHENTICATION_FAILED', retryable: false });
  assert.deepEqual(classifyHttpFailure(403), { code: 'HTTP_PERMISSION_DENIED', retryable: false });
  assert.deepEqual(classifyHttpFailure(400), { code: 'HTTP_REQUEST_REJECTED', retryable: false });
  assert.deepEqual(classifyHttpFailure(429), { code: 'HTTP_RATE_LIMITED', retryable: true });
  assert.deepEqual(classifyHttpFailure(503), { code: 'HTTP_UPSTREAM_UNAVAILABLE', retryable: true });
});

test('buildBackupObjectKeys creates stable non-overwriting UTC paths', () => {
  assert.deepEqual(
    buildBackupObjectKeys({
      prefix: 'cfsm-d1-full-backups',
      triggeredAt: '2026-08-19T03:04:05.000Z',
      instanceId: 'backup/instance 42'
    }),
    {
      sqlKey: 'cfsm-d1-full-backups/2026/08/19/backup%2Finstance%2042.sql',
      manifestKey: 'cfsm-d1-full-backups/2026/08/19/backup%2Finstance%2042.manifest.json'
    }
  );
});

test('createBackupManifest records restore evidence without credentials or signed URLs', () => {
  const manifest = createBackupManifest({
    databaseLabel: 'cf-server-monitor-komari-db',
    workflowName: 'cfsm-d1-full-backup',
    instanceId: 'instance-42',
    triggeredAt: '2026-08-19T03:04:05.000Z',
    schedule: { cron: '17 3 * * *', scheduledTime: 1787108645000 },
    bookmark: 'bookmark-1',
    sourceFilename: 'dump.sql',
    sqlKey: 'cfsm-d1-full-backups/2026/08/19/instance-42.sql',
    uploadedAt: '2026-08-19T03:05:06.000Z',
    size: 4096,
    etag: 'etag-value',
    md5: '0123456789abcdef0123456789abcdef',
    databaseId: 'must-not-appear',
    signedUrl: 'https://must-not-appear.invalid/',
    apiToken: 'must-not-appear'
  });

  assert.deepEqual(manifest, {
    format: 'cfsm-d1-full-backup',
    format_version: 1,
    generated_at: '2026-08-19T03:05:06.000Z',
    database_ref: 'cf-server-monitor-komari-db',
    workflow: {
      name: 'cfsm-d1-full-backup',
      instance_id: 'instance-42',
      triggered_at: '2026-08-19T03:04:05.000Z',
      trigger: 'schedule',
      cron: '17 3 * * *',
      scheduled_time: '2026-08-19T03:04:05.000Z'
    },
    export: {
      bookmark: 'bookmark-1',
      source_filename: 'dump.sql'
    },
    object: {
      sql_key: 'cfsm-d1-full-backups/2026/08/19/instance-42.sql',
      size_bytes: 4096,
      etag: 'etag-value',
      checksums: { md5: '0123456789abcdef0123456789abcdef' }
    },
    restore: {
      automatic: false,
      requires_maintenance_window: true
    }
  });
  const serialized = JSON.stringify(manifest);
  assert.equal(serialized.includes('must-not-appear'), false);
});

test('requestD1Export sends the polling contract and returns bounded API JSON', async () => {
  const calls = [];
  const payload = await requestD1Export({
    url: 'https://api.cloudflare.com/client/v4/accounts/account/d1/database/database/export',
    token: 'secret-token',
    body: { output_format: 'polling' },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ success: true, result: { at_bookmark: 'bookmark-1' } }), {
        status: 202,
        headers: { 'content-type': 'application/json', 'content-length': '62' }
      });
    }
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer secret-token');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.equal(calls[0].init.body, JSON.stringify({ output_format: 'polling' }));
  assert.deepEqual(payload, { success: true, result: { at_bookmark: 'bookmark-1' } });
});

test('requestD1Export cancels a streamed API response as soon as it exceeds the byte limit', async () => {
  let chunkIndex = 0;
  let cancelled = false;
  const chunks = [
    new Uint8Array(40_000).fill(97),
    new Uint8Array(40_000).fill(98),
    new Uint8Array([125])
  ];
  const body = new ReadableStream({
    pull(controller) {
      if (chunkIndex < chunks.length) {
        controller.enqueue(chunks[chunkIndex]);
        chunkIndex += 1;
      } else {
        controller.close();
      }
    },
    cancel() {
      cancelled = true;
    }
  }, { highWaterMark: 0 });

  await assert.rejects(
    requestD1Export({
      url: 'https://api.cloudflare.com/client/v4/export',
      token: 'secret-token',
      body: { output_format: 'polling' },
      fetchImpl: async () => new Response(body, { status: 200 })
    }),
    (error) => error.code === 'HTTP_RESPONSE_TOO_LARGE' && error.retryable === false
  );
  assert.equal(cancelled, true);

  let declaredLengthCancelled = false;
  const declaredLengthBody = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([123]));
    },
    cancel() {
      declaredLengthCancelled = true;
    }
  }, { highWaterMark: 0 });
  await assert.rejects(
    requestD1Export({
      url: 'https://api.cloudflare.com/client/v4/export',
      token: 'secret-token',
      body: { output_format: 'polling' },
      fetchImpl: async () => new Response(declaredLengthBody, {
        status: 200,
        headers: { 'content-length': String((64 * 1024) + 1) }
      })
    }),
    (error) => error.code === 'HTTP_RESPONSE_TOO_LARGE' && error.retryable === false
  );
  assert.equal(declaredLengthCancelled, true);
});

test('requestD1Export exposes only safe retry metadata for HTTP and network failures', async () => {
  const secret = 'must-not-appear';
  const cases = [
    [async () => new Response('forbidden detail', { status: 403 }), 'HTTP_PERMISSION_DENIED', false],
    [async () => new Response('slow down', { status: 429 }), 'HTTP_RATE_LIMITED', true],
    [async () => new Response('unavailable', { status: 503 }), 'HTTP_UPSTREAM_UNAVAILABLE', true],
    [async () => { throw new Error('network detail'); }, 'HTTP_NETWORK_ERROR', true],
    [async () => new Response('not-json', { status: 200 }), 'HTTP_RESPONSE_INVALID', true]
  ];

  for (const [fetchImpl, code, retryable] of cases) {
    await assert.rejects(
      requestD1Export({
        url: 'https://api.cloudflare.com/client/v4/export',
        token: secret,
        body: { output_format: 'polling' },
        fetchImpl
      }),
      (error) => error.code === code
        && error.retryable === retryable
        && !error.message.includes(secret)
        && !error.message.includes('forbidden detail')
    );
  }
});
