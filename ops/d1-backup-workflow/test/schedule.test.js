import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const configUrl = new URL('../wrangler.test.toml', import.meta.url);

test('standalone Wrangler config schedules one low-traffic UTC backup without a Worker Cron handler', async () => {
  const config = await readFile(configUrl, 'utf8');

  assert.match(config, /name\s*=\s*"cfsm-d1-backup-workflow-config-test"/);
  assert.match(config, /compatibility_date\s*=\s*"2026-08-19"/);
  assert.match(config, /compatibility_flags\s*=\s*\["nodejs_compat"\]/);
  assert.match(config, /binding\s*=\s*"BACKUP_WORKFLOW"/);
  assert.match(config, /class_name\s*=\s*"D1BackupWorkflow"/);
  assert.match(config, /schedules\s*=\s*\["17 19 \* \* \*"\]/);
  assert.match(config, /binding\s*=\s*"BACKUP_BUCKET"/);
  assert.doesNotMatch(config, /D1_REST_API_TOKEN\s*=/);
  assert.doesNotMatch(config, /\[triggers\]/);
});
