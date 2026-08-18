import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LEGACY_ADMIN_TOKEN_KEY,
  readAdminToken,
  removeAdminToken,
  writeAdminToken
} from '../src/frontend/utils/adminToken.js';

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    }
  };
}

test('admin tokens are isolated and can be removed for only one API base', () => {
  const storage = createStorage();
  const firstBase = 'https://first.example';
  const secondBase = 'https://second.example/';

  assert.equal(writeAdminToken(storage, firstBase, 'first-token'), true);
  assert.equal(writeAdminToken(storage, secondBase, 'second-token'), true);
  assert.equal(readAdminToken(storage, firstBase), 'first-token');
  assert.equal(readAdminToken(storage, secondBase), 'second-token');

  removeAdminToken(storage, firstBase);
  assert.equal(readAdminToken(storage, firstBase), '');
  assert.equal(readAdminToken(storage, secondBase), 'second-token');
});

test('legacy single-site token migrates once to the explicitly selected API base', () => {
  const storage = createStorage({ [LEGACY_ADMIN_TOKEN_KEY]: 'legacy-token' });

  assert.equal(
    readAdminToken(storage, 'https://selected.example', { migrateLegacy: true }),
    'legacy-token'
  );
  assert.equal(storage.getItem(LEGACY_ADMIN_TOKEN_KEY), null);
  assert.equal(readAdminToken(storage, 'https://selected.example'), 'legacy-token');
  assert.equal(readAdminToken(storage, 'https://other.example'), '');
});

test('admin HTTP requests use and clear only the selected API base token', async () => {
  const originalWindow = globalThis.window;
  const originalStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const originalFetch = globalThis.fetch;
  const bases = ['https://first.example', 'https://second.example'];
  const storage = createStorage();
  const requests = [];
  let replaceSecondTokenDuringRequest = true;
  let reloads = 0;

  globalThis.window = {
    __APP_API_BASES__: bases,
    location: {
      origin: bases[0],
      pathname: '/admin',
      reload() { reloads += 1; },
      assign() {}
    }
  };
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: storage
  });
  globalThis.fetch = async (url, options) => {
    requests.push({ url, authorization: options?.headers?.Authorization || '' });
    if (url.startsWith(bases[1])) {
      if (replaceSecondTokenDuringRequest) {
        replaceSecondTokenDuringRequest = false;
        writeAdminToken(storage, bases[1], 'second-token-replacement');
      }
      return new Response(null, { status: 401 });
    }
    return Response.json({ success: true });
  };

  try {
    writeAdminToken(storage, bases[0], 'first-token');
    writeAdminToken(storage, bases[1], 'second-token');
    const { http } = await import(`../src/frontend/utils/http.js?token-test=${Date.now()}`);

    const secondResult = await http.getByIndex('/admin/api', 1);
    assert.equal(secondResult.status, 401);
    assert.equal(requests[0].authorization, 'Bearer second-token');
    assert.equal(readAdminToken(storage, bases[1]), 'second-token-replacement');
    assert.equal(readAdminToken(storage, bases[0]), 'first-token');
    assert.equal(reloads, 0);

    writeAdminToken(storage, bases[1], 'second-token');
    await http.getByIndex('/admin/api', 1);
    assert.equal(requests[1].authorization, 'Bearer second-token');
    assert.equal(readAdminToken(storage, bases[1]), '');
    assert.equal(reloads, 1);

    const firstResult = await http.getByIndex('/admin/api', 0, { autoRedirect: false });
    assert.equal(firstResult.status, 200);
    assert.equal(requests[2].authorization, 'Bearer first-token');
  } finally {
    globalThis.window = originalWindow;
    if (originalStorageDescriptor) {
      Object.defineProperty(globalThis, 'localStorage', originalStorageDescriptor);
    } else {
      delete globalThis.localStorage;
    }
    globalThis.fetch = originalFetch;
  }
});
