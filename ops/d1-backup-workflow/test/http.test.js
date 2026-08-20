import assert from 'node:assert/strict';
import test from 'node:test';

import { handleFetch } from '../src/http.js';

test('standalone backup Worker exposes no public trigger or status endpoint', async () => {
  const response = await handleFetch(new Request('https://backup.invalid/run', { method: 'POST' }));

  assert.equal(response.status, 404);
  assert.equal(await response.text(), 'Not found');
  assert.equal(response.headers.get('cache-control'), 'no-store');
});
