<script setup lang="ts">
import { computed } from 'vue'
import type { LineDetail, LiveLineStatus } from '@real-time-transport/shared'
import { operatingDaySecondsOf, operatingStatusOf, vehicleProvenanceOf } from '@real-time-transport/shared'
import { operatingBadgeOf } from '@/operating-copy'
import { provenanceLabelOf } from '@/provenance-copy'

const props = defineProps<{
  detail: LineDetail
  liveStatus: LiveLineStatus | null
  /** 地铁与公交的配色类，由视图解析（一处规则）。 */
  accent: { lineName: string, stops: string }
}>()

/**
 * F4：这个横幅所陈述的车辆读取是哪一种，取自应答的那个来源，而非线路类型。
 *
 * 用线路类型决定措辞只在线路时刻表引擎作答时才是同一个答案，聚合器一失效就错。
 * Null（还没有读取，或本构建不认识的来源）不渲染任何标记。
 */
const dataMark = computed(() => provenanceLabelOf(vehicleProvenanceOf(props.liveStatus?.dataSource)))

/**
 * F3：线路上是否真有车，取自载荷自己声明的来源——绝不从列表大小判定。
 *
 * 生成列车落在引擎内部的模拟窗口内，故非空列表本身不能说明线路在运行。
 */
const hasRealVehicle = computed(() =>
  (props.liveStatus?.buses.length ?? 0) > 0
  && vehicleProvenanceOf(props.liveStatus?.dataSource) === 'live')

/**
 * F3：线路的营运状态，取自头部上两行已经显示的首末班——「待发车/停运」曾用一个标签说两个相反的
 * 事实，且从不说清适用哪一个。
 *
 * 真的在途车辆压过排班，生成的车不能，故已知为未知的状态也保留它的说法。
 * 按调用时读取而非缓存进 computed：状态由墙上时钟与 props 共同导出，而时钟二者都不是响应式依赖；
 * 缓存会把上一次渲染读到的钟回递给后来的渲染。
 */
function operatingBadge(): string {
  return operatingBadgeOf(hasRealVehicle.value, operatingStatusOf({
    firstDeparture: props.detail.firstBusTime,
    lastDeparture: props.detail.lastBusTime,
    nowSecOfDay: operatingDaySecondsOf(),
  }))
}
</script>

<template>
  <div class="hidden md:block shrink-0 overflow-hidden rounded-3xl border border-slate-800 bg-gradient-to-b from-slate-900 via-slate-900 to-slate-950 p-5 shadow-xl">
    <div class="flex flex-col gap-2.5 md:flex-row md:items-center md:justify-between md:gap-4">
      <div class="flex items-center gap-2.5 sm:gap-3.5">
        <div
          class="flex h-11 shrink-0 items-center justify-center rounded-xl border px-3 font-mono font-black whitespace-nowrap sm:h-14 sm:rounded-2xl sm:px-3.5"
          :class="[
            accent.lineName,
            detail.lineName.length > 4 ? 'text-base min-w-[74px] sm:text-lg sm:min-w-[88px]' : detail.lineName.length > 3 ? 'text-lg min-w-[62px] sm:text-xl sm:min-w-[76px]' : 'text-xl min-w-[54px] sm:text-2xl sm:min-w-[64px]',
          ]"
        >
          {{ detail.lineName }}
        </div>
        <div class="min-w-0">
          <div class="flex items-center gap-2">
            <h2 class="min-w-0 truncate text-base font-bold text-white sm:text-2xl">
              {{ detail.directionName }}
            </h2>
            <span class="shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold border" :class="accent.stops">
              {{ detail.stops.length }} 站
            </span>
          </div>
          <p class="mt-0.5 text-xs text-slate-400 font-mono">
            首末班：{{ detail.firstBusTime || '--:--' }} - {{ detail.lastBusTime || '--:--' }}
            <span v-if="dataMark" class="ml-2 text-slate-400"><span aria-hidden="true">·</span> {{ dataMark }}</span>
          </p>
        </div>
      </div>

      <!-- 指标徽标 -->
      <div class="flex shrink-0 items-center gap-2 text-xs">
        <div class="flex flex-1 flex-col items-center rounded-xl border border-slate-800 bg-slate-950/80 px-3 py-1.5 sm:block sm:flex-none sm:px-3.5 sm:py-2">
          <span class="text-slate-400 block text-center text-xs leading-tight">当前在途</span>
          <span class="font-mono text-sm font-bold text-emerald-400 sm:text-base">
            {{ liveStatus?.buses.length || 0 }}
          </span>
          <span class="text-slate-400 text-xs leading-none"> 辆</span>
        </div>

        <div class="flex flex-1 flex-col items-center rounded-xl border border-slate-800 bg-slate-950/80 px-3 py-1.5 sm:block sm:flex-none sm:px-3.5 sm:py-2">
          <span class="text-slate-400 block text-center text-xs leading-tight">运行状态</span>
          <span
            class="font-mono text-xs font-semibold"
            :class="hasRealVehicle ? 'text-emerald-400' : 'text-slate-400'"
          >
            {{ operatingBadge() }}
          </span>
        </div>
      </div>
    </div>
  </div>
</template>
