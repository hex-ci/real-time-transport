<script setup lang="ts">
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { MapPin } from '@lucide/vue'
import { useLocationStore } from '@/stores/location.store'

const { isSimulated, userCoords } = storeToRefs(useLocationStore())

const coordsLabel = computed(() => {
  const c = userCoords.value
  if (!c) return ''
  return `${c.lat.toFixed(4)}, ${c.lng.toFixed(4)}`
})
</script>

<template>
  <!-- 开发用 GPS 覆盖横幅：与车辆模拟横幅并列，颜色与措辞刻意区分（车辆数据可真、位置不可真）。同样不可关闭。 -->
  <div
    v-if="isSimulated"
    data-gps-simulation-banner
    role="status"
    aria-live="polite"
    class="flex items-center justify-center gap-2 border-b border-sky-500/40 bg-sky-500/15 px-3 py-1.5 text-sky-300"
  >
    <MapPin class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
    <span class="text-xs font-semibold tracking-wide">模拟定位</span>
    <span class="font-mono text-xs text-sky-400/80">{{ coordsLabel }}</span>
    <span class="hidden text-xs text-sky-400/80 sm:inline">
      · 仅位置为模拟值
    </span>
  </div>
</template>
