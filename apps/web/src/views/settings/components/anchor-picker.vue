<script setup lang="ts">
/**
 * Home / work anchor picker — the origin of the walking time F1 measures.
 *
 * Two buttons, each taking ONE current-position fix and PATCHing it to
 * `/api/transit/settings`. Deliberately no map picking: that needs a
 * browser-side JS API key, and our Amap key is a Web-service key that must never
 * reach the browser (`rule 4`).
 *
 * The fix leaves this component exactly as `navigator.geolocation` reported it —
 * WGS-84, converted by nobody. The server converts it once at the PATCH boundary
 * and stores GCJ-02. What is rendered here is what the SERVER returned, so the
 * screen can never claim a coordinate the stored row does not hold.
 */
import { computed, onMounted, shallowRef } from 'vue'
import { storeToRefs } from 'pinia'
import { Building2, Crosshair, Home, LoaderCircle, MapPin, TriangleAlert } from '@lucide/vue'
import { useLocationStore } from '@/stores/location.store'
import { isAnchorSet, pickAnchors, type AnchorId, type StoredAnchors } from '../anchors'

const ANCHORS: Array<{
  id: AnchorId
  label: string
  icon: typeof Home
  latKey: keyof StoredAnchors
  lngKey: keyof StoredAnchors
}> = [
  { id: 'home', label: '家', icon: Home, latKey: 'homeLat', lngKey: 'homeLng' },
  { id: 'work', label: '公司', icon: Building2, latKey: 'workLat', lngKey: 'workLng' },
]

const locationStore = useLocationStore()
const { isSimulated } = storeToRefs(locationStore)

const stored = shallowRef<StoredAnchors>({
  homeLat: null,
  homeLng: null,
  workLat: null,
  workLng: null,
})

/** True until the first read of the stored row has answered. */
const loading = shallowRef(true)
/** The read itself failed: whether an anchor is set is then UNKNOWN, not unset. */
const loadFailed = shallowRef(false)
/** Anchor whose fix is being taken right now, so only that button shows pending. */
const capturing = shallowRef<AnchorId | null>(null)
/** Anchor the last successful save landed on. */
const savedAnchor = shallowRef<AnchorId | null>(null)
const saveError = shallowRef<string | null>(null)

/** Whether an anchor has a stored position — the same rule the index row states. */
function isSet(id: AnchorId): boolean {
  return isAnchorSet(stored.value, id)
}

/**
 * The stored coordinates, to five decimals (~1 m).
 *
 * Five is the precision this app treats as identity — the walking-time cache
 * keys a coordinate at the same scale — so what is shown is the anchor as the
 * walking path sees it, and two anchors are told apart by their own numbers.
 */
function coordsLabel(id: AnchorId): string | null {
  const anchor = ANCHORS.find(a => a.id === id)!
  const lat = stored.value[anchor.latKey]
  const lng = stored.value[anchor.lngKey]
  if (lat === null || lng === null) return null
  return `${lat.toFixed(5)}, ${lng.toFixed(5)}`
}

function buttonLabel(id: AnchorId): string {
  if (capturing.value === id) return '定位中…'
  return isSet(id) ? '重新抓取' : '用当前位置设置'
}

onMounted(async () => {
  try {
    const res = await fetch('/api/transit/settings')
    const json = await res.json()
    if (!json.success) throw new Error(json.error || '状态读取失败')
    stored.value = pickAnchors(json.data)
  }
  catch {
    // Keep every anchor unknown and say so: claiming 「未设置」 here would be a
    // statement about the stored row that this screen has not actually read.
    loadFailed.value = true
  }
  finally {
    loading.value = false
  }
})

/**
 * Take one fix for `id` and store it.
 *
 * `captureAnchorFix` resolves the browser's own position once, unconverted; the
 * PATCH carries that raw fix to the server, which converts it once and stores
 * GCJ-02. A failure — denied permission, timeout, no device position — arrives
 * as copy that names the departure time, because without an anchor there is no
 * walking time and therefore no departure time to show.
 */
async function grab(id: AnchorId): Promise<void> {
  if (capturing.value) return
  const anchor = ANCHORS.find(a => a.id === id)!
  capturing.value = id
  saveError.value = null
  savedAnchor.value = null
  try {
    const fix = await locationStore.captureAnchorFix()

    const res = await fetch('/api/transit/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [anchor.latKey]: fix.lat, [anchor.lngKey]: fix.lng }),
    })
    const json = await res.json()
    if (!json.success) throw new Error(json.error || '位置保存失败')

    stored.value = pickAnchors(json.data)
    savedAnchor.value = id
    loadFailed.value = false
  }
  catch (err) {
    saveError.value = err instanceof Error ? err.message : '位置保存失败'
  }
  finally {
    capturing.value = null
  }
}

