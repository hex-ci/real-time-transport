<script setup lang="ts">
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { MapPin } from '@lucide/vue'
import { useLocationStore } from '@/stores/location.store'

const { isSimulated, userCoords } = storeToRefs(useLocationStore())

/** Fixed position shown to four decimals — enough to recognise the spot. */
const coordsLabel = computed(() => {
  const c = userCoords.value
  if (!c) return ''
  return `${c.lat.toFixed(4)}, ${c.lng.toFixed(4)}`
})
</script>

<template>
  <!-- Development GPS override strip, mounted in the sticky header next to the
       data-simulation strip. Deliberately distinct in colour and wording: the
       vehicle data can be real while the position is not, and confusing the two
       would make a correct board look wrong. Not dismissible for the same
       reason — the nearby view's whole result depends on it. -->
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
