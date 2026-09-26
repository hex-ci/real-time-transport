<script setup lang="ts">
/**
 * 通勤时段编辑器。
 *
 * 自足：它自己加载已保存的时段并 PATCH 回去，故父级只决定表单放在哪里，
 * 从不持有它的草稿状态。
 *
 * 表单要有四个起始值才可编辑，而什么都没存时它们是内置窗口——作为一个**显式命名**的内部
 * 参数，也就是地铁引擎对未陈述运营时段的线路所用的做法。命名了，也要在屏上说明：尚未保存
 * 过时段时表单在字段上方就这么说，故首次保存前的数字绝不会被呈现为用户自己的。
 *
 * 「没有任何已存时段」覆盖读取在无时段时的两种回答：未设置（完全没有记录）与未选择
 * （记录在——可能带锚点——而四个时刻为 NULL，从未被选过）。这句话是关于通勤时段的，
 * 故对两者都为真：这个用户确实从未保存过通勤时段。已存的时段仍然优先，而一次没人完成的
 * 读取两边都不主张。
 */
import { onMounted, shallowRef } from 'vue'
import { TriangleAlert } from '@lucide/vue'
import { DEFAULT_COMMUTE_HOURS, type UserSettings } from '@real-time-transport/shared'
import { settingsReadOf } from '../index-summary'

/**
 * 什么都没存时，编辑器以这四个时刻开场。
 *
 * 只有值——它们是本表单的起点，绝不作为已存时段报出。用户随后保存的内容会取代它们，
 * 而保存路径 PATCH 的是这份草稿。
 */
const EDITOR_STARTING_POINT: UserSettings = { ...DEFAULT_COMMUTE_HOURS }

const settingsDraft = shallowRef<UserSettings>({ ...EDITOR_STARTING_POINT })
const settingsSaving = shallowRef(false)
const settingsError = shallowRef<string | null>(null)
const settingsSaved = shallowRef(false)

/**
 * 四个时刻是否从未被保存过。`true` 是未设置/未选择——表单会陈述的事实；
 * `false` 是已存窗口；`null` 是「还没读到」，对此它两边都不说。
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
    // unset：什么都没存，故草稿保持起点，**并且**表单说明这些数字来自哪里。
    // unchosen：同理，只深一层——记录存在但从没有时刻被选过，故下面四个仍是编辑器
    // 自己的起点，而不是一份已存时段。unreadable：草稿保持原样，
    // 表单对已存记录两边都不主张。
    hoursNeverSaved.value = hours.state === 'unset' || hours.state === 'unchosen' ? true : null
  }
  catch {
    // 读取从未作答：关于已存记录一无所知，草稿是本表单自己的起点，
    // 而不是关于它的主张。
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
    // 时段现已保存，故表单不再说它们从未被保存过。
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
    <!-- 未设置 就在它所限定的那些数字旁陈述：在保存之前，下面四个是编辑器自己的起点，
         而在它们之上静默打开的表单，会是内置窗口穿着用户的衣服。 -->
    <p v-if="hoursNeverSaved === true" class="text-xs text-amber-400/90 lg:text-base">
      尚未保存过通勤时段：下面四个时刻是编辑器的起点，保存之后才会成为你的时段
    </p>
    <!-- 卡片占满宽度时（sm–lg）两列；窄进 xl 侧栏后一列。 -->
    <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-1">
      <!-- xl 侧栏硬性 20rem，一行放不下标签加两个 16px 原生时间输入，
           故自 xl 起该行折行、输入独占一行，而不是溢出卡片边框。 -->
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
