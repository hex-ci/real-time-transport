<script setup lang="ts">
/**
 * 设置 的**索引**：四行，每行一个域，各自把该域的**当前状态**作为事实陈述。
 *
 * 本页是什么。四个域曾挤在一个 841 行的屏幕上；现在是四个页面，而这里是通往它们的地图。
 * 一行是整行 `<RouterLink>` 而非脚本化的 `router.push`：这样这一行自带语义、键盘可达性
 * 与浏览器已经会给链接的「在新标签页打开」。
 *
 * 一行可以说什么。只陈述事实——关注了多少条线路、保存了哪些时段、每个锚点是否已设、
 * 录入了多少条链路。不给建议、不说「去配置」：动作就是这一行自己的链接，一条还告诉用户
 * 该做什么的摘要会把同一件事说两遍。措辞由 `index-summary.ts` 拥有。
 *
 * 它不做什么。不把状态带进子页面：四个页面各自是真实路径，各自读取所需的一切，
 * 故刷新、书签或浏览器后退都落在同一页面、同一内容上。
 */
import { computed, onMounted, shallowRef } from 'vue'
import { storeToRefs } from 'pinia'
import { ChevronRight, Clock, MapPin, Search, Waypoints } from '@lucide/vue'
import { useCityStore } from '@/stores/city.store'
import { useTransitStore } from '@/stores/transit.store'
import type { StoredAnchors } from './anchors'
import {
  anchorsText,
  chainsText,
  followedLinesText,
  hoursText,
  settingsReadOf,
  type SettingsSummaryValue,
  type SummaryValue,
} from './index-summary'
import type { UserSettings } from '@real-time-transport/shared'

const transitStore = useTransitStore()
const cityStore = useCityStore()
const { favoriteOrder } = storeToRefs(transitStore)

/**
 * **屏上**这个城市已关注的线路——也就是关注线路管理的那个域，而不是全部已存列表：
 * 对每个城市计数会描述一个用户没在看的页面，而那是哪个城市，页眉里已经写明。
 */
const cityFavorites = computed(() =>
  favoriteOrder.value.filter(f => f.cityCode === cityStore.currentCode),
)

/** 四个事实，各处于它自己那次读取留下的状态。 */
const followedLines = shallowRef<SummaryValue<number>>({ state: 'reading' })
const savedHours = shallowRef<SettingsSummaryValue<UserSettings>>({ state: 'reading' })
const anchors = shallowRef<SummaryValue<StoredAnchors>>({ state: 'reading' })
const chains = shallowRef<SummaryValue<number>>({ state: 'reading' })

/**
 * 各行，按四个域的既定次序：关注线路、通勤时段、位置锚点、通勤链路。
 *
 * 其中三个在此读取，而非取自子页面：本页可能是会话渲染的第一屏，
 * 故它陈述的每个事实都必须来自自己的读取。
 */
const rows = computed(() => [
  { to: '/settings/lines', label: '关注线路', icon: Search, summary: followedLinesText(followedLines.value) },
  { to: '/settings/schedule', label: '通勤时段', icon: Clock, summary: hoursText(savedHours.value) },
  { to: '/settings/anchors', label: '位置锚点', icon: MapPin, summary: anchorsText(anchors.value) },
  { to: '/settings/chains', label: '通勤链路', icon: Waypoints, summary: chainsText(chains.value) },
])

onMounted(() => {
  void readFollowedLines()
  void readSettings()
  void readChains()
})

/**
 * 已关注线路的条数，以及它到底是不是一个条数。
 *
 * store 回答服务端是否真的交回了列表：读失败会留下空数组，
 * 而报出那个数组的长度，就是报出一个本页从未取得的数字。
 */
async function readFollowedLines(): Promise<void> {
  const answered = await transitStore.fetchFavorites()
  followedLines.value = answered
    ? { state: 'read', value: cityFavorites.value.length }
    : { state: 'unreadable' }
}

/** 录入了多少条链路——同样通过 store 自己的答案读取，同一条规则。 */
async function readChains(): Promise<void> {
  const answered = await transitStore.fetchCommuteChains()
  chains.value = answered
    ? { state: 'read', value: transitStore.commuteChains.length }
    : { state: 'unreadable' }
}

/**
 * 那一条设置记录，四个域中有两个从它读取。
 *
 * 两者一起设置、但彼此独立：没有四个时刻的记录不是可读的时段，而同一记录的锚点仍可能可读
 * ——故时段可以在已知的锚点旁说「未读到」，两者绝不借用对方的答案。
 *
 * 读法本身是 `settingsReadOf` 的，它携带服务端新增的那一种状态：从未保存过任何东西的用户
 * 得到 `settingsState: 'unset'` 且无记录，故本页说「未设置」——而不是内置的 `06:30–11:30`，
 * 那是默认值穿着用户自己配置的衣服。这一状态也**不是**「未读到」：一个是失败的读取，
 * 另一个是找到了空无的读取。
 */
async function readSettings(): Promise<void> {
  try {
    const res = await fetch('/api/transit/settings')
    const json = await res.json()
    const read = settingsReadOf(json)
    savedHours.value = read.hours
    anchors.value = read.anchors
  }
  catch {
    // 请求从未作答，或答案无法解析：关于已存记录一无所知。
    // 「未设置」会是对它的断言，而默认值会看起来像用户自己的时段。
    savedHours.value = { state: 'unreadable' }
    anchors.value = { state: 'unreadable' }
  }
}
</script>

<template>
  <div class="mx-auto max-w-2xl space-y-6 pb-12">
    <div>
      <h2 class="text-xl font-bold text-white md:text-2xl">
        设置
      </h2>
      <p class="mt-1 text-xs text-slate-400 lg:text-base">
        每一项各自一页；这里只报出它们现在是什么样
      </p>
    </div>

    <!-- 一个列表，每行一个链接，行自己的摘要**在该链接内部**：一行与它的状态不能是两个
         地方，否则靠链接到达该行的读者永远听不到那个状态。 -->
    <ul class="divide-y divide-slate-800/80 overflow-hidden rounded-3xl border border-slate-800 bg-slate-900/80 shadow-xl">
      <li v-for="row in rows" :key="row.to">
        <RouterLink
          :to="row.to"
          class="flex min-h-[44px] items-center gap-3 px-4 py-3.5 transition hover:bg-slate-950/60"
        >
          <component :is="row.icon" class="h-4 w-4 shrink-0 text-cyan-400" aria-hidden="true" />
          <span class="min-w-0 flex-1">
            <span class="block text-sm font-semibold text-slate-200 lg:text-base">{{ row.label }}</span>
            <span class="mt-0.5 block truncate text-xs text-slate-400 lg:text-base">{{ row.summary }}</span>
          </span>
          <ChevronRight class="h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
        </RouterLink>
      </li>
    </ul>
  </div>
</template>
