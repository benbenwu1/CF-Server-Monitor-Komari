import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AGENT_CONFIG_SCHEMA_VERSION,
  buildAgentConfig,
  normalizeAgentConfigSchemaVersion,
  serializeAgentConfig
} from '../src/utils/agentConfig.js';

test('worker remains compatible with cfsm-agent schema 5', () => {
  assert.equal(AGENT_CONFIG_SCHEMA_VERSION >= 5, true);
  assert.equal(normalizeAgentConfigSchemaVersion('5'), 5);

  const config = buildAgentConfig(
    { collect_interval: 10, report_interval: 60, reset_day: 1, connection_mode: 'auto' },
    { wss_report_enabled: 'true' },
    5
  );

  assert.deepEqual(config, {
    collect_interval: 10,
    report_interval: 60,
    wss_report_interval: 2,
    reset_day: 1,
    custom_ct: '',
    custom_cu: '',
    custom_cm: '',
    custom_bd: '',
    interface: '',
    schema_version: 5,
    connection_mode: 'auto'
  });
  assert.equal(
    serializeAgentConfig(config),
    'collect_interval=10&report_interval=60&wss_report_interval=2&reset_day=1&schema_version=5&custom_ct=&custom_cu=&custom_cm=&custom_bd=&interface=&connection_mode=auto'
  );
});

test('schema 4 remains stable while schema 5 adds only WSS cadence', () => {
  const config = buildAgentConfig(
    { collect_interval: 10, report_interval: 60, reset_day: 1, connection_mode: 'auto' },
    { wss_report_enabled: 'true' },
    4
  );

  assert.equal(config.schema_version, 4);
  assert.equal(config.connection_mode, 'auto');
  assert.equal(Object.hasOwn(config, 'wss_report_interval'), false);
});
