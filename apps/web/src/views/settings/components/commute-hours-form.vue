<script setup lang="ts">
/**
 * Commute-hours editor.
 *
 * Self-contained: it loads the saved hours and PATCHes them back, so the parent
 * only decides where the form sits (inside the 通勤时段 page's Collapsible, or bare
 * when that page is wide enough for it) and never owns its draft state.
 *
 * A form needs four starting values to be editable at all, and with nothing stored
 * they are the built-in window — as an EXPLICITLY NAMED internal parameter, the
 * pattern the subway engine uses for a line whose service hours nobody stated
 * (`serviceWindowSeconds`). Named, and stated on screen: while no hours are stored the
 * form says so above the fields, so the numbers before the first save are never
 * presented as the user's own. The alternative — opening silently on `06:30–11:30`
 * after a failed read — is the defect this state exists to remove.
 *
 * 「no hours are stored」 covers BOTH of the states a settings read can answer with no
 * hours: 未设置 (no row at all) and 未选择 (a row exists — it may carry anchors — and
 * its four times are NULL, never chosen since 009). The sentence is about 通勤时段, so
 * it is true of both: this user has indeed never saved commute hours. The stored hours
 * still win wherever they exist, and a read nobody completed claims nothing either way.
 */
import { onMounted, shallowRef } from 'vue'
import { TriangleAlert } from '@lucide/vue'
import { DEFAULT_COMMUTE_HOURS, type UserSettings } from '@real-time-transport/shared'
import { settingsReadOf } from '../index-summary'

/**
 * The four times this editor opens with when nothing is stored.
 *
 * Values only — they are this form's starting point, never reported as stored hours.
 * Whatever the user then saves replaces them, and the save path PATCHes the draft.
 */
const EDITOR_STARTING_POINT: UserSettings = { ...DEFAULT_COMMUTE_HOURS }

const settingsDraft = shallowRef<UserSettings>({ ...EDITOR_STARTING_POINT })
const settingsSaving = shallowRef(false)
const settingsError = shallowRef<string | null>(null)
const settingsSaved = shallowRef(false)

/**
 * Whether the four times were never saved. `true` is 未设置/未选择 — a fact the form
 * states; `false` is a stored window; `null` is 「还没读到」, about which it says nothing.
 */
const hoursNeverSaved = shallowRef<boolean | null>(null)

onMounted(async () => {
  try {
    const res = await fetch('/api/transit/settings')
    const json = await res.json()
    const hours = settingsReadOf(json).hours
    if (hours.state === 'read') {
      settingsDraft.value = hours.value
      hoursNeverSaved.value = false
      return
    }
    // unset: nothing is stored, so the draft keeps the starting point AND the form
    // says where those numbers come from. unchosen: the same, one level in — a row
    // exists but no hour of it was ever chosen, so the four below are still the
    // editor's own starting point rather than a stored schedule. unreadable: the draft
    // stays as it is and the form claims nothing about the stored row either way.
    hoursNeverSaved.value = hours.state === 'unset' || hours.state === 'unchosen' ? true : null
  }
  catch {
    // The read never answered: nothing about the stored row is known, and the draft
    // is this form's own starting point rather than a claim about it.
    hoursNeverSaved.value = null
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
    // The hours are stored now, so the form stops saying they were never saved.
    hoursNeverSaved.value = false
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
    <p class="text-xs text-slate-400 lg:text-base">
      用于自动切换「上班 / 下班 / 附近」视图，不参与方向判定
    </p>
    <!-- 未设置 is stated where the numbers it qualifies are: the four below are this
         editor's own starting point until something is saved, and a form that opened
         silently on them would be the built-in window wearing the user's clothes. -->
    <p v-if="hoursNeverSaved === true" class="text-xs text-amber-400/90 lg:text-base">
      尚未保存过通勤时段：下面四个时刻是编辑器的起点，保存之后才会成为你的时段
    </p>
    <!-- Two columns while the card spans the full width (sm–lg); one column once
         it narrows into the xl side rail. -->
    <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-1">
      <!-- The xl side rail is a hard 20rem, so a single line cannot hold the label
           plus two 16px native time inputs (needs ~344px against 252px of content).
           From xl the row wraps and the inputs take a line of their own instead of
           spilling past the card border. -->
      <label class="flex min-h-[44px] items-center justify-between gap-2 rounded-xl border border-slate-800 bg-slate-950 px-3 py-2 xl:min-w-0 xl:flex-wrap">
        <span class="flex shrink-0 items-center gap-1.5 text-xs text-slate-300 lg:text-base">
          <span>🏠</span><span>早高峰</span>
        </span>
        <span class="flex items-center gap-1 xl:w-full xl:min-w-0 xl:justify-between">
          <input
            v-model="settingsDraft.morningStart"
            type="time"
            class="min-w-0 rounded-lg border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-white outline-none focus:border-cyan-500 lg:px-2.5 lg:py-1.5 lg:text-base xl:flex-1"
          >
          <span class="shrink-0 text-xs text-slate-400">—</span>
          <input
            v-model="settingsDraft.morningEnd"
            type="time"
            class="min-w-0 rounded-lg border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-white outline-none focus:border-cyan-500 lg:px-2.5 lg:py-1.5 lg:text-base xl:flex-1"
          >
        </span>
      </label>
      <label class="flex min-h-[44px] items-center justify-between gap-2 rounded-xl border border-slate-800 bg-slate-950 px-3 py-2 xl:min-w-0 xl:flex-wrap">
        <span class="flex shrink-0 items-center gap-1.5 text-xs text-slate-300 lg:text-base">
          <span>🏢</span><span>晚高峰</span>
        </span>
        <span class="flex items-center gap-1 xl:w-full xl:min-w-0 xl:justify-between">
          <input
            v-model="settingsDraft.eveningStart"
            type="time"
            class="min-w-0 rounded-lg border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-white outline-none focus:border-cyan-500 lg:px-2.5 lg:py-1.5 lg:text-base xl:flex-1"
          >
          <span class="shrink-0 text-xs text-slate-400">—</span>
          <input
            v-model="settingsDraft.eveningEnd"
            type="time"
            class="min-w-0 rounded-lg border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-white outline-none focus:border-cyan-500 lg:px-2.5 lg:py-1.5 lg:text-base xl:flex-1"
          >
        </span>
      </label>
    </div>
    <div class="flex flex-wrap items-center gap-3">
      <button
        class="min-h-[44px] rounded-xl border border-cyan-500/30 bg-cyan-500/10 px-4 text-xs font-semibold text-cyan-400 transition hover:bg-cyan-500/20 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50 lg:px-5 lg:text-base"
        :disabled="settingsSaving"
        @click="saveSettings"
      >
        {{ settingsSaving ? '保存中…' : '保存时段' }}
      </button>
      <span v-if="settingsSaved" class="text-xs text-emerald-400">已保存</span>
      <span v-if="settingsError" class="flex items-center gap-1.5 text-xs text-rose-400 lg:gap-2 lg:text-base">
        <TriangleAlert class="h-3.5 w-3.5 shrink-0" />
        <span>{{ settingsError }}</span>
      </span>
    </div>
  </div>
</template>
