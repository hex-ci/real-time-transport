<script setup lang="ts">
/**
 * 家 / 公司锚点选择器——步行时间的起点。
 *
 * 两个按钮，各取**一次**当前位置定位并 PATCH 到 `/api/transit/settings`。刻意不做地图选点：
 * 那需要浏览器侧的 JS API key，而本项目的 key 是 Web-service key，绝不能下发到浏览器。
 *
 * 定位结果原样离开本组件，WGS-84、无人转换。服务端在 PATCH 边界转换一次并存为 GCJ-02。
 * 此处渲染的是**服务端**返回的内容，故屏幕绝不会声称一条已存记录并不持有的坐标。
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

/** 在已存记录的首次读取作答之前为 true。 */
const loading = shallowRef(true)
/** 读取本身失败：此时某个锚点是否已设置是**未知**，而不是未设置。 */
const loadFailed = shallowRef(false)
/** 正在抓取定位的锚点，故只有那个按钮显示进行中。 */
const capturing = shallowRef<AnchorId | null>(null)
/** 最近一次成功保存落在哪个锚点。 */
const savedAnchor = shallowRef<AnchorId | null>(null)
const saveError = shallowRef<string | null>(null)

/** 某锚点是否有已存位置——与索引行陈述的是同一条规则。 */
function isSet(id: AnchorId): boolean {
  return isAnchorSet(stored.value, id)
}

/**
 * 已存的坐标，五位小数（约 1 米）。
 *
 * 五位是本应用当作同一性的精度——步行时间缓存以同一尺度为坐标建键——故展示的是步行路径
 * 眼中的那个锚点，两个锚点靠各自的数字区分。
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
    // 保持每个锚点未知并如此陈述：此处声称「未设置」会是一句关于已存记录、
    // 而本屏并未真正读过的断言。
    loadFailed.value = true
  }
  finally {
    loading.value = false
  }
})

/**
 * 为 `id` 取一次定位并存起来。
 *
 * `captureAnchorFix` 取一次浏览器自己的位置，不做转换；PATCH 把这次原始定位带到服务端，
 * 由它转换一次并存为 GCJ-02。失败——拒绝授权、超时、设备无位置——以点名出门时间的文案到达，
 * 因为没有锚点就没有步行时间，也就没有可展示的出门时间。
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

/** 按钮是否可用：模拟抓取永不失败。 */
const canGrab = computed(() => capturing.value === null)
</script>

<template>
  <!-- 位置锚点：从当前位置一次性设置 -->
  <section class="rounded-3xl border border-slate-800 bg-slate-900/80 p-4 shadow-xl sm:p-5">
    <h3 class="flex items-center gap-2 text-sm font-semibold text-slate-200 lg:text-base">
      <MapPin class="h-4 w-4 shrink-0 text-cyan-400" aria-hidden="true" />
      <span>位置锚点</span>
    </h3>
    <p class="mt-1 text-xs text-slate-400 lg:text-base">
      用当前位置设置「家」和「公司」，用于计算步行到站台的耗时
    </p>

    <!-- 开发用 GPS 覆盖。与车辆数据模拟横幅（琥珀色）刻意区分：位置可以是被模拟的，
         而车辆数据是真的，把两者弄混会让一块正确的屏看起来出错。 -->
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
            <!-- 三种诚实的状态，绝不折叠成两种：仍在读取、读取失败（未知），以及来自已存记录的真实答案。 -->
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

    <!-- 抓取或保存失败从不沉默：文案点名该失败代价是什么（没有锚点，就没有出门时间），
         以及该怎么办。 -->
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
