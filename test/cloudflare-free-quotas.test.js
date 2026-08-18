import assert from 'node:assert/strict';
import test from 'node:test';

import { getCloudflareFreeDailyQuotas } from '../src/frontend/utils/cloudflareQuotas.js';

test('Cloudflare free quota metadata matches the verified 2026 official limits', () => {
  assert.deepEqual(getCloudflareFreeDailyQuotas(), {
    verified_on: '2026-08-18',
    d1_rows_read: {
      limit: 5_000_000,
      unit: 'rows/day',
      source: 'https://developers.cloudflare.com/d1/platform/pricing/'
    },
    d1_rows_written: {
      limit: 100_000,
      unit: 'rows/day',
      source: 'https://developers.cloudflare.com/d1/platform/pricing/'
    },
    workers_requests: {
      limit: 100_000,
      unit: 'requests/day',
      source: 'https://developers.cloudflare.com/workers/platform/pricing/'
    },
    durable_objects_requests: {
      limit: 100_000,
      unit: 'requests/day',
      source: 'https://developers.cloudflare.com/durable-objects/platform/pricing/'
    },
    durable_objects_duration: {
      limit: 13_000,
      unit: 'GB-s/day',
      source: 'https://developers.cloudflare.com/durable-objects/platform/pricing/'
    }
  });
});
