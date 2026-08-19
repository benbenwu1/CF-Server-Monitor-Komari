<template>
  <div id="tab-ping-tasks" class="tab-content" :class="{ active: activeTab === 'pingTasks' }">
    <div class="settings-section">
      <div class="section-title ping-task-title">
        <span><span>▸</span> {{ trans.pingTasks }}</span>
        <button class="btn" :disabled="loading || saving" @click="loadTasks">↻ {{ trans.refresh }}</button>
      </div>
      <p class="text-muted mb-3">{{ trans.pingTaskHint }}</p>

      <div v-if="error" class="danger-box mb-3">{{ errorText }}</div>
      <div v-if="loading" class="table-empty-state">{{ trans.pingTaskLoading }}</div>
      <div v-else-if="tasks.length === 0" class="table-empty-state">{{ trans.pingTaskEmpty }}</div>

      <div v-else class="ping-task-list">
        <article v-for="(task, index) in tasks" :key="task.id" class="ping-task-card">
          <div class="ping-task-card-main">
            <div>
              <div class="ping-task-name">
                <span class="status-dot" :class="task.enabled ? 'online' : 'offline'"></span>
                {{ task.name }}
                <span class="ping-task-kind">{{ task.type.toUpperCase() }}</span>
              </div>
              <div class="ping-task-target">{{ task.target }}</div>
              <div class="ping-task-meta">
                {{ task.interval_seconds }}s · {{ task.timeout_ms }}ms ·
                {{ trans.pingTaskAssigned }} {{ task.server_ids.length }}
                <span v-if="task.apply_to_new_servers">· {{ trans.pingTaskApplyNew }}</span>
              </div>
            </div>
            <div class="ping-task-actions">
              <button class="btn btn-sm" :disabled="saving || index === 0" @click="moveTask(index, -1)">↑</button>
              <button class="btn btn-sm" :disabled="saving || index === tasks.length - 1" @click="moveTask(index, 1)">↓</button>
              <button class="btn btn-sm" :disabled="saving" @click="openEdit(task)">{{ trans.edit }}</button>
              <button class="btn btn-sm" :disabled="saving || task.server_ids.length === 0" @click="toggleHistory(task)">{{ trans.pingTaskHistory }}</button>
              <button class="btn btn-red btn-sm" :disabled="saving" @click="removeTask(task)">{{ trans.delete }}</button>
            </div>
          </div>

          <div v-if="historyTaskId === task.id" class="ping-task-history">
            <div class="ping-task-history-toolbar">
              <label class="form-label">{{ trans.pingTaskServer }}</label>
              <select v-model="historyServerId" class="form-select" @change="loadHistory(task)">
                <option v-for="serverId in task.server_ids" :key="serverId" :value="serverId">
                  {{ serverName(serverId) }}
                </option>
              </select>
            </div>
            <div v-if="historyLoading" class="text-muted">{{ trans.loading }}</div>
            <div v-else-if="historyResults.length === 0" class="text-muted">{{ trans.pingTaskNoHistory }}</div>
            <div v-else class="ping-task-history-summary">
              <span>{{ trans.pingTaskLatest }}: <b>{{ formatResult(historyResults.at(-1)) }}</b></span>
              <span>{{ trans.pingTaskSuccessRate }}: <b>{{ successRate }}%</b></span>
              <span>{{ trans.pingTaskAverage }}: <b>{{ averageLatency }}</b></span>
            </div>
          </div>
        </article>
      </div>
    </div>

    <div class="settings-section">
      <div class="section-title"><span>▸</span> {{ form.id ? trans.pingTaskEdit : trans.pingTaskCreate }}</div>
      <div class="ping-task-form-grid">
        <div class="form-group ping-task-span-2">
          <label class="form-label">{{ trans.pingTaskName }}</label>
          <input v-model.trim="form.name" class="form-input" />
        </div>
        <div class="form-group">
          <label class="form-label">{{ trans.pingTaskType }}</label>
          <select v-model="form.type" class="form-select">
            <option value="icmp">ICMP</option>
            <option value="tcp">TCP</option>
            <option value="http">HTTP(S)</option>
          </select>
        </div>
        <div class="form-group ping-task-span-2">
          <label class="form-label">{{ trans.pingTaskTarget }}</label>
          <input v-model.trim="form.target" class="form-input" maxlength="255" :placeholder="targetPlaceholder" />
        </div>
        <div class="form-group">
          <label class="form-label">{{ trans.pingTaskInterval }}</label>
          <input v-model.number="form.interval_seconds" class="form-input" type="number" min="60" max="86400" step="60" />
        </div>
        <div class="form-group">
          <label class="form-label">{{ trans.pingTaskTimeout }}</label>
          <input v-model.number="form.timeout_ms" class="form-input" type="number" min="500" max="10000" step="500" />
        </div>
      </div>

      <div class="ping-task-options">
        <label class="checkbox-label"><input v-model="form.enabled" type="checkbox" /> {{ trans.pingTaskEnabled }}</label>
        <label class="checkbox-label"><input v-model="form.apply_to_new_servers" type="checkbox" /> {{ trans.pingTaskApplyNew }}</label>
      </div>

      <div class="form-group mt-3">
        <label class="form-label">{{ trans.pingTaskServers }}</label>
        <div class="ping-task-server-grid">
          <label v-for="server in servers" :key="server.id" class="checkbox-label ping-task-server-option">
            <input v-model="form.server_ids" type="checkbox" :value="server.id" />
            <span>{{ server.name || server.id }}</span>
          </label>
        </div>
        <p class="text-muted mt-2">{{ trans.pingTaskLimitHint }}</p>
      </div>

      <div class="ping-task-form-actions">
        <button class="btn btn-primary" :disabled="saving" @click="saveTask">
          {{ saving ? trans.saving : (form.id ? trans.save : trans.pingTaskCreate) }}
        </button>
        <button v-if="form.id" class="btn" :disabled="saving" @click="resetForm">{{ trans.cancel }}</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, reactive, ref, watch } from 'vue'
