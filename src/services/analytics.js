const ANALYTICS_INDEX = 'cfsm-shadow';
const MAX_LABEL_LENGTH = 64;

function boundedLabel(value, fallback = 'unknown') {
  const label = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, MAX_LABEL_LENGTH);
  return label || fallback;
}

export function classifyRequestRoute(pathname) {
  const path = String(pathname || '/');
  if (path === '/update') return 'agent_update';
  if (path === '/api/ws') return 'frontend_ws';
  if (path === '/admin/api') return 'admin_api';
  if (path === '/admin/oauth/github/callback') return 'oauth_callback';
  if (path === '/api/config') return 'api_config';
  if (path === '/api/server' || path === '/api/servers') return 'api_servers';
  if (path.startsWith('/api/history')) return 'api_history';
  if (path.startsWith('/api/ping-')) return 'api_ping';
  if (path === '/__do/health') return 'do_health';
  if (path === '/theme') return 'theme';
  if (path === '/admin' || path === '/admin/') return 'admin_page';
  if (path.startsWith('/assets/')) return 'asset';
  if (path.startsWith('/api/')) return 'api_other';
  return 'frontend';
}

function statusOutcome(status, explicitOutcome = '') {
  if (explicitOutcome) return boundedLabel(explicitOutcome);
  if (status === 101) return 'upgrade';
  if (status >= 500) return 'server_error';
  if (status >= 400) return 'client_error';
  if (status >= 300) return 'redirect';
  return 'success';
}

export function writeAnalyticsPoint(env, {
  kind,
  name,
  method = 'none',
  outcome = 'success',
  status = 0,
  durationMs = 0,
  count = 1
} = {}) {
  const dataset = env?.CFSM_ANALYTICS;
  if (!dataset || typeof dataset.writeDataPoint !== 'function') return false;

  try {
    dataset.writeDataPoint({
      indexes: [ANALYTICS_INDEX],
      blobs: [
        boundedLabel(kind),
        boundedLabel(name),
        boundedLabel(method),
        boundedLabel(outcome)
      ],
      doubles: [
        Number.isFinite(Number(status)) ? Number(status) : 0,
        Math.max(0, Number(durationMs) || 0),
        Math.max(0, Number(count) || 0)
      ]
    });
    return true;
  } catch (_) {
    console.warn(JSON.stringify({ event: 'analytics.write_failed', error: 'write_failed' }));
    return false;
  }
}

export function recordRequestTelemetry(env, request, status, durationMs, explicitOutcome = '') {
  let pathname = '/';
  try {
    pathname = new URL(request.url).pathname;
  } catch (_) {}

  return writeAnalyticsPoint(env, {
    kind: 'request',
    name: classifyRequestRoute(pathname),
    method: request?.method || 'UNKNOWN',
    outcome: statusOutcome(Number(status) || 0, explicitOutcome),
    status: Number(status) || 0,
    durationMs,
    count: 1
  });
}
