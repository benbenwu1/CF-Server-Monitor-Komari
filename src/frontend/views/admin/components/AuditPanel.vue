<template>
  <div id="tab-audit" class="tab-content" :class="{ active: activeTab === 'audit' }">
    <div class="settings-section">
      <div class="audit-panel-header">
        <div>
          <div class="section-title"><span>▸</span> {{ trans.auditLog }}</div>
          <p class="text-muted text-sm">{{ trans.auditRetentionHint }}</p>
        </div>
        <button type="button" class="btn" :disabled="loading" @click="$emit('refresh')">
          {{ loading ? '⏳' : '↻' }} {{ trans.refresh }}
        </button>
      </div>

      <div class="audit-controls">
        <label class="form-label" for="audit-event-filter">{{ trans.auditEventFilter }}</label>
        <select
          id="audit-event-filter"
          class="form-select"
          :value="eventType"
          :disabled="loading"
          @change="$emit('event-type-change', $event.target.value)"
        >
          <option value="">{{ trans.auditAllEvents }}</option>
          <option v-for="type in eventTypes" :key="type" :value="type">{{ type }}</option>
        </select>
      </div>

      <div class="table-wrapper audit-table-wrapper">
        <table class="terminal-table audit-table">
          <thead>
            <tr>
              <th>{{ trans.auditTime }}</th>
              <th>{{ trans.auditEvent }}</th>
              <th>{{ trans.auditOutcome }}</th>
              <th>{{ trans.auditActor }}</th>
              <th>{{ trans.auditTarget }}</th>
              <th>{{ trans.auditCount }}</th>
              <th>{{ trans.auditDetail }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="loading && events.length === 0">
              <td colspan="7" class="audit-empty">{{ trans.auditLoading }}</td>
            </tr>
            <tr v-else-if="events.length === 0">
              <td colspan="7" class="audit-empty">{{ trans.auditEmpty }}</td>
            </tr>
            <tr v-for="event in events" v-else :key="event.id">
              <td class="audit-time">{{ formatAuditTime(event.last_occurred_at || event.created_at) }}</td>
              <td><code>{{ event.event_type }}</code></td>
              <td>
                <span class="audit-outcome" :class="event.outcome === 'success' ? 'success' : 'failure'">
                  {{ formatOutcome(event.outcome) }}
                </span>
              </td>
              <td class="audit-actor">
                <span>{{ event.actor || '—' }}</span>
                <small v-if="event.ip_address">{{ event.ip_address }}</small>
              </td>
              <td>{{ formatTarget(event) }}</td>
              <td>{{ event.count || 1 }}</td>
              <td class="audit-detail">{{ formatAuditDetail(event.detail) }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="audit-pagination">
        <button
          type="button"
          class="btn"
          :disabled="loading || pagination.page <= 1"
          @click="$emit('page-change', pagination.page - 1)"
        >← {{ trans.auditPrevious }}</button>
        <span>
          {{ trans.auditPage }} {{ pagination.page }} / {{ Math.max(pagination.total_pages, 1) }}
          · {{ trans.total }} {{ pagination.total }}
        </span>
        <button
          type="button"
          class="btn"
          :disabled="loading || pagination.page >= pagination.total_pages"
          @click="$emit('page-change', pagination.page + 1)"
        >{{ trans.auditNext }} →</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { formatAuditDetail } from '../../../utils/audit.js'

const props = defineProps({
  trans: { type: Object, required: true },
  activeTab: { type: String, default: '' },
  events: { type: Array, default: () => [] },
  pagination: {
    type: Object,
    default: () => ({ page: 1, page_size: 20, total: 0, total_pages: 0 })
  },
  eventType: { type: String, default: '' },
  loading: { type: Boolean, default: false }
})

defineEmits(['refresh', 'event-type-change', 'page-change'])

const eventTypes = Object.freeze([
  'auth.login.success',
  'auth.login.failure',
  'admin.settings.update',
  'admin.server.create',
  'admin.server.update',
  'admin.server.delete',
  'admin.server.reorder',
  'admin.server.batch_delete',
  'admin.server.import',
  'admin.notification.test'
])

const formatAuditTime = (timestamp) => {
  const date = new Date(Number(timestamp))
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString()
}

const formatOutcome = (outcome) => {
  if (outcome === 'success') return props.trans.auditSuccess
  if (outcome === 'failure') return props.trans.auditFailure
  return outcome || '—'
}

const formatTarget = (event) => {
  const type = String(event?.target_type || '').trim()
  const id = String(event?.target_id || '').trim()
  if (type && id) return `${type} / ${id}`
  return type || id || '—'
}
</script>
