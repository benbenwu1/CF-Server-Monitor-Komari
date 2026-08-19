<template>
  <div id="tab-database" class="tab-content" :class="{ active: activeTab === 'database' }">
    <div class="settings-section">
      <div class="section-title"><span>▸</span> {{ trans.dbManagement }}</div>

      <div class="settings-grid">
        <div class="form-group">
          <label class="form-label">{{ trans.upgradeDatabase }}</label>
          <p class="text-muted mb-2">{{ trans.upgradeDesc }}</p>
          <button @click="$emit('open-db-modal', 'upgrade')" class="btn btn-primary btn-lg" :disabled="dbLoading">⬆️ {{ trans.upgradeDatabase }}</button>
        </div>

        <div class="form-group">
          <label class="form-label danger-label">⚠️ {{ trans.clearHistory }}</label>
          <p class="text-muted mb-2">{{ trans.clearHistoryDesc }}</p>
          <button @click="$emit('open-db-modal', 'clearHistory')" class="btn btn-red btn-lg" :disabled="dbLoading">🗑️ {{ trans.clearHistory }}</button>
        </div>
      </div>
    </div>

    <div class="settings-section">
      <div class="section-title"><span>▸</span> {{ trans.logicalBackup }}</div>
      <div class="warning-box mb-3">
        {{ trans.logicalBackupPrivacyHint }}
      </div>

      <div class="settings-grid">
        <div class="form-group">
          <label class="form-label">{{ trans.logicalBackupDownload }}</label>
          <p class="text-muted mb-2">{{ trans.logicalBackupDownloadDesc }}</p>
          <button
            @click="handleLogicalBackupDownload"
            class="btn btn-primary btn-lg"
            :disabled="dbLoading || backupExporting"
          >
            {{ backupExporting ? trans.exporting : '📦 ' + trans.logicalBackupDownload }}
          </button>
        </div>

        <div class="form-group">
          <label class="form-label">{{ trans.logicalBackupR2 }}</label>
          <p class="text-muted mb-2">{{ trans.logicalBackupR2Desc }}</p>
          <p class="text-sm mb-2" :class="r2Available ? '' : 'text-muted'">
            {{ trans.logicalBackupR2Status }}:
            {{ backupStatusLoading
              ? trans.logicalBackupChecking
              : (r2Available ? trans.logicalBackupR2Available : trans.logicalBackupR2Unavailable) }}
          </p>
          <button
            @click="handleLogicalBackupR2"
            class="btn btn-lg"
            :disabled="dbLoading || backupStatusLoading || backupR2Saving || !r2Available"
          >
            {{ backupR2Saving ? trans.logicalBackupSaving : '☁️ ' + trans.logicalBackupSaveR2 }}
          </button>
        </div>
      </div>

      <div v-if="backupMessage" class="warning-box mt-3 text-sm">✅ {{ backupMessage }}</div>
      <div v-if="backupError" class="danger-box mt-3 text-sm">❌ {{ backupError }}</div>
    </div>

    <div class="settings-section">
      <div class="section-title"><span>▸</span> {{ trans.exportServers }} / {{ trans.importServers }}</div>

      <div class="settings-grid">
        <div class="form-group">
          <label class="form-label">{{ trans.exportServers }}</label>
          <p class="text-muted mb-2">{{ trans.exportServersDesc }}</p>
          <button @click="handleExport" class="btn btn-primary btn-lg" :disabled="dbLoading || exporting">
            {{ exporting ? trans.exporting : '📤 ' + trans.exportServers }}
          </button>
        </div>

        <div class="form-group">
          <label class="form-label">{{ trans.importServers }}</label>
          <p class="text-muted mb-2">{{ trans.importServersDesc }}</p>
          <input
            ref="fileInput"
            type="file"
            accept=".json"
            style="display: none"
            @change="handleFileSelect"
          />
          <button @click="$refs.fileInput.click()" class="btn btn-lg" :disabled="dbLoading || importing">
            {{ importing ? trans.importing : '📥 ' + trans.importServers }}
          </button>
        </div>
      </div>

      <div v-if="importResult" class="mt-3">
        <div :class="importResult.success ? 'warning-box' : 'danger-box'" class="mb-2">
          <div class="flex-center-gap-sm">
            <span :style="{ color: importResult.success ? 'var(--accent-green)' : 'var(--accent-red)', fontWeight: '600' }">
              {{ importResult.success ? '✅' : '❌' }} {{ trans.importResult }}
            </span>
          </div>
          <div class="mt-2 text-sm">
            <span style="color: var(--accent-green)">{{ trans.importedCount }}: {{ importResult.imported }}</span>
            <span class="ml-3" style="color: var(--accent-yellow)">{{ trans.skippedCount }}: {{ importResult.skipped }}</span>
          </div>
          <div v-if="importResult.skippedIds && importResult.skippedIds.length > 0" class="mt-2 text-sm text-muted">
            {{ trans.skippedIds }}: {{ importResult.skippedIds.join(', ') }}
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, watch } from 'vue'
import { adminApi } from '../../../utils/api'

const props = defineProps({
  trans: { type: Object, required: true },
  activeTab: { type: String, default: 'database' },
  dbLoading: { type: Boolean, default: false },
  selectedApiIndex: { type: Number, default: 0 }
})

