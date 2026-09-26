<script setup lang="ts">
/**
 * 通勤时段：通勤上下文适配的早晚两个窗口。
 *
 * 折叠摘要在本页读取、由 `index-summary.ts` 措辞——与索引行是同一条规则，故一条已存记录
 * 不会被说成两个不同的时段。读失败说「未读到」；没有记录、或四个时刻从未被选过
 * （自 009 起为 NULL）都说「未设置」，因为两种情形对用户是同一件事：我还没设过。
 * 两者由 `settingsReadOf` 分开，故下游绝不会把 null 印成一个时刻。
 *
 * 自动展开/折叠仍跟随同一个断点：xl 以上有地方放表单故保持展开，以下折叠。
 */
import { computed, onMounted, shallowRef, watch } from 'vue'
import { useMediaQuery } from '@vueuse/core'
import { BackToSettings, CommuteHoursCard } from './components'
import { hoursText, settingsReadOf, type SettingsSummaryValue } from './index-summary'
import type { UserSettings } from '@real-time-transport/shared'

/** 已保存的时段，处于其读取留下的某种状态。 */
const savedHours = shallowRef<SettingsSummaryValue<UserSettings>>({ state: 'reading' })

const summary = computed(() => hoursText(savedHours.value))

onMounted(async () => {
  try {
    const res = await fetch('/api/transit/settings')
    const json = await res.json()
    savedHours.value = settingsReadOf(json).hours
  }
  catch {
    // 失败就保持为失败：此处给默认值会看起来像用户自己设的时段。
    savedHours.value = { state: 'unreadable' }
  }
})

/**
 * 通勤时段：内容旁有地方放表单时展开（那里折叠只多一次点击），在此之下折叠（那里高度要紧）。
 */
const hoursExpanded = shallowRef(false)
const isSideRail = useMediaQuery('(min-width: 1280px)')

watch(isSideRail, (wide) => {
  // 只有自动值跟随断点；某种布局内的手动切换，
  // 在布局本身改变之前都被尊重。
  hoursExpanded.value = wide
}, { immediate: true })
</script>

<template>
  <div class="mx-auto max-w-3xl space-y-6 pb-12">
    <BackToSettings />
    <h2 class="text-xl font-bold text-white md:text-2xl">
      通勤时段
    </h2>

    <CommuteHoursCard
      v-model:expanded="hoursExpanded"
      :is-side-rail="isSideRail"
      :summary="summary"
    />
  </div>
</template>
