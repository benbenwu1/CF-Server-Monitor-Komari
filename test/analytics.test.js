import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyRequestRoute,
  recordRequestTelemetry,
  writeAnalyticsPoint
} from '../src/services/analytics.js';

test('analytics is optional and failures never escape', () => {
  assert.equal(writeAnalyticsPoint({}, { kind: 'request', name: 'frontend' }), false);
  assert.equal(writeAnalyticsPoint({
    CFSM_ANALYTICS: {
      writeDataPoint() {
        throw new Error('simulated analytics failure');
      }
    }
  }, { kind: 'request', name: 'frontend' }), false);
});

test('request telemetry uses bounded route categories without query strings', () => {
  const points = [];
  const env = {
    CFSM_ANALYTICS: {
      writeDataPoint(point) {
        points.push(point);
      }
    }
  };
  const request = new Request('https://example.com/api/history/all?id=secret-server-id&token=hidden', {
    method: 'GET'
  });

  assert.equal(recordRequestTelemetry(env, request, 200, 12.5), true);
  assert.equal(points.length, 1);
  assert.deepEqual(points[0].indexes, ['cfsm-shadow']);
  assert.deepEqual(points[0].blobs, ['request', 'api_history', 'GET', 'success']);
  assert.deepEqual(points[0].doubles, [200, 12.5, 1]);
  assert.equal(JSON.stringify(points[0]).includes('secret-server-id'), false);
  assert.equal(JSON.stringify(points[0]).includes('hidden'), false);
});

test('request route classification remains low-cardinality', () => {
  assert.equal(classifyRequestRoute('/update'), 'agent_update');
  assert.equal(classifyRequestRoute('/api/servers'), 'api_servers');
  assert.equal(classifyRequestRoute('/api/ping-history'), 'api_ping');
  assert.equal(classifyRequestRoute('/assets/index.js'), 'asset');
  assert.equal(classifyRequestRoute('/arbitrary/page'), 'frontend');
});
