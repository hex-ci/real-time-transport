<script setup lang="ts">
/**
 * 一个锚点自己的页面：`/settings/anchors/home` 与 `/settings/anchors/work` 共用它。
 *
 * 两段式：**搜到一个地点并选中，再按保存**才写库。选中不写库，不保存就离开（例如点返回）
 * 等于放弃这次选择，已存的值不动 —— 故这里没有「取消」这个动作。
 *
 * 搜索**只在提交时**发生（按下「搜索」或回车）：候选在服务端，逐字请求会让结果顺序跳动、
 * 移动端键盘占掉约四成屏高，而上游的地点搜索有 QPS 限额。
 *
 * 坐标契约（`docs/PRD.md` §5.4）：搜索来的坐标是高德给的 `GCJ-02`，**原样提交、原样落库**，
 * 来源记为 `search`；「用当前位置」抓的是浏览器上报的原始 WGS-84，来源记为 `device`，
 * 由服务端换算一次。浏览器侧不做任何换算。
 *
 * 两处入口（搜索选中 / 抓当前位置）汇进同一个保存动作，写库只有一处。
 */
import { computed, onMounted, shallowRef } from 'vue'
import { useRouter } from 'vue-router'
import { Check, Crosshair, LoaderCircle, Search, TriangleAlert } from '@lucide/vue'
import type { PlaceSuggestion } from '@real-time-transport/shared'
import { runWithFeedback } from '@/action-feedback'
import { useCityStore } from '@/stores/city.store'
import { useLocationStore } from '@/stores/location.store'
import { readingText, unreadText, type ReadValue } from '@/read-state'
import { anchorEntry, anchorOf } from './anchor-catalog'
import {
  ANCHOR_UNSET_TEXT,
  anchorPlaceName,
  anchorPoint,
  coordsLabel,
  pickAnchors,
  type AnchorId,
  type AnchorSource,
  type StoredAnchors,
} from './anchors'
import { settingsReadOf } from './index-summary'
import { placeSearchEmptyText, suggestionKey, suggestionLines, type PlaceSearchState } from './place-search'
import { BackToSettings } from './components'

const props = defineProps<{ anchor: string }>()

const cityStore = useCityStore()
const locationStore = useLocationStore()

/**
 * 路由参数解析成的锚点，或 null。
 *
 * 路由表里那条 `:anchor(home|work)` 正则让别的参数落到 404 页，本组件不发明默认值 ——
 * 一个写错的地址按「家」渲染，会让用户在以为自己在设公司的时候改掉家。
 */
const id = computed<AnchorId | null>(() => anchorOf(props.anchor))
const entry = computed(() => (id.value === null ? null : anchorEntry(id.value)))

const router = useRouter()

/** 已存锚点，以及这次读取自己的状态。 */
const stored = shallowRef<ReadValue<StoredAnchors>>({ state: 'reading' })

/** 搜索框里的词，以及**上一次真正搜过**的词（空态那句话要说的是它，不是正在打的字）。 */
const keyword = shallowRef('')
const searchedKeyword = shallowRef('')

/** 一次搜索的结局。`null` 表示还没搜过 —— 与「搜了但没有匹配」是两件事。 */
const search = shallowRef<PlaceSearchState | null>(null)
const searching = shallowRef(false)

/**
 * 待保存的选择：一条搜索结果。
 *
 * 一次只选一样：选中一个地点就把上一次的选择换掉 —— 「保存」只能写一个坐标对。
 *
 * 只有搜索结果会进这里：「用当前位置」一次点完（抓取 + 写库 + 回列表），不产生待保存的选择。
 */
const selected = shallowRef<{ kind: 'place', place: PlaceSuggestion } | null>(null)

const capturing = shallowRef(false)
const saving = shallowRef(false)
const saveError = shallowRef<string | null>(null)

/** 本页显示的是哪一个锚点现在的值；未设置时说清代价。 */
const currentText = computed(() => {
  const read = stored.value
  if (read.state === 'reading') return readingText('已保存的位置')
  if (read.state === 'unreadable') return unreadText('已保存的位置', '无法显示它')
  const anchorId = id.value
  if (anchorId === null) return ANCHOR_UNSET_TEXT
  const point = anchorPoint(read.value, anchorId)
  if (point === null) return ANCHOR_UNSET_TEXT
  const name = anchorPlaceName(read.value, anchorId)
  return name === null ? coordsLabel(point) : `${name} · ${coordsLabel(point)}`
})