defineEmits(['open-db-modal'])

const fileInput = ref(null)
const exporting = ref(false)
const importing = ref(false)
const importResult = ref(null)
const backupStatusLoading = ref(false)
const backupStatusLoaded = ref(false)
const backupExporting = ref(false)
const backupR2Saving = ref(false)
const r2Available = ref(false)
const backupMessage = ref('')
const backupError = ref('')
let backupStatusRequestId = 0

const resolveBackupError = (result, fallbackKey) => {
  const key = result?.error || fallbackKey
  return props.trans[key] || props.trans[fallbackKey] || key
}

const loadBackupStatus = async () => {
  if (backupStatusLoading.value || backupStatusLoaded.value) return
  const requestId = ++backupStatusRequestId
  const apiIndex = props.selectedApiIndex
  backupStatusLoading.value = true
  try {
    const result = await adminApi({ action: 'logical_backup_status' }, apiIndex)
    if (requestId !== backupStatusRequestId || apiIndex !== props.selectedApiIndex) return
    if (result.error) {
      backupError.value = resolveBackupError(result, 'logicalBackupStatusFailed')
      return
    }
    r2Available.value = result.data?.r2_available === true
    backupStatusLoaded.value = true
  } catch (error) {
    if (requestId !== backupStatusRequestId || apiIndex !== props.selectedApiIndex) return
    backupError.value = error?.message || props.trans.logicalBackupStatusFailed
  } finally {
    if (requestId === backupStatusRequestId) backupStatusLoading.value = false
  }
}

const handleLogicalBackupDownload = async () => {
  backupExporting.value = true
  backupMessage.value = ''
  backupError.value = ''
  try {
    const result = await adminApi({ action: 'logical_backup_export' }, props.selectedApiIndex)
    if (result.error || !result.data?.backup) {
      backupError.value = resolveBackupError(result, 'logicalBackupExportFailed')
      return
    }

    const backup = result.data.backup
    const timestamp = String(backup.manifest?.generated_at || new Date().toISOString())
      .replace(/[-:.]/g, '')
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `cfsm-config-${timestamp}.json`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
    backupMessage.value = props.trans.logicalBackupDownloaded
  } catch (error) {
    backupError.value = error?.message || props.trans.logicalBackupExportFailed
  } finally {
    backupExporting.value = false
  }
}

const handleLogicalBackupR2 = async () => {
  backupR2Saving.value = true
  backupMessage.value = ''
  backupError.value = ''
  try {
    const result = await adminApi({ action: 'logical_backup_r2_create' }, props.selectedApiIndex)
    if (result.error || !result.data?.object?.key) {
      backupError.value = resolveBackupError(result, 'logicalBackupR2Failed')
      if (result.error === 'logicalBackupR2Unavailable') {
        r2Available.value = false
      }
      return
    }
    backupMessage.value = `${props.trans.logicalBackupR2Stored}: ${result.data.object.key}`
  } catch (error) {
    backupError.value = error?.message || props.trans.logicalBackupR2Failed
  } finally {
    backupR2Saving.value = false
  }
}

watch(
  () => [props.activeTab, props.selectedApiIndex],
  ([activeTab], previous = []) => {
    const previousApiIndex = previous[1]
    if (previousApiIndex !== undefined && previousApiIndex !== props.selectedApiIndex) {
      backupStatusRequestId++
      backupStatusLoading.value = false
      backupStatusLoaded.value = false
      r2Available.value = false
      backupMessage.value = ''
      backupError.value = ''
    }
    if (activeTab === 'database') loadBackupStatus()
  },
  { immediate: true }
)

const handleExport = async () => {
  exporting.value = true
  importResult.value = null
  try {
    const result = await adminApi({ action: 'export_servers' }, props.selectedApiIndex)
    if (!result.error && result.data && result.data.servers) {
      const blob = new Blob([JSON.stringify(result.data.servers, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `servers-backup-${new Date().toISOString().slice(0, 10)}.json`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    }
  } catch (e) {
    console.error('Export failed:', e)
  } finally {
    exporting.value = false
  }
}

const handleFileSelect = async (event) => {
  const file = event.target.files[0]
  if (!file) return

  importing.value = true
  importResult.value = null

  try {
    const text = await file.text()
    const servers = JSON.parse(text)

    if (!Array.isArray(servers)) {
      importResult.value = { success: false, imported: 0, skipped: 0, skippedIds: [] }
      return
    }

    const result = await adminApi({ action: 'import_servers', servers }, props.selectedApiIndex)
    if (!result.error && result.data) {
      importResult.value = {
        success: result.data.success,
        imported: result.data.imported || 0,
        skipped: result.data.skipped || 0,
        skippedIds: result.data.skippedIds || []
      }
      if (result.data.imported > 0) {
        window.location.reload()
      }
    } else {
      importResult.value = { success: false, imported: 0, skipped: 0, skippedIds: [] }
    }
  } catch (e) {
    console.error('Import failed:', e)
    importResult.value = { success: false, imported: 0, skipped: 0, skippedIds: [] }
  } finally {
    importing.value = false
    if (fileInput.value) {
      fileInput.value.value = ''
    }
  }
}
</script>
