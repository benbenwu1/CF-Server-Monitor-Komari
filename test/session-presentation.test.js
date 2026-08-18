import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeAdminSessions,
  refreshSessionTokenForSite,
  revokeCurrentSessionForLogout
} from '../src/frontend/utils/session.js';

test('session presentation keeps only bounded device metadata from the admin response', () => {
  assert.deepEqual(
    normalizeAdminSessions({
      sessions: [{
        id: 'session-1',
        auth_method: 'password',
        first_ip: '203.0.113.61',
        last_ip: '203.0.113.62',
        user_agent: 'Browser',
        created_at: 100,
        last_seen_at: 200,
        expires_at: 300,
        current: 1,
        online: true,
        token: 'must-not-enter-frontend-state'
      }]
    }),
    [{
      id: 'session-1',
      auth_method: 'password',
      first_ip: '203.0.113.61',
      last_ip: '203.0.113.62',
      user_agent: 'Browser',
      created_at: 100,
      last_seen_at: 200,
      expires_at: 300,
      current: true,
      online: true
    }]
  );
  assert.deepEqual(normalizeAdminSessions({ sessions: [{ id: '' }, null, { id: 'ok' }] }), [{
    id: 'ok',
    auth_method: '',
    first_ip: '',
    last_ip: '',
    user_agent: '',
    created_at: 0,
    last_seen_at: 0,
    expires_at: 0,
    current: false,
    online: false
  }]);
  assert.deepEqual(normalizeAdminSessions(null), []);
});

test('logout only completes locally after the server confirms current-session revocation', async () => {
  const requestedApiIndexes = [];
  assert.equal(
    await revokeCurrentSessionForLogout(async apiIndex => {
      requestedApiIndexes.push(apiIndex);
      return {
        error: false,
        data: { success: true, revoked: true }
      };
    }, 2),
    true
  );
  assert.deepEqual(requestedApiIndexes, [2]);
  assert.equal(
    await revokeCurrentSessionForLogout(async () => ({
      error: 'temporary_failure',
      data: null
    })),
    false
  );
  assert.equal(
    await revokeCurrentSessionForLogout(async () => {
      throw new Error('network unavailable');
    }),
    false
  );
});

test('refresh never installs a token returned for a site that is no longer selected', async () => {
  const storedTokens = [];
  const staleResult = await refreshSessionTokenForSite({
    apiIndex: 0,
    requestRefresh: async apiIndex => ({
      error: false,
      data: { token: `site-${apiIndex}-replacement` }
    }),
    isCurrentSite: apiIndex => apiIndex === 1,
    storeToken: token => {
      storedTokens.push(token);
      return true;
    }
  });

  assert.deepEqual(staleResult, { applied: false, stale: true });
  assert.deepEqual(storedTokens, []);

  const currentResult = await refreshSessionTokenForSite({
    apiIndex: 1,
    requestRefresh: async () => ({
      error: false,
      data: { token: 'current-site-replacement' }
    }),
    isCurrentSite: apiIndex => apiIndex === 1,
    storeToken: token => {
      storedTokens.push(token);
      return true;
    }
  });

  assert.deepEqual(currentResult, { applied: true, stale: false });
  assert.deepEqual(storedTokens, ['current-site-replacement']);
});