/** 保存按钮是否可用：没有选中的东西就没有可保存的坐标对。 */
const canSave = computed(() => selected.value !== null && !saving.value)

async function readAnchors(): Promise<void> {
  stored.value = { state: 'reading' }
  try {
    const res = await fetch('/api/transit/settings')
    stored.value = settingsReadOf(await res.json()).anchors
  }
  catch {
    stored.value = { state: 'unreadable' }
  }
}

onMounted(() => {
  void readAnchors()
})

/**
 * 提交一次搜索。**这是本页唯一发出搜索请求的地方**：没有对 `keyword` 的 watch，
 * 故逐字输入一个请求都不会发。
 */
async function performSearch(): Promise<void> {
  const words = keyword.value.trim()
  if (!words || searching.value) return
  searchedKeyword.value = words
  searching.value = true
  search.value = { state: 'reading' }
  // 换一次搜索就是换一批候选：上一次选中的那条已不在屏上，留着它会让「保存」写下一个
  // 用户看不见的坐标。
  selected.value = null
  try {
    const qs = new URLSearchParams({ keywords: words, cityCode: cityStore.currentCode })
    const res = await fetch(`/api/transit/gis/place-search?${qs.toString()}`)
    const json = await res.json()
    // 非 2xx 或 `success: false` 都是「这次搜索没答上来」，与「确实没有匹配」不是一件事。
    search.value = res.ok && json.success && Array.isArray(json.data)
      ? { state: 'read', results: json.data as PlaceSuggestion[] }
      : { state: 'unreadable' }
  }
  catch {
    search.value = { state: 'unreadable' }
  }
  finally {
    searching.value = false
  }
}

/** 点一行：选中它；再点一次取消选中。整行可点，行内没有按钮。 */
function toggle(place: PlaceSuggestion): void {
  const pick = selected.value
  selected.value = pick?.kind === 'place' && suggestionKey(pick.place) === suggestionKey(place)
    ? null
    : { kind: 'place', place }
}

function isSelected(place: PlaceSuggestion): boolean {
  const pick = selected.value
  return pick?.kind === 'place' && suggestionKey(pick.place) === suggestionKey(place)
}

/**
 * 「用当前位置」：取一次设备定位，**当场保存**，然后回锚点列表。
 *
 * 它不再经过「待保存」那一步：这个动作的结果是唯一的（没有可选项），而屏幕上一串坐标人眼
 * 本来也验不了 —— 中间那一步只多一次点击。抓取失败从不沉默（点名这次失败让用户失去了什么：
 * 没有锚点就没有出门时间），写库失败也一样留在页上。
 */
async function useCurrentLocation(): Promise<void> {
  const target = entry.value
  if (!target || capturing.value) return
  capturing.value = true
  saveError.value = null
  try {
    const fix = await locationStore.captureAnchorFix()
    // 设备定位是原始 WGS-84，来源记为 `device`，由服务端换算一次；它没有地点名。
    await writeAnchor({ lat: fix.lat, lng: fix.lng }, 'device', null)
  }
  catch (err) {
    saveError.value = err instanceof Error ? err.message : '没有取到当前位置'
  }
  finally {
    capturing.value = false
  }
}

/**
 * 写库唯一的一处。
 *
 * 来源随坐标一起提交：`search` 的坐标已是 GCJ-02（服务端原样落库），`device` 是原始
 * WGS-84（服务端换算一次）。地点名只在 `search` 时提交，否则显式 null —— 一次设备写入
 * 必须把旧名字清掉，否则索引行会说出一个已被覆盖的坐标。
 *
 * 成功之后回锚点列表：这一页的事已经办完，留着它只会让人再点一次保存。
 */