import { adminApi } from '../../../utils/api.js'
import { http } from '../../../utils/http.js'

const props = defineProps({
  trans: { type: Object, required: true },
  activeTab: { type: String, default: '' },
  servers: { type: Array, default: () => [] },
  selectedApiIndex: { type: Number, default: 0 }
})

const emptyForm = () => ({
  id: '',
  name: '',
  type: 'icmp',
  target: '',
  interval_seconds: 300,
  timeout_ms: 3000,
  enabled: true,
  apply_to_new_servers: false,
  server_ids: []
})

const tasks = ref([])
const loading = ref(false)
const saving = ref(false)
const error = ref('')
const loaded = ref(false)
const form = reactive(emptyForm())
const historyTaskId = ref('')
const historyServerId = ref('')
const historyResults = ref([])
const historyLoading = ref(false)

const errorText = computed(() => props.trans[error.value] || error.value)
const targetPlaceholder = computed(() => form.type === 'http'
  ? 'https://example.com/health'
  : form.type === 'tcp' ? 'example.com:443' : 'example.com')
const successfulResults = computed(() => historyResults.value.filter(item => item.success && Number.isFinite(item.latency_ms)))
const successRate = computed(() => historyResults.value.length
  ? Math.round(successfulResults.value.length * 100 / historyResults.value.length)
  : 0)
const averageLatency = computed(() => successfulResults.value.length
  ? `${Math.round(successfulResults.value.reduce((sum, item) => sum + item.latency_ms, 0) / successfulResults.value.length)} ms`
  : 'N/A')

const serverName = (id) => props.servers.find(server => server.id === id)?.name || id
const formatResult = (result) => result?.success ? `${result.latency_ms} ms` : props.trans.timeout

const resetForm = () => Object.assign(form, emptyForm())

const loadTasks = async () => {
  loading.value = true
  error.value = ''
  try {
    const result = await adminApi({ action: 'ping_task_list' }, props.selectedApiIndex)
    if (result.error) {
      error.value = String(result.error)
      return
    }
    tasks.value = Array.isArray(result.data?.tasks) ? result.data.tasks : []
    loaded.value = true
  } finally {
    loading.value = false
  }
}

const openEdit = (task) => {
  Object.assign(form, {
    id: task.id,
    name: task.name,
    type: task.type,
    target: task.target,
    interval_seconds: task.interval_seconds,
    timeout_ms: task.timeout_ms,
    enabled: task.enabled,
    apply_to_new_servers: task.apply_to_new_servers,
    server_ids: [...task.server_ids]
  })
}

const saveTask = async () => {
  error.value = ''
  if ([...form.name].length > 100) {
    error.value = 'invalidPingTaskName'
    return
  }
  if (!form.name || !form.target || (form.server_ids.length === 0 && !form.apply_to_new_servers)) {
    error.value = 'pingTaskRequired'
    return
  }
  saving.value = true
  try {
    const result = await adminApi({
      action: form.id ? 'ping_task_update' : 'ping_task_create',
      ...form,
      server_ids: [...form.server_ids]
    }, props.selectedApiIndex)
    if (result.error) {
      error.value = String(result.error)
      return
    }
    resetForm()
    await loadTasks()
  } finally {
    saving.value = false
  }
}

