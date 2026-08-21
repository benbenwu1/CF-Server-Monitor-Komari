import { addServerColumns } from '../database/updateDatabase.js';
import { clearServersListCache } from '../utils/cache.js';

const MAX_PHYSICAL_CORES = 4096;
const MAX_VIRTUALIZATION_LENGTH = 64;

function hasOwn(source, field) {
  return !!source && Object.prototype.hasOwnProperty.call(source, field);
}

function normalizePhysicalCores(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(MAX_PHYSICAL_CORES, Math.trunc(number)));
}

function normalizeVirtualization(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .toLowerCase()
    .slice(0, MAX_VIRTUALIZATION_LENGTH);
}

export function normalizeServerStaticInfo(metrics = {}, current = {}) {
  const physicalCores = hasOwn(metrics, 'cpu_physical_cores')
    ? normalizePhysicalCores(metrics.cpu_physical_cores)
    : normalizePhysicalCores(current.cpu_physical_cores);
  const virtualization = hasOwn(metrics, 'virtualization')
    ? normalizeVirtualization(metrics.virtualization)
    : normalizeVirtualization(current.virtualization);

  return {
    cpu_physical_cores: physicalCores,
    virtualization
  };
}

export async function persistServerStaticInfo(db, serverId, current = {}, metrics = {}) {
  if (!db || !serverId || (!hasOwn(metrics, 'cpu_physical_cores') && !hasOwn(metrics, 'virtualization'))) {
    return false;
  }

  const next = normalizeServerStaticInfo(metrics, current);
  const previous = normalizeServerStaticInfo({}, current);
  if (
    next.cpu_physical_cores === previous.cpu_physical_cores &&
    next.virtualization === previous.virtualization
  ) {
    return false;
  }

  const update = () => db.prepare(`
    UPDATE servers
    SET cpu_physical_cores = ?, virtualization = ?
    WHERE id = ?
  `).bind(next.cpu_physical_cores, next.virtualization, serverId).run();

  try {
    await update();
  } catch (error) {
    if (!/no such column|has no column/i.test(String(error?.message || error))) throw error;
    await addServerColumns(db);
    await update();
  }

  clearServersListCache();
  return true;
}
