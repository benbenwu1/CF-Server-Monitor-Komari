const CLOUDFLARE_FREE_DAILY_QUOTAS = Object.freeze({
  verified_on: '2026-08-18',
  d1_rows_read: Object.freeze({
    limit: 5_000_000,
    unit: 'rows/day',
    source: 'https://developers.cloudflare.com/d1/platform/pricing/'
  }),
  d1_rows_written: Object.freeze({
    limit: 100_000,
    unit: 'rows/day',
    source: 'https://developers.cloudflare.com/d1/platform/pricing/'
  }),
  workers_requests: Object.freeze({
    limit: 100_000,
    unit: 'requests/day',
    source: 'https://developers.cloudflare.com/workers/platform/pricing/'
  }),
  durable_objects_requests: Object.freeze({
    limit: 100_000,
    unit: 'requests/day',
    source: 'https://developers.cloudflare.com/durable-objects/platform/pricing/'
  }),
  durable_objects_duration: Object.freeze({
    limit: 13_000,
    unit: 'GB-s/day',
    source: 'https://developers.cloudflare.com/durable-objects/platform/pricing/'
  })
})

export function getCloudflareFreeDailyQuotas() {
  return CLOUDFLARE_FREE_DAILY_QUOTAS
}
