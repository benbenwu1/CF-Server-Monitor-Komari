<template>
  <div id="tab-sessions" class="tab-content" :class="{ active: activeTab === 'sessions' }">
    <div class="settings-section">
      <div class="session-panel-header">
        <div>
          <div class="section-title"><span>▸</span> {{ trans.sessions }}</div>
          <p class="text-muted text-sm">{{ trans.sessionHint }}</p>
        </div>
        <button type="button" class="btn" :disabled="loading || mutationActive" @click="$emit('refresh-list')">
          {{ loading ? '⏳' : '↻' }} {{ trans.refresh }}
        </button>
      </div>

      <div class="table-wrapper session-table-wrapper">
        <table class="terminal-table session-table">
          <thead>
            <tr>
              <th>{{ trans.sessionDevice }}</th>
              <th>{{ trans.sessionMethod }}</th>
              <th>{{ trans.sessionIp }}</th>
              <th>{{ trans.sessionLastSeen }}</th>
              <th>{{ trans.sessionExpires }}</th>
              <th>{{ trans.sessionStatus }}</th>
              <th>{{ trans.actions }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="loading && sessions.length === 0">
              <td colspan="7" class="session-empty">{{ trans.sessionLoading }}</td>
            </tr>
            <tr v-else-if="sessions.length === 0">
              <td colspan="7" class="session-empty">{{ trans.sessionEmpty }}</td>
            </tr>
            <tr v-for="session in sessions" v-else :key="session.id">
              <td class="session-device">
                <span>{{ session.user_agent || trans.sessionUnknownDevice }}</span>
                <small>{{ formatSessionTime(session.created_at) }}</small>
              </td>
              <td><code>{{ session.auth_method || '—' }}</code></td>
              <td class="session-ip">
                <span>{{ trans.sessionLastIp }}: {{ session.last_ip || '—' }}</span>
                <small>{{ trans.sessionFirstIp }}: {{ session.first_ip || '—' }}</small>
              </td>
              <td>{{ formatSessionTime(session.last_seen_at) }}</td>
              <td>{{ formatSessionTime(session.expires_at) }}</td>
              <td>
                <div class="session-badges">
                  <span v-if="session.current" class="session-badge current">{{ trans.sessionCurrent }}</span>
                  <span class="session-badge" :class="session.online ? 'online' : 'offline'">
                    {{ session.online ? trans.online : trans.offline }}
                  </span>
                </div>
              </td>
              <td>
                <button
                  v-if="session.current"
                  type="button"
                  class="btn btn-sm"
                  :disabled="mutationActive"
                  @click="$emit('refresh-current')"
                >{{ refreshing ? '⏳' : '↻' }} {{ trans.sessionRefresh }}</button>
                <button
                  v-else
                  type="button"
                  class="btn btn-sm btn-red"
                  :disabled="mutationActive"
                  @click="$emit('revoke', session.id)"
                >{{ revokingSessionId === session.id ? '⏳' : '✕' }} {{ trans.sessionRevoke }}</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
    <slot />
  </div>
</template>

<script setup>
defineProps({
  trans: { type: Object, required: true },
  activeTab: { type: String, default: '' },
  sessions: { type: Array, default: () => [] },
  loading: { type: Boolean, default: false },
  refreshing: { type: Boolean, default: false },
  revokingSessionId: { type: String, default: '' },
  mutationActive: { type: Boolean, default: false }
})

defineEmits(['refresh-list', 'refresh-current', 'revoke'])

const formatSessionTime = (timestamp) => {
  const date = new Date(Number(timestamp))
  return Number.isNaN(date.getTime()) || Number(timestamp) <= 0 ? '—' : date.toLocaleString()
}
</script>
