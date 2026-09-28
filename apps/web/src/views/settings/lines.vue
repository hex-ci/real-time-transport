<script setup lang="ts">
/**
 * 关注线路：搜索一条线路、关注它，并在一屏里看到已关注的那些。
 *
 * 它是**列表页**：搜索、关注、拖动排序，以及每行一个进编辑页的入口。行内不放编辑控件 ——
 * 方向与上车点在 `/settings/lines/:favoriteId` 那一页里改（见 `docs/PRD.md` §4.1
 * 「列表页与编辑页的分工」）。就地展开会让页面高度随编辑态跳动、一次只能编一个，
 * 而拖动排序还得跳过编辑中的那一行。
 *
 * 列表的措辞对它的读取可能留下的三种状态穷尽——空、仍在读取、以及带重试的失败状态
 * （`line-stops.ts` 的 `favoritesRead`）——「暂无关注线路」只有在读取真的作答后才可达。
 *
 * 行印出的摘要是**存储值**：哪个方向的站、以及它在那个方向的站序（`favorite-slots.ts`），
 * 与编辑页里说同一对站的那些句子共用同一份判断。
 */
import { shallowRef, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { ChevronRight, GripVertical, MapPin, RefreshCw, TriangleAlert } from '@lucide/vue'
import type { LineGroup, UserFavoriteLine } from '@real-time-transport/shared'
import { isBidirectional } from '@real-time-transport/shared/line-group'
import { followedLinesUnreadableText } from '@/read-state'
import { runWithFeedback } from '@/action-feedback'
import { useCityStore } from '@/stores/city.store'
import { useTransitStore } from '@/stores/transit.store'
import { BackToSettings, DragOrderList } from './components'
import { useFavoriteSlots } from './favorite-slots'
import { useLineStops } from './line-stops'

const transitStore = useTransitStore()
const cityStore = useCityStore()
const { favorites } = storeToRefs(transitStore)

const stops = useLineStops()

const {
  cityFavorites,
  favoritesRead,
  readFavorites,
} = stops

const { stopSummary } = useFavoriteSlots(stops)

const searchKeyword = shallowRef('')
const searchResults = shallowRef<LineGroup[]>([])
const searched = shallowRef(false)
const lastKeyword = shallowRef('')

/**
 * 关注集合没有列表可展示时，本卡片说什么。
 *
 * 三种句子由读取自己的状态决定，读自 `line-stops.ts` 而不是从数组长度假设：读失败会留下
 * 空数组，而「请在上方搜索框中搜索并添加线路」于是会叫用户去添加他已经关注了的线路。
 * 只有空状态是关于存了什么；失败状态是关于那次读取，并携带唯一能改变它的重试。
 */
const unreadableNote = followedLinesUnreadableText('暂时无法显示已关注的线路')

/** 上一次排序写入的失败，好让被拒绝的拖放绝不沉默。 */
const orderError = shallowRef<string | null>(null)

/**
 * 落一次拖放：被拖动的行占据它落在其上的行的位置。
 *
 * 两行按**名字**而非下标命名，因为顺序是覆盖**每一条**已关注线路的一份列表，
 * 而本页一次只展示一个城市。对着整份列表解析这次落放，才让本页不展示的行保持它们自己的
 * 相对位置，而不是在用户背后被重编号。
 */
async function onReorder(movedId: string, anchorId: string): Promise<void> {
  orderError.value = null
  try {
    await runWithFeedback('favorite-reorder', () => transitStore.moveFavorite(movedId, anchorId))
  }
  catch (err) {
    orderError.value = err instanceof Error ? err.message : '顺序保存失败'
  }
}

async function performSearch(): Promise<void> {
  const kw = searchKeyword.value.trim()
  if (!kw) return
  searched.value = true
  lastKeyword.value = kw
  searchResults.value = await transitStore.searchLines(kw, cityStore.currentCode)
}

/** 一条线路在其任一方向的 lineId 被关注时即为已关注。 */
function isRouteFollowed(item: LineGroup): boolean {
  const ids = new Set<string>()
  if (item.up) ids.add(item.up.lineId)
  if (item.down) ids.add(item.down.lineId)
  return favorites.value.some(f =>
    f.cityCode === item.cityCode
    && (ids.has(f.lineId) || (f.reverseLineId !== undefined && ids.has(f.reverseLineId))),
  )
}

/**
 * 关注一条线路**一次**——数据源报了两个方向时两个方向都跟上。`lineId` 是存为主方向的
 * 那个；`reverseLineId` 是另一个方向的 lineId（公交每个方向用不同的 id，地铁复用同一个
 * id）。只有一个方向存在时 `reverseLineId` 保持 undefined，
 * 故界面不会提供一个无法解析的方向开关。
 */
async function addFavorite(item: LineGroup): Promise<void> {
  if (isRouteFollowed(item)) return

  const primary = item.up ?? item.down
  if (!primary) return
  const other = item.up ? item.down : item.up

  try {
    // 被拒绝的关注（该线路已关注：每条线路一行）必须把被搜索的那一行
    // 留在屏幕上，好让它自己的控件陈述结果。
    if (!await runWithFeedback(
      'favorite-add',
      () => transitStore.addFavorite({
        lineId: primary.lineId,
        lineName: item.lineName,
        preferredDirection: primary.direction,
        reverseLineId: other ? other.lineId : undefined,
        cityCode: item.cityCode || cityStore.currentCode,
      }),
      { name: item.lineName },
    )) return
  }
  catch {
    // 这一行没有内联的错误位：那一次失败由提示说出，而搜索结果照旧留在屏幕上 ——
    // 一次被拒的写入绝不被当成「已经关注」而清掉用户刚搜到的那一行。
    return
  }
  searchResults.value = []
  searchKeyword.value = ''
  searched.value = false
}

// 城市切换时清空搜索状态
watch(() => cityStore.currentCode, () => {
  searchResults.value = []
  searchKeyword.value = ''
  searched.value = false
})

/** 一条关注行的编辑页地址。**绝不发明默认值**：认不出的 id 由那一页自己说不存在。 */
function editorHref(item: UserFavoriteLine): string {
  return `/settings/lines/${item.id}`
}
</script>

<template>
  <div class="mx-auto max-w-3xl space-y-6 pb-12">
    <BackToSettings />
    <h2 class="text-xl font-bold text-white md:text-2xl">
      关注线路
    </h2>

    <!-- 搜索与列表在同一张卡片里：添加线路与管理线路是同一件事，故两者之间不能有无关的东西。 -->
    <section class="rounded-3xl border border-slate-800 bg-slate-900/80 p-4 shadow-xl sm:p-5">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h3 class="text-sm font-semibold text-slate-200 lg:text-base">
          关注线路
          <!-- 条数是关于已存列表的事实，故只在列表被**读取**之后印出：
               从失败的读取取来的条数，是一个无人取得过的数字。 -->
          <span v-if="favoritesRead === 'read'" class="ml-1 font-normal text-slate-400">({{ cityFavorites.length }})</span>
        </h3>
        <span class="inline-flex items-center gap-1 rounded-full border border-cyan-500/30 bg-cyan-500/10 px-2.5 py-0.5 text-xs font-semibold text-cyan-400">
          <MapPin class="h-3 w-3 shrink-0" />
          <span>{{ cityStore.currentCityName }}</span>
        </span>
      </div>

      <form action="" class="mt-3 flex gap-2" @submit.prevent="performSearch">
        <!-- min-h-[44px] 让两个控件都落在触控目标尺寸内；16px 输入文本则避免
             iOS Safari 在中焦时缩放跳变。 -->
        <input
          v-model="searchKeyword"
          type="search"
          enterkeyhint="search"
          placeholder="输入线路号，如 快线 1 路、地铁 88 号线、甲乙线..."
          class="min-h-[44px] min-w-0 flex-1 rounded-xl border border-slate-700 bg-slate-950 px-3.5 py-2 text-base text-white placeholder:text-slate-400 outline-none focus:border-cyan-500 md:text-xs lg:px-4 lg:text-base"
        >
        <button
          type="submit"
          class="min-h-[44px] shrink-0 rounded-xl border border-cyan-500/30 bg-cyan-500/10 px-3 text-sm font-semibold text-cyan-400 transition hover:bg-cyan-500/20 active:scale-95 md:px-4 md:text-xs lg:text-base"
        >
          搜索
        </button>
      </form>

      <!-- 搜索结果：每条线路**一行**，两个方向合在一起 -->
      <div v-if="searchResults.length > 0" class="mt-3 divide-y divide-slate-800/80 rounded-xl border border-slate-800 bg-slate-950">
        <div
          v-for="item in searchResults"
          :key="item.groupKey"
          class="flex items-center justify-between gap-2 p-3 text-xs lg:gap-2.5 lg:p-3.5 lg:text-base"
        >
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <span class="font-mono font-bold text-cyan-400">{{ item.lineName }}</span>
              <span
                v-if="isBidirectional(item)"
                class="rounded border border-cyan-500/30 bg-cyan-500/10 px-1.5 py-0.5 text-xs font-medium text-cyan-400 whitespace-nowrap"
              >
                上下行
              </span>
              <span
                v-else
                class="rounded border border-slate-700 bg-slate-800/60 px-1.5 py-0.5 text-xs font-medium text-slate-300 whitespace-nowrap"
              >
                单向
              </span>
            </div>
            <!-- 两个方向各用自己的终点站标注，与下面的方向选择器、与真实的终点站牌一致。
                 此处绝不用 去/回：关注一条线路不是通勤，故两个方向都不是「返程」那个。 -->
            <div v-if="item.up" class="mt-1 truncate text-xs text-slate-400">
              <span class="text-emerald-400">{{ item.up.directionName }}</span>
            </div>
            <div v-if="item.down" class="mt-0.5 truncate text-xs text-slate-400">
              <span class="text-violet-400">{{ item.down.directionName }}</span>
            </div>
          </div>
          <button
            class="min-h-[44px] shrink-0 rounded-lg bg-slate-800 px-4 text-xs text-slate-200 transition hover:bg-cyan-500 hover:text-slate-950 active:scale-95 lg:px-5 lg:text-base"
            :disabled="isRouteFollowed(item)"
            @click="addFavorite(item)"
          >
            {{ isRouteFollowed(item) ? '已关注' : '关注' }}
          </button>
        </div>
      </div>
      <p v-else-if="searched && searchResults.length === 0" class="mt-3 text-center text-xs text-slate-400 lg:text-base">
        在 {{ cityStore.currentCityName }} 未找到匹配「{{ lastKeyword }}」的线路
      </p>

      <!-- 已关注列表：紧凑行，**整行是进编辑页的链接**。方向与上车点不在这一行上改（见文件头），
           故行里没有组合框，也没有展开态 —— 页面高度因此与编辑状态无关。

           各行是**存储**顺序，而这份列表正是编辑那个顺序的地方，故它经拖拽容器渲染，
           而不是直接读 store 的数组：那个数组携带首页的呈现方式，而被拖动的行必须从它
           实际持有的位置离开——并落在那里。

           拖拽手柄与链接是**两个**元素：手柄自己吃掉按压，点行才进编辑。手柄若长在链接里，
           一次抓取会同时被读成一次导航。 -->
      <DragOrderList
        v-if="cityFavorites.length > 0"
        :items="cityFavorites"
        tag="ul"
        class="mt-3 divide-y divide-slate-800/80 rounded-xl border border-slate-800 bg-slate-950"
        @move="onReorder"
      >
        <li v-for="item in cityFavorites" :key="item.id || item.lineId" class="flex items-center">
          <!-- 拖拽唯一可以开始的地方。整行任意位置都响应按压的行会吞掉翻页的滑动、
               并与进入编辑页的点击相争；touch-none 阻止浏览器认领手柄自己的手势。
               它是本行的手指落点，故两个方向都是 44px。 -->
          <span
            data-drag-handle
            aria-hidden="true"
            title="拖动调整顺序"
            class="-ml-0.5 flex h-11 w-11 shrink-0 cursor-grab touch-none items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-800/60 hover:text-slate-300 active:cursor-grabbing"
            @click.stop
          >
            <GripVertical class="h-4 w-4" />
          </span>
          <RouterLink
            :to="editorHref(item)"
            class="flex min-h-[44px] min-w-0 flex-1 items-center gap-2.5 py-2 pr-3 transition hover:bg-slate-900/60"
          >
            <span
              class="flex h-7 shrink-0 items-center justify-center rounded-lg border border-cyan-500/20 bg-cyan-500/10 px-2.5 font-mono font-bold whitespace-nowrap text-cyan-400"
              :class="(item.lineName || '').length > 4 ? 'text-xs min-w-[54px]' : 'text-xs min-w-[36px]'"
            >
              {{ item.lineName || '线路' }}
            </span>
            <span class="min-w-0 flex-1 truncate text-xs text-slate-300 lg:text-base">{{ stopSummary(item) }}</span>
            <ChevronRight class="h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
          </RouterLink>
        </li>
      </DragOrderList>

      <!-- 读取**失败**：这是它自己的成因，并带着唯一能修好它的重试——
           绝不是下面的空状态，那种状态声称的是存了什么。 -->
      <div v-else-if="favoritesRead === 'unreadable'" class="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-dashed border-rose-500/30 bg-rose-500/5 p-4">
        <p class="flex items-center gap-1.5 text-xs text-rose-400 lg:text-base">
          <TriangleAlert class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{{ unreadableNote }}</span>
        </p>
        <button
          type="button"
          class="flex min-h-[44px] items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-950 px-3 text-xs text-slate-200 transition hover:border-cyan-500/40 active:scale-95 lg:text-base"
          @click="readFavorites"
        >
          <RefreshCw class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>重试</span>
        </button>
      </div>

      <!-- 仍在读取：也不是空状态，同样不得借用它的措辞。 -->
      <p v-else-if="favoritesRead === 'reading'" class="mt-3 text-center text-xs text-slate-400 lg:text-base">
        正在读取关注线路…
      </p>

      <p v-else class="mt-3 rounded-xl border border-dashed border-slate-800 bg-slate-950/60 p-6 text-center text-xs text-slate-400 lg:p-7 lg:text-base">
        暂无关注线路，请在上方搜索框中搜索并添加线路
      </p>

      <!-- 落下的行立即被写入，故被拒绝的写入必须在此说明：列表已经弹回存储顺序，
           否则会看起来像那次拖拽从未发生。 -->
      <p
        v-if="orderError"
        class="mt-2 flex items-center gap-1.5 text-xs text-rose-400 lg:gap-2 lg:text-base"
      >
        <TriangleAlert class="h-3.5 w-3.5 shrink-0" />
        <span>{{ orderError }}</span>
      </p>
    </section>
  </div>
</template>