async function writeAnchor(point: { lat: number, lng: number }, source: AnchorSource, placeName: string | null): Promise<void> {
  const target = entry.value
  if (!target) return
  await runWithFeedback('anchor-save', async () => {
    const res = await fetch('/api/transit/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        [target.latKey]: point.lat,
        [target.lngKey]: point.lng,
        [target.sourceKey]: source,
        [target.placeNameKey]: placeName,
      }),
    })
    const json = await res.json()
    if (!json.success) throw new Error(json.error || '位置保存失败')
    stored.value = { state: 'read', value: pickAnchors(json.data) }
    // 写完了，就没有「待保存」了：留下的选中态会让「保存」看起来还没落库。
    selected.value = null
  }, { name: target.label })
  await router.push('/settings/anchors')
}

/** 保存搜索选中的那一个。没选东西时按钮不可点，故这里不会拿到空选择。 */
async function save(): Promise<void> {
  const pick = selected.value
  if (!pick || saving.value) return
  saving.value = true
  saveError.value = null
  try {
    await writeAnchor({ lat: pick.place.lat, lng: pick.place.lng }, 'search', pick.place.name)
  }
  catch (err) {
    saveError.value = err instanceof Error ? err.message : '位置保存失败'
  }
  finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="mx-auto max-w-3xl space-y-6 pb-12">
    <BackToSettings to="/settings/anchors" label="返回位置锚点" />

    <!-- 认不出的参数不是一个锚点：按「家」渲染会让用户在以为自己在设公司的时候改掉家。
         这一帧不给第二个返回控件 —— 上面那个已经指向锚点列表，两枚同目标的按钮只会让人犹豫。 -->
    <div v-if="!entry" class="rounded-3xl border border-slate-800 bg-slate-900/60 p-8 text-center">
      <p class="text-sm font-semibold text-slate-200 lg:text-base">这个位置锚点不存在</p>
    </div>

    <template v-else>
      <h2 class="text-xl font-bold text-white md:text-2xl">
        {{ entry.heading }}
      </h2>

      <div>
        <section class="rounded-3xl border border-slate-800 bg-slate-900/80 p-4 shadow-xl sm:p-5">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <h3 class="text-sm font-semibold text-slate-200 lg:text-base">
              搜索地点
            </h3>
            <span class="text-xs text-slate-400 lg:text-base">搜索范围：{{ cityStore.currentCityName }}</span>
          </div>

          <!-- 搜索**只在提交时**发生：没有对输入值的 watch，故逐字输入不发请求。
               min-h-[44px] 让两个控件都落在触控目标内；输入文本**任何宽度都是 16px** ——
               iOS 在它之上运行的每个宽度（iPhone 与 iPad）都会为小于 16px 的输入在中焦时
               缩放跳变，故这个字段不跟房规的 md 档降字号。 -->
          <form action="" class="mt-3 flex gap-2" @submit.prevent="performSearch">
            <input
              v-model="keyword"
              type="search"
              enterkeyhint="search"
              placeholder="输入地点名，如 珠江帝景B区"
              class="min-h-[44px] min-w-0 flex-1 rounded-xl border border-slate-700 bg-slate-950 px-3.5 py-2 text-base text-white placeholder:text-slate-400 outline-none focus:border-cyan-500 lg:px-4"
            >
            <button
              type="submit"
              class="flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-xl border border-cyan-500/30 bg-cyan-500/10 px-3 text-sm font-semibold text-cyan-400 transition hover:bg-cyan-500/20 active:scale-95 md:px-4 md:text-xs lg:text-base"
            >
              <LoaderCircle v-if="searching" class="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden="true" />
              <Search v-else class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>搜索</span>
            </button>
          </form>

          <!-- 结果列表：整行可点，行内没有按钮。长地址换行，右端的对勾不被挤压。
               高度封顶并自己滚：一次搜索可能回来十几条，不封顶会把保存按钮推到几屏之外。
               行内是按钮，故键盘用户可以 Tab 进去，浏览器会把它滚到可见处。 -->
          <div
            v-if="search?.state === 'read' && search.results.length > 0"
            class="mt-3 max-h-72 divide-y divide-slate-800/80 overflow-y-auto overscroll-contain rounded-xl border border-slate-800 bg-slate-950"
          >
            <button
              v-for="place in search.results"
              :key="suggestionKey(place)"
              type="button"
              class="flex w-full items-center justify-between gap-2.5 p-3 text-left transition lg:p-3.5"
              :class="isSelected(place) ? 'bg-cyan-500/10' : 'hover:bg-slate-900/60'"
              :aria-pressed="isSelected(place)"
              @click="toggle(place)"
            >
              <span class="min-w-0 flex-1">
                <span
                  class="block text-sm lg:text-base"
                  :class="isSelected(place) ? 'font-semibold text-cyan-200' : 'text-slate-200'"
                >
                  {{ suggestionLines(place).title }}
                </span>
                <!-- 次行是区 + 地址，重名靠它分辨。某项缺省时只显示拿到的部分，绝不编造地址。 -->
                <span
                  v-if="suggestionLines(place).subtitle"
                  class="mt-1 block text-xs break-words text-slate-400"
                >
                  {{ suggestionLines(place).subtitle }}
                </span>
              </span>
              <Check
                v-if="isSelected(place)"
                class="h-4 w-4 shrink-0 text-cyan-400"
                aria-hidden="true"
              />
            </button>
          </div>

          <!-- 搜过了、答了、一条都没有：这是空态本身，不夹带任何动作。 -->
          <template v-else-if="search?.state === 'read'">
            <p class="mt-3 text-center text-xs text-slate-400 lg:text-base">
              {{ placeSearchEmptyText(cityStore.currentCityName, searchedKeyword) }}
            </p>
          </template>

          <!-- 搜索没答上来：这是它自己的事实，与「没有这个地方」不是一句话，且它带自己的重试。 -->
          <div
            v-else-if="search?.state === 'unreadable'"
            class="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-dashed border-rose-500/30 bg-rose-500/5 p-3"
          >
            <p class="flex items-center gap-1.5 text-xs text-rose-400 lg:text-base">
              <TriangleAlert class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>未读到搜索结果，暂时无法选地点</span>
            </p>
            <button
              type="submit"
              class="flex min-h-[44px] items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-950 px-3 text-xs text-slate-200 transition hover:border-cyan-500/40 active:scale-95 lg:text-base"
              @click="performSearch"
            >
              重试
            </button>
          </div>

          <!-- 两个动作并排：抓当前位置与保存。前者一次点完（抓取 + 写库 + 回列表），后者提交
               你选中的那条搜索结果；它们都是「把这一屏的选择落到库里」，故同一行、同高 44。
               样式留主次：保存是青底主按钮，用当前位置是描边次按钮 —— 两个同款按钮并排时，
               用户得读文字才分得清哪个是哪个。窄屏不折行（320 上放得下）。 -->
          <div class="mt-3 flex items-center gap-2">
            <button
              type="button"
              :disabled="capturing"
              class="flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-950 px-3 text-xs font-semibold text-slate-200 transition hover:border-cyan-500/40 active:scale-95 lg:px-3.5 lg:text-base"
              @click="useCurrentLocation"
            >
              <LoaderCircle v-if="capturing" class="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden="true" />
              <Crosshair v-else class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>用当前位置</span>
            </button>
            <button
              type="button"
              :disabled="!canSave"
              class="min-h-[44px] min-w-0 flex-1 rounded-xl border border-cyan-500/30 bg-cyan-500/10 px-4 text-sm font-semibold text-cyan-400 transition hover:bg-cyan-500/20 active:scale-95 lg:text-base"
              @click="save"
            >
              {{ saving ? '保存中…' : entry.saveLabel }}
            </button>
          </div>
        </section>

        <!-- 当前设置只用一句话说，不套卡片：它陈述的是已存记录的事实。 -->
        <p class="mt-3 text-xs break-words text-slate-400 lg:text-base">
          当前设置：<span class="font-semibold text-slate-200">{{ currentText }}</span>
        </p>

        <!-- 保存失败从不沉默：服务端或设备给了原因就原样带上。 -->
        <p v-if="saveError" role="alert" class="mt-2 flex items-start gap-1.5 text-xs text-rose-400 lg:text-base">
          <TriangleAlert class="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{{ saveError }}</span>
        </p>
      </div>
    </template>
  </div>
</template>
