import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildAuditListRequest,
  formatAuditDetail,
  normalizeAuditPage
} from '../src/frontend/utils/audit.js';

test('audit presentation builds bounded requests and normalizes API pages', () => {
  assert.deepEqual(
    buildAuditListRequest({ eventType: ' auth.login.failure ', page: 3 }),
    {
      action: 'audit_list',
      event_type: 'auth.login.failure',
      page: 3,
      page_size: 20
    }
  );
  assert.deepEqual(
    buildAuditListRequest({ eventType: '   ', page: -4 }),
    {
      action: 'audit_list',
      page: 1,
      page_size: 20
    }
  );

  assert.deepEqual(
    normalizeAuditPage({
      events: [{ id: 7, event_type: 'admin.server.import', detail: { imported: 1, skipped: 0 } }],
      pagination: { page: 2, page_size: 20, total: 21, total_pages: 2 }
    }),
    {
      events: [{ id: 7, event_type: 'admin.server.import', detail: { imported: 1, skipped: 0 } }],
      pagination: { page: 2, page_size: 20, total: 21, total_pages: 2 }
    }
  );
  assert.deepEqual(normalizeAuditPage(null), {
    events: [],
    pagination: { page: 1, page_size: 20, total: 0, total_pages: 0 }
  });
  assert.equal(
    formatAuditDetail({ changed_fields: ['site_title', 'theme_url'], imported: 1 }),
    'changed_fields: site_title, theme_url · imported: 1'
  );
  assert.equal(formatAuditDetail({}), '—');
});