const removeTask = async (task) => {
  if (!window.confirm(props.trans.pingTaskDeleteConfirm)) return
  saving.value = true
  error.value = ''
  try {
    const result = await adminApi({ action: 'ping_task_delete', id: task.id }, props.selectedApiIndex)
    if (result.error) {
      error.value = String(result.error)
      return
    }
    if (form.id === task.id) resetForm()
    await loadTasks()
  } finally {
    saving.value = false
  }
}

const moveTask = async (index, offset) => {
  const next = [...tasks.value]
  const target = index + offset
  if (target < 0 || target >= next.length) return
  ;[next[index], next[target]] = [next[target], next[index]]
  saving.value = true
  try {
    const result = await adminApi({ action: 'ping_task_reorder', ids: next.map(task => task.id) }, props.selectedApiIndex)
    if (result.error) error.value = String(result.error)
    else tasks.value = result.data?.tasks || next
  } finally {
    saving.value = false
  }
}

const loadHistory = async (task) => {
  if (!historyServerId.value) return
  historyLoading.value = true
  historyResults.value = []
  try {
    const query = new URLSearchParams({ task_id: task.id, server_id: historyServerId.value, hours: '24' })
    const result = await http.getByIndex(`/api/ping-history?${query}`, props.selectedApiIndex, { autoRedirect: false })
    if (result.error) error.value = String(result.error)
    else historyResults.value = result.data?.results || []
  } finally {
    historyLoading.value = false
  }
}

const toggleHistory = async (task) => {
  if (historyTaskId.value === task.id) {
    historyTaskId.value = ''
    return
  }
  historyTaskId.value = task.id
  historyServerId.value = task.server_ids[0] || ''
  await loadHistory(task)
}

watch(() => props.activeTab, (tab) => {
  if (tab === 'pingTasks' && !loaded.value) void loadTasks()
})

watch(() => props.selectedApiIndex, () => {
  tasks.value = []
  loaded.value = false
  historyTaskId.value = ''
  resetForm()
  if (props.activeTab === 'pingTasks') void loadTasks()
})
</script>

<style scoped>
.ping-task-title,
.ping-task-card-main,
.ping-task-actions,
.ping-task-options,
.ping-task-form-actions,
.ping-task-history-summary,
.ping-task-history-toolbar {
  display: flex;
  align-items: center;
  gap: .65rem;
}
.ping-task-title,
.ping-task-card-main { justify-content: space-between; }
.ping-task-list { display: grid; gap: .75rem; }
.ping-task-card { border: 1px solid var(--border-color); border-radius: 8px; padding: 1rem; background: var(--bg-secondary); }
.ping-task-name { font-weight: 700; display: flex; align-items: center; gap: .45rem; }
.ping-task-kind { color: var(--accent-cyan); font-size: .75rem; border: 1px solid currentColor; border-radius: 999px; padding: .05rem .4rem; }
.ping-task-target { margin-top: .3rem; font-family: monospace; word-break: break-all; }
.ping-task-meta { margin-top: .35rem; color: var(--text-muted); font-size: .82rem; }
.ping-task-actions { flex-wrap: wrap; justify-content: flex-end; }
.ping-task-form-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 1rem; }
.ping-task-span-2 { grid-column: span 2; }
.ping-task-options { margin-top: 1rem; flex-wrap: wrap; }
.ping-task-server-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: .55rem; }
.ping-task-server-option { border: 1px solid var(--border-color); border-radius: 6px; padding: .55rem .7rem; }
.ping-task-form-actions { margin-top: 1rem; }
.ping-task-history { border-top: 1px solid var(--border-color); margin-top: .8rem; padding-top: .8rem; }
.ping-task-history-toolbar { max-width: 420px; }
.ping-task-history-summary { flex-wrap: wrap; margin-top: .7rem; }
.status-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; background: var(--accent-red); }
.status-dot.online { background: var(--accent-green); }
@media (max-width: 760px) {
  .ping-task-card-main { align-items: flex-start; flex-direction: column; }
  .ping-task-actions { justify-content: flex-start; }
  .ping-task-form-grid { grid-template-columns: 1fr; }
  .ping-task-span-2 { grid-column: span 1; }
}
</style>
