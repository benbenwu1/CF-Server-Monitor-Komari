import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AGENT_CONFIG_SCHEMA_VERSION,
  buildAgentConfig,
  serializeAgentConfig
} from '../src/utils/agentConfig.js';

const task = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Example HTTPS',
  type: 'http',
  target: 'https://example.com/health',
  interval_seconds: 300,
  timeout_ms: 5000
};

test('schema 6 carries a stable bounded ping task description', () => {
  assert.equal(AGENT_CONFIG_SCHEMA_VERSION, 6);
  const config = buildAgentConfig({}, null, 6, [task]);

  assert.deepEqual(config.ping_tasks, [task]);
  const serialized = serializeAgentConfig(config);
  const parsed = new URLSearchParams(serialized);
  assert.equal(parsed.get('schema_version'), '6');
  assert.deepEqual(JSON.parse(parsed.get('ping_tasks')), [task]);
});

test('older agent schemas never receive ping task fields', () => {
  for (const version of [3, 4, 5]) {
    const config = buildAgentConfig({}, null, version, [task]);
    assert.equal(Object.hasOwn(config, 'ping_tasks'), false);
    assert.equal(new URLSearchParams(serializeAgentConfig(config)).has('ping_tasks'), false);
  }
});
