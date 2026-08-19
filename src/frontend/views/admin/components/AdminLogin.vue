<template>
  <div id="login-overlay" class="login-overlay">
    <div class="login-container">
      <div class="login-header">
        <div class="login-icon">🔐</div>
        <h2 class="login-title">{{ trans.adminLogin }}</h2>
        <p class="login-subtitle">{{ trans.enterCredentials }}</p>
      </div>
      <form @submit.prevent="$emit('login')">
        <div v-if="isMultipleMode && !oauthPending" class="login-form-group">
          <label class="login-label">{{ trans.apiEndpoint }}</label>
          <select :value="selectedApiIndex" class="login-input" @change="$emit('api-index-change', Number($event.target.value))">
            <option
              v-for="(base, index) in apiBases"
              :key="index"
              :value="index"
            >
              [{{ index }}] {{ base }}
            </option>
          </select>
        </div>
        <template v-if="!oauthPending">
          <div class="login-form-group">
            <label class="login-label">{{ trans.username }}</label>
            <input type="text" name="username" autocomplete="username" v-model="loginForm.username" required class="login-input" placeholder="admin">
          </div>
          <div class="login-form-group last">
            <label class="login-label">{{ trans.password }}</label>
            <div class="password-input-wrapper">
              <input :type="passwordVisible.login ? 'text' : 'password'" name="password" autocomplete="current-password" v-model="loginForm.password" required class="login-input" placeholder="••••••••">
              <button type="button" class="password-toggle" @click="$emit('toggle-password', 'login')">
                {{ passwordVisible.login ? '🙈' : '👁️' }}
              </button>
            </div>
          </div>
        </template>
        <div v-if="totpRequired" class="login-form-group">
          <label class="login-label">
            {{ useRecovery ? trans.totpRecoveryCode : trans.totpCode }}
          </label>
          <input
            v-if="!useRecovery"
            type="text"
            name="totp_code"
            inputmode="numeric"
            autocomplete="one-time-code"
            maxlength="6"
            pattern="[0-9]{6}"
            v-model.trim="loginForm.totp_code"
            required
            class="login-input"
            placeholder="123456"
          >
          <input
            v-else
            type="text"
            name="recovery_code"
            autocomplete="one-time-code"
            v-model.trim="loginForm.recovery_code"
            required
            class="login-input"
            placeholder="XXXX-XXXX-XXXX-XXXX"
          >
          <button type="button" class="btn btn-sm mt-2" @click="$emit('toggle-recovery')">
            {{ useRecovery ? trans.totpUseAuthenticator : trans.totpUseRecovery }}
          </button>
        </div>
        <div v-if="turnstileSiteKey && (turnstileLoginEnabled || (turnstileEnabled && !turnstileVerified))" class="login-form-group">
          <div id="admin-turnstile-container"></div>
        </div>
        <div v-if="loginError" id="login-error" class="login-error">{{ loginError }}</div>
        <button type="submit" class="login-btn">{{ loginLoading ? '⏳' : trans.login }}</button>
      </form>
      <template v-if="githubOauthAvailable && !oauthPending">
        <div class="login-separator"><span>{{ trans.githubOauthOr }}</span></div>
        <button
          type="button"
          class="login-btn github-login-btn"
          :disabled="loginLoading"
          @click="$emit('github-login')"
        >GitHub · {{ trans.githubOauthLogin }}</button>
      </template>
    </div>
    <Footer />
  </div>
</template>

<script setup>
import Footer from '../../../components/Footer.vue'

defineProps({
  trans: { type: Object, required: true },
  isMultipleMode: { type: Boolean, default: false },
  apiBases: { type: Array, default: () => [] },
  selectedApiIndex: { type: Number, default: 0 },
  loginForm: { type: Object, required: true },
  passwordVisible: { type: Object, required: true },
  loginError: { type: String, default: '' },
  loginLoading: { type: Boolean, default: false },
  githubOauthAvailable: { type: Boolean, default: false },
  oauthPending: { type: Boolean, default: false },
  totpRequired: { type: Boolean, default: false },
  useRecovery: { type: Boolean, default: false },
  turnstileSiteKey: { type: String, default: '' },
  turnstileLoginEnabled: { type: Boolean, default: false },
  turnstileEnabled: { type: Boolean, default: false },
  turnstileVerified: { type: Boolean, default: false }
})

defineEmits(['login', 'github-login', 'toggle-password', 'api-index-change', 'toggle-recovery'])
</script>
