<script setup lang="ts">
/**
 * 位置锚点的**索引**：家 / 公司两行，每行整行可点进入那一页。
 *
 * 一行是整行 `<RouterLink>` 而非脚本跳转：语义、键盘可达与「在新标签页打开」都是浏览器原生的
 * （与设置索引同一条规则）。摘要文本在链接**内部** —— 行与它的状态不能各说一半。
 *
 * 摘要说**事实**，即这个锚点现在是什么样：有名字给名字、没名字给坐标、没有坐标就说「未设置」。
 * 措辞由 `anchors.ts` 的 `anchorSummaryOf` 拥有，故索引行与锚点页说的是同一件事。
 *
 * 三种读取状态（读取中 / 未读到 / 已读到）各自说自己的话：读不到时**不**说「未设置」——
 * 那是关于已存记录的主张，而这次读取根本没作答。
 */
import { computed, onMounted, shallowRef } from 'vue'
import { ChevronRight, TriangleAlert } from '@lucide/vue'
import { readingText, unreadText, type ReadValue } from '@/read-state'
import { ANCHOR_ENTRIES } from './anchor-catalog'
import { anchorSummaryOf, isAnchorSet, type StoredAnchors } from './anchors'
import { settingsReadOf } from './index-summary'
import { BackToSettings } from './components'

/** 已存锚点，以及这次读取自己的状态。 */
const anchors = shallowRef<ReadValue<StoredAnchors>>({ state: 'reading' })

/** 本页读的是「已保存的位置」，两种非读到状态都点名它。 */
const SUBJECT = '位置锚点'

/**
 * 两行，各带它自己的摘要。
 *
 * 摘要只在**读到**之后才是一个事实；另外两种状态各说读取自己。
 */
const rows = computed(() => ANCHOR_ENTRIES.map((entry) => {
  const read = anchors.value
  return {
    entry,
    to: `/settings/anchors/${entry.id}`,
    summary: read.state === 'reading'
      ? readingText(SUBJECT)
      : read.state === 'unreadable'
        ? unreadText(SUBJECT, '无法显示它们')
        : anchorSummaryOf(read.value, entry.id),
    // 未设置是一个**事实**（读到了、没有坐标），故它用一种更弱的字色；其余情况正常显示。
    unset: read.state === 'read' && !isAnchorSet(read.value, entry.id),
  }
}))

/** 读取失败时那句话旁边要给一个能改变答案的重试。 */
const loadFailed = computed(() => anchors.value.state === 'unreadable')

async function readAnchors(): Promise<void> {
  anchors.value = { state: 'reading' }
  try {
    const res = await fetch('/api/transit/settings')
    anchors.value = settingsReadOf(await res.json()).anchors
  }
  catch {
    anchors.value = { state: 'unreadable' }
  }
}

onMounted(() => {
  void readAnchors()
})
</script>

<template>
  <div class="mx-auto max-w-3xl space-y-6 pb-12">
    <BackToSettings />
    <div>
      <h2 class="text-xl font-bold text-white md:text-2xl">
        位置锚点
      </h2>
      <p class="mt-1 text-xs text-slate-400 lg:text-base">
        家与公司是步行到站台的起点，用于算「出门时间」
      </p>
    </div>

    <!-- 一个列表，每行一个链接，行自己的摘要**在该链接内部**。 -->
    <ul class="divide-y divide-slate-800/80 overflow-hidden rounded-3xl border border-slate-800 bg-slate-900/80 shadow-xl">
      <li v-for="row in rows" :key="row.to">
        <RouterLink
          :to="row.to"
          class="flex min-h-[44px] items-center gap-3 px-4 py-3.5 transition hover:bg-slate-950/60"
        >
          <component :is="row.entry.icon" class="h-4 w-4 shrink-0 text-cyan-400" aria-hidden="true" />
          <span class="min-w-0 flex-1">
            <span class="block text-sm font-semibold text-slate-200 lg:text-base">{{ row.entry.label }}</span>
            <!-- 长名字与长坐标都换行，绝不被截成一个看不出是哪个锚点的串。 -->
            <span
              class="mt-0.5 block text-xs break-words lg:text-base"
              :class="row.unset ? 'text-slate-400' : 'text-slate-300'"
            >
              {{ row.summary }}
            </span>
          </span>
          <ChevronRight class="h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
        </RouterLink>
      </li>
    </ul>

    <!-- 读不到就是读不到：这是它自己的成因，并带着唯一能修好它的重试。 -->
    <div
      v-if="loadFailed"
      class="flex flex-wrap items-center gap-2 rounded-xl border border-dashed border-rose-500/30 bg-rose-500/5 p-4"
    >
      <p class="flex items-center gap-1.5 text-xs text-rose-400 lg:text-base">
        <TriangleAlert class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>未读到已保存的位置，无法显示它们</span>
      </p>
      <button
        type="button"
        class="flex min-h-[44px] items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-950 px-3 text-xs text-slate-200 transition hover:border-cyan-500/40 active:scale-95 lg:text-base"
        @click="readAnchors"
      >
        重试
      </button>
    </div>
  </div>
</template>
