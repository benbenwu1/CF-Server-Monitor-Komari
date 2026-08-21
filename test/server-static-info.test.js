import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeServerStaticInfo,
  persistServerStaticInfo
} from '../src/services/serverStaticInfo.js';

test('static topology normalization is bounded and preserves absent fields', () => {
  assert.deepEqual(
    normalizeServerStaticInfo({
      cpu_physical_cores: '99999',
      virtualization: '  KVM/GUEST\u0000  '
    }),
    {
      cpu_physical_cores: 4096,
      virtualization: 'kvm/guest'
    }
  );

  assert.deepEqual(
    normalizeServerStaticInfo({ virtualization: 'Docker/Guest' }, {
      cpu_physical_cores: 8,
      virtualization: 'kvm/guest'
    }),
    {
      cpu_physical_cores: 8,
      virtualization: 'docker/guest'
    }
  );
});

test('static topology writes only when values change', async () => {
  const writes = [];
  const db = {
    prepare(sql) {
      return {
        bind(...values) {
          return {
            async run() {
              writes.push({ sql, values });
              return { meta: { changes: 1 } };
            }
          };
        }
      };
    }
  };

  assert.equal(await persistServerStaticInfo(db, 'server-1', {
    cpu_physical_cores: 4,
    virtualization: 'kvm/guest'
  }, {
    cpu_physical_cores: '4',
    virtualization: 'KVM/GUEST'
  }), false);
  assert.equal(writes.length, 0);

  assert.equal(await persistServerStaticInfo(db, 'server-1', {
    cpu_physical_cores: 4,
    virtualization: 'kvm/guest'
  }, {
    cpu_physical_cores: '8'
  }), true);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].values, [8, 'kvm/guest', 'server-1']);
  assert.match(writes[0].sql, /UPDATE servers/);
});