/** Whether the buttons can be used at all: a simulated grab never fails. */
const canGrab = computed(() => capturing.value === null)
</script>

<template>
  <!-- Location anchors (F1's origin): set once, from the current position -->
  <section class="rounded-3xl border border-slate-800 bg-slate-900/80 p-4 shadow-xl sm:p-5">
    <h3 class="flex items-center gap-2 text-sm font-semibold text-slate-200 lg:text-base">
      <MapPin class="h-4 w-4 shrink-0 text-cyan-400" aria-hidden="true" />
      <span>位置锚点</span>
    </h3>
    <p class="mt-1 text-xs text-slate-400 lg:text-base">
      用当前位置设置「家」和「公司」，用于计算步行到站台的耗时
    </p>

    <!-- Development GPS override. Deliberately distinct from the vehicle-data
         simulation strip (amber, 模拟数据模式): the position can be simulated
         while the vehicle data is real, and mistaking one for the other would
         make a correct board look wrong. -->
    <div
      v-if="isSimulated"
      data-anchor-gps-simulation
      role="status"
      aria-live="polite"
      class="mt-3 flex items-start gap-2 rounded-xl border border-sky-500/40 bg-sky-500/10 px-3 py-2 text-sky-300"
    >
      <MapPin class="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span class="text-xs">
        <span class="font-semibold">模拟定位（开发用）</span>
        <span class="text-sky-400/80"> · 抓取到的是固定的模拟坐标，不是真实位置</span>
      </span>
    </div>

    <div class="mt-3 space-y-2">
      <div
        v-for="anchor in ANCHORS"
        :key="anchor.id"
        class="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-800 bg-slate-950 px-3 py-2.5"
      >
        <div class="flex min-w-0 items-center gap-2">
          <component :is="anchor.icon" class="h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
          <div class="min-w-0">
            <div class="text-xs font-medium text-slate-300 lg:text-sm">{{ anchor.label }}</div>
            <!-- Three honest states, never collapsed into two: still reading,
                 read failed (unknown), and a real answer from the stored row. -->
            <div v-if="loading" class="mt-0.5 text-xs text-slate-400">读取中…</div>
            <div v-else-if="loadFailed" class="mt-0.5 text-xs text-amber-400">
              未能读取已保存的位置，是否已设置未知
            </div>
            <div v-else-if="isSet(anchor.id)" class="mt-0.5 font-mono text-xs text-slate-300">
              {{ coordsLabel(anchor.id) }}
            </div>
            <div v-else class="mt-0.5 text-xs text-slate-400">
              未设置 · 无法算出门时间
            </div>
          </div>
        </div>

        <div class="flex items-center gap-2">
          <span
            v-if="savedAnchor === anchor.id && capturing === null"
            class="text-xs text-emerald-400"
            role="status"
            aria-live="polite"
          >
            已保存
          </span>
          <button
            type="button"
            :disabled="!canGrab"
            class="flex min-h-[44px] min-w-[44px] items-center gap-1.5 rounded-xl border px-3.5 text-xs font-semibold transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-50 lg:px-4 lg:text-base"
            :class="isSet(anchor.id)
              ? 'border-slate-700 bg-slate-900 text-slate-200 hover:border-cyan-500/40'
              : 'border-cyan-500/30 bg-cyan-500/10 text-cyan-400 hover:bg-cyan-500/20'"
            @click="grab(anchor.id)"
          >
            <LoaderCircle
              v-if="capturing === anchor.id"
              class="h-3.5 w-3.5 shrink-0 animate-spin"
              aria-hidden="true"
            />
            <Crosshair v-else class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>{{ buttonLabel(anchor.id) }}</span>
          </button>
        </div>
      </div>
    </div>

    <!-- A failed grab or save is never silent: the copy names what the failure
         costs (no anchor, so no departure time) and what to do about it. -->
    <p
      v-if="saveError"
      role="alert"
      class="mt-3 flex items-start gap-1.5 text-xs text-rose-400 lg:gap-2 lg:text-base"
    >
      <TriangleAlert class="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>{{ saveError }}</span>
    </p>
  </section>
</template>
