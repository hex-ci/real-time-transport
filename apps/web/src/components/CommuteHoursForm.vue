<script setup lang="ts">
/**
 * Commute-hours editor.
 *
 * Self-contained: it loads the saved hours and PATCHes them back, so the parent
 * only decides where the form sits (inside a Collapsible under the list, or bare
 * in the xl side rail) and never owns its draft state.
 */
import { onMounted, shallowRef } from 'vue'
import { TriangleAlert } from '@lucide/vue'
import type { UserSettings } from '@real-time-transport/shared'

const settingsDraft = shallowRef<UserSettings>({
  morningStart: '06:30',
  morningEnd: '11:30',
  eveningStart: '17:00',
  eveningEnd: '22:00',
})
const settingsSaving = shallowRef(false)
const settingsError = shallowRef<string | null>(null)
const settingsSaved = shallowRef(false)

onMounted(async () => {
  try {
    const res = await fetch('/api/transit/settings')
    const json = await res.json()
    if (json.success && json.data) {
      settingsDraft.value = json.data as UserSettings
    }
  }
  catch {
    // Keep defaults: a failed load must not fabricate a different schedule
  }
})

async function saveSettings(): Promise<void> {
  settingsSaving.value = true
  settingsError.value = null
  settingsSaved.value = false
  try {
    const res = await fetch('/api/transit/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settingsDraft.value),
    })
    const json = await res.json()
    if (!json.success) {
      throw new Error(json.error || '保存失败')
    }
    settingsDraft.value = json.data as UserSettings
    settingsSaved.value = true
  }
  catch (err) {
    settingsError.value = err instanceof Error ? err.message : '保存失败'
  }
  finally {
    settingsSaving.value = false
  }
}
</script>

<template>
  <div class="space-y-3">
    <p class="text-xs text-slate-500">
      用于自动切换「上班 / 下班 / 附近」视图，不参与方向判定
    </p>
    <!-- Two columns while the card spans the full width (sm–lg); one column once
         it narrows into the xl side rail. -->
    <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-1">
      <label class="flex min-h-[44px] items-center justify-between gap-2 rounded-xl border border-slate-800 bg-slate-950 px-3 py-2">
        <span class="flex shrink-0 items-center gap-1.5 text-xs text-slate-300">
          <span>🏠</span><span>早高峰</span>
        </span>
        <span class="flex items-center gap-1">
          <input
            v-model="settingsDraft.morningStart"
            type="time"
            class="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-white outline-none focus:border-cyan-500"
          >
          <span class="text-xs text-slate-500">—</span>
          <input
            v-model="settingsDraft.morningEnd"
            type="time"
            class="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-white outline-none focus:border-cyan-500"
          >
        </span>
      </label>
      <label class="flex min-h-[44px] items-center justify-between gap-2 rounded-xl border border-slate-800 bg-slate-950 px-3 py-2">
        <span class="flex shrink-0 items-center gap-1.5 text-xs text-slate-300">
          <span>🏢</span><span>晚高峰</span>
        </span>
        <span class="flex items-center gap-1">
          <input
            v-model="settingsDraft.eveningStart"
            type="time"
            class="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-white outline-none focus:border-cyan-500"
          >
          <span class="text-xs text-slate-500">—</span>
          <input
            v-model="settingsDraft.eveningEnd"
            type="time"
            class="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-white outline-none focus:border-cyan-500"
          >
        </span>
      </label>
    </div>
    <div class="flex flex-wrap items-center gap-3">
      <button
        class="min-h-[44px] rounded-xl border border-cyan-500/30 bg-cyan-500/10 px-4 text-xs font-semibold text-cyan-400 transition hover:bg-cyan-500/20 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
        :disabled="settingsSaving"
        @click="saveSettings"
      >
        {{ settingsSaving ? '保存中…' : '保存时段' }}
      </button>
      <span v-if="settingsSaved" class="text-xs text-emerald-400">已保存</span>
      <span v-if="settingsError" class="flex items-center gap-1.5 text-xs text-rose-400">
        <TriangleAlert class="h-3.5 w-3.5 shrink-0" />
        <span>{{ settingsError }}</span>
      </span>
    </div>
  </div>
</template>
