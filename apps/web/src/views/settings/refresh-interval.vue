<script setup lang="ts">
/**
 * 实时刷新间隔：驱动整条实时节拍链的那个秒数 —— 服务端轮询间隔、WS 推送节拍、
 * 聚合器实时缓存 TTL、手动刷新冷却窗口，四者同源。
 *
 * 自足：自己加载已保存的值并 PATCH 回去。预设档位而非自由输入：下限 10 秒是保护
 * 上游（车来了 H5 是非公开接口，刷太快有被限流封 IP 的风险），上限 120 秒避免
 * 数据 stale 到失去意义。保存后服务端即时生效，不用重启。
 *
 * null 即"没选过"，读侧回退 18s：表单在未保存过时明确说出起点是 18 秒，
 * 而不是把 18 印成用户自己的选择。
 */
import { computed, onMounted, shallowRef } from 'vue'
import { runWithFeedback } from '@/action-feedback'
import { BackToSettings } from './components'

const PRESETS = [10, 15, 18, 30, 60] as const
const DEFAULT_SEC = 18

const selected = shallowRef<number | null>(null)
const everSaved = shallowRef<boolean | null>(null)
const saving = shallowRef(false)

const summary = computed(() =>
  everSaved.value === false
    ? `当前：未设置（默认每 ${DEFAULT_SEC} 秒）`
    : `当前：每 ${selected.value ?? DEFAULT_SEC} 秒`,
)

onMounted(async () => {
  try {
    const res = await fetch('/api/transit/settings')
    const json = await res.json()
    const v = json?.data?.refreshIntervalSec
    if (typeof v === 'number' && Number.isFinite(v)) {
      selected.value = v
      everSaved.value = true
    }
    else {
      // 没存过：18 秒只是编辑器的起点，不是用户的选择（见上面的说明）。
      selected.value = DEFAULT_SEC
      everSaved.value = false
    }
  }
  catch {
    everSaved.value = null
  }
})

async function save(): Promise<void> {
  if (selected.value === null || saving.value) return
  saving.value = true
  try {
    await runWithFeedback('refresh-interval-save', async () => {
      const res = await fetch('/api/transit/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshIntervalSec: selected.value }),
      })
      const json = await res.json()
      if (!json.success) {
        throw new Error(json.error || '保存失败')
      }
      everSaved.value = true
    })
  }
  catch {
    // 原因已由 toast 说过；这里只是接住重抛，别让它变成未处理的拒绝。
  }
  finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="mx-auto max-w-2xl space-y-6 pb-12">
    <BackToSettings />
    <div>
      <h2 class="text-xl font-bold text-white md:text-2xl">
        实时刷新间隔
      </h2>
      <p class="mt-1 text-xs text-slate-400 lg:text-base">
        {{ summary }}。保存后立即生效，不用重启服务。
      </p>
    </div>

    <div class="rounded-3xl border border-slate-800 bg-slate-900/80 p-4 shadow-xl lg:p-5">
      <p class="text-xs text-slate-400 lg:text-base">
        决定服务端多久向车来了拉一次实时数据 —— 报站板、到站预估、车辆动画的新鲜度都跟它走。
        间隔越短越实时，但上游是非公开接口，10 秒是保护下限。
      </p>
      <p v-if="everSaved === false" class="mt-2 text-xs text-amber-400/90 lg:text-base">
        尚未保存过：下面选中的 {{ DEFAULT_SEC }} 秒只是起点，保存之后才会成为你的设置
      </p>

      <div class="mt-4 flex flex-wrap gap-2">
        <button
          v-for="sec in PRESETS"
          :key="sec"
          type="button"
          :aria-pressed="selected === sec"
          class="inline-flex min-h-11 items-center rounded-lg border px-3 text-xs font-medium transition active:scale-95"
          :class="selected === sec
            ? 'border-cyan-500/60 bg-cyan-500/15 text-cyan-200'
            : 'border-slate-700 bg-slate-950 text-slate-300 hover:border-cyan-500/40'"
          @click="selected = sec"
        >
          {{ sec }} 秒
        </button>
      </div>

      <div class="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          class="min-h-[44px] rounded-xl border border-cyan-500/30 bg-cyan-500/10 px-4 text-xs font-semibold text-cyan-400 transition hover:bg-cyan-500/20 active:scale-95 lg:px-5 lg:text-base"
          :disabled="saving"
          @click="save"
        >
          {{ saving ? '保存中…' : '保存' }}
        </button>
      </div>
    </div>
  </div>
</template>
