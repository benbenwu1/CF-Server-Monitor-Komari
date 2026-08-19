<template>
  <div class="settings-section">
    <div class="section-title"><span>▸</span> {{ trans.githubOauthTitle }}</div>
    <p class="text-muted text-sm">{{ trans.githubOauthHint }}</p>

    <div v-if="!available" class="warning-box mt-3">
      {{ trans.githubOauthUnavailable }}
    </div>
    <div v-else class="github-oauth-status mt-3">
      <div>
        <span class="session-badge" :class="bound ? 'online' : 'offline'">
          {{ bound ? trans.githubOauthBound : trans.githubOauthNotBound }}
        </span>
        <span v-if="bound && login" class="text-muted text-sm">@{{ login }}</span>
      </div>
      <button
        v-if="!bound"
        type="button"
        class="btn btn-primary"
        :disabled="busy"
        @click="$emit('bind')"
      >{{ busy ? '⏳' : 'GitHub' }} · {{ trans.githubOauthBind }}</button>
      <button
        v-else
        type="button"
        class="btn btn-red"
        :disabled="busy"
        @click="$emit('unbind')"
      >{{ busy ? '⏳' : '✕' }} {{ trans.githubOauthUnbind }}</button>
    </div>
  </div>
</template>

<script setup>
defineProps({
  trans: { type: Object, required: true },
  available: { type: Boolean, default: false },
  bound: { type: Boolean, default: false },
  login: { type: String, default: '' },
  busy: { type: Boolean, default: false }
})

defineEmits(['bind', 'unbind'])
</script>
