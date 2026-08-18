import assert from 'node:assert/strict';
import test from 'node:test';

import { getTrafficUsageBytes } from '../src/frontend/utils/traffic.js';

test('traffic usage supports min without changing existing calculation modes', () => {
  const server = {
    net_rx_monthly: 900,
    net_tx_monthly: 400
  };

  assert.equal(getTrafficUsageBytes({ ...server, traffic_calc_type: 'total' }), 1300);
  assert.equal(getTrafficUsageBytes({ ...server, traffic_calc_type: 'dl' }), 900);
  assert.equal(getTrafficUsageBytes({ ...server, traffic_calc_type: 'ul' }), 400);
  assert.equal(getTrafficUsageBytes({ ...server, traffic_calc_type: 'max' }), 900);
  assert.equal(getTrafficUsageBytes({ ...server, traffic_calc_type: 'min' }), 400);
});
