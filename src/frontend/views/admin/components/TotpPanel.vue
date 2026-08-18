<template>
  <div class="settings-section">
    <div class="section-title"><span>▸</span> {{ trans.totpTitle }}</div>
    <p class="text-muted text-sm">{{ trans.totpHint }}</p>

    <div v-if="!available" class="alert alert-warning mt-3">
      {{ trans.totpUnavailable }} <code>wrangler secret put TOTP_ENCRYPTION_KEY</code>
    </div>

    <template v-if="recoveryCodes.length">
      <div class="alert alert-warning mt-3">{{ trans.totpRecoveryWarning }}</div>
      <div class="session-recovery-codes">
        <code v-for="recoveryCode in recoveryCodes" :key="recoveryCode">{{ recoveryCode }}</code>
      </div>
      <button type="button" class="btn mt-3" @click="$emit('acknowledge-recovery')">
        {{ trans.totpRecoverySaved }}
      </button>
    </template>

    <template v-else-if="enabled">
      <p class="text-green mt-3">● {{ trans.totpEnabled }}</p>
      <div class="form-row mt-3">
        <div class="form-group flex-1">
          <label class="form-label">{{ trans.totpDisableCode }}</label>
          <input
            v-model.trim="code"
            class="form-input"
            autocomplete="one-time-code"
            :placeholder="trans.totpCodeOrRecovery"
          >
        </div>
        <div class="form-group form-group-action">
          <button type="button" class="btn btn-red" :disabled="busy || !code" @click="disableTotp">
            {{ busy ? '⏳' : '✕' }} {{ trans.totpDisable }}
          </button>
        </div>
      </div>
    </template>

    <template v-else-if="setup">
      <div class="form-group mt-3">
        <label class="form-label">{{ trans.totpManualSecret }}</label>
        <code class="session-secret-code">{{ setup.secret }}</code>
      </div>
      <div class="form-group">
        <label class="form-label">{{ trans.totpProvisioningUri }}</label>
        <textarea class="form-input" rows="3" readonly :value="setup.otpauth_uri"></textarea>
      </div>
      <div class="form-row">
        <div class="form-group flex-1">
          <label class="form-label">{{ trans.totpConfirmCode }}</label>
          <input
            v-model.trim="code"
            class="form-input"
            inputmode="numeric"
            maxlength="6"
            autocomplete="one-time-code"
            placeholder="123456"
          >
        </div>
        <div class="form-group form-group-action">
          <button type="button" class="btn btn-primary" :disabled="busy || !/^\d{6}$/.test(code)" @click="confirmTotp">
            {{ busy ? '⏳' : '✓' }} {{ trans.totpConfirm }}
          </button>
        </div>
      </div>
    </template>

    <button
      v-else
      type="button"
      class="btn btn-primary mt-3"
      :disabled="busy || !available"
      @click="$emit('setup')"
    >{{ busy ? '⏳' : '+' }} {{ trans.totpSetup }}</button>
  </div>
</template>

<script setup>
import { ref, watch } from 'vue'

const props = defineProps({
  trans: { type: Object, required: true },
  enabled: { type: Boolean, default: false },
  available: { type: Boolean, default: false },
  setup: { type: Object, default: null },
  recoveryCodes: { type: Array, default: () => [] },
  busy: { type: Boolean, default: false }
})

const emit = defineEmits(['setup', 'confirm', 'disable', 'acknowledge-recovery'])
const code = ref('')

watch(() => [props.enabled, props.setup], () => {
  code.value = ''
})

const confirmTotp = () => emit('confirm', code.value)
const disableTotp = () => emit('disable', code.value)
</script>
