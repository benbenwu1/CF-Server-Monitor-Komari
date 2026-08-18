import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeAdminSessions } from '../src/frontend/utils/session.js';

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
