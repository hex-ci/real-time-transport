<script setup lang="ts">
/**
 * 关注线路：搜索一条线路、关注它，并编辑每条已关注线路自己的通勤方向与上车点。
 *
 * 列表的措辞对它的读取可能留下的三种状态穷尽——空、仍在读取、以及带重试的失败状态
 * （`line-stops.ts` 的 `favoritesRead`）——「暂无关注线路」只有在读取真的作答后才可达。
 *
 * 它提供上车点的站点列表来自 `line-stops.ts`，与通勤链路共享，
 * 故一段链路绝不会被提供本卡片认为不可用的站点。
 */
import { shallowRef, watch } from 'vue'
import { storeToRefs } from 'pinia'
import {
  AccordionContent,
  AccordionHeader,
  AccordionItem,
  AccordionRoot,
  AccordionTrigger,
  RadioGroupItem,
  RadioGroupRoot,
} from 'reka-ui'
import { ChevronDown, GripVertical, Info, MapPin, RefreshCw, TriangleAlert, X } from '@lucide/vue'
import type { LineGroup, Station, UserFavoriteLine } from '@real-time-transport/shared'
import {
  commuteDirectionFor,
  effectiveCommuteDirection,
  isBidirectional,
  placeBoardStop,
  resolveBoardStopRef,
} from '@real-time-transport/shared/line-group'
import type { BoardStopPlacement } from '@real-time-transport/shared/line-group'
import type { ReadValue } from '@/read-state'
import { followedLinesUnreadableText } from '@/read-state'
import { useCityStore } from '@/stores/city.store'
import { useTransitStore } from '@/stores/transit.store'
import { BackToSettings, LineOrderList, RemovalDialog, StationPinPicker } from './components'
import { useLineStops } from './line-stops'
import type { StationChoice } from './types'

const transitStore = useTransitStore()
const cityStore = useCityStore()
const { favorites } = storeToRefs(transitStore)

const {
  cityFavorites,
  favoritesRead,
  readFavorites,
  stopsRead,
  stopsOf,
  directionLabels,
  pinKey,
  directionOptions,
} = useLineStops()

const searchKeyword = shallowRef('')
const searchResults = shallowRef<LineGroup[]>([])
const searched = shallowRef(false)
const lastKeyword = shallowRef('')

const pinError = shallowRef<string | null>(null)

/**
 * 关注集合没有列表可展示时，本卡片说什么。
 *
 * 三种句子由读取自己的状态决定，读自 `line-stops.ts` 而不是从数组长度假设：读失败会留下
 * 空数组，而「请在上方搜索框中搜索并添加线路」于是会叫用户去添加他已经关注了的线路。
 * 只有空状态是关于存了什么；失败状态是关于那次读取，并携带唯一能改变它的重试。
 */
const unreadableNote = followedLinesUnreadableText('暂时无法显示已关注的线路')

/** 该目的所乘坐的方向，由用户选定。在他们挑之前为 null。 */
function chosenDirection(fav: UserFavoriteLine, purpose: 'morning' | 'evening'): 0 | 1 | null {
  return commuteDirectionFor(fav, purpose)
}

/**
 * 选择器列出其站点的方向。
 *
 * 与其他每个视图同一条规则，故选择器的站点来源绝不会与首页卡为该目的渲染的内容不一致。
 */
function pickerDirection(fav: UserFavoriteLine, purpose: 'morning' | 'evening'): 0 | 1 | null {
  return effectiveCommuteDirection(fav, purpose)
}

/** 某个目的所乘坐方向的站点；该方向作答前为空。 */
function purposeStations(fav: UserFavoriteLine, purpose: 'morning' | 'evening'): Station[] {
  return stopsOfPurpose(fav, purpose) ?? []
}

/**
 * 这个目的所要的那个方向的读取状态，或 null（还没选方向：没有请求，也没有结果）。
 *
 * 面板的三种说法都从这里来，不再从「站表长不长」推：读在路上、读了但没有站、没答上来是三个
 * 不同的事实，各自的句子不同。先前用「长度是 0」当加载中，于是一个真的答了空表的方向永远停在
 * 「正在加载站点…」上 —— 那句话是关于读取的，不是关于这个方向的。
 */
function purposeStopsRead(fav: UserFavoriteLine, purpose: 'morning' | 'evening'): ReadValue<Station[]> | null {
  const dir = pickerDirection(fav, purpose)
  return dir === null ? null : stopsRead(fav, dir)
}

/** API 为该方向**作答**出的站点；尚未作答时为 null。 */
function stopsOfPurpose(fav: UserFavoriteLine, purpose: 'morning' | 'evening'): Station[] | null {
  const dir = pickerDirection(fav, purpose)
  return dir === null ? null : stopsOf(fav, dir)
}

/**
 * 该目的的方向是否没有站点可提供——因为 API 已作答且一个都没列。
 *
 * 只有**答案**为真：仍在途的读取与完全没作答的读取各保留自己的措辞。「这个方向暂无站点数据」
 * 是对该方向的断言，而在它线路的详情带着空站点列表到达之前，没人做过这个断言。
 */
function stationsUnavailable(fav: UserFavoriteLine, purpose: 'morning' | 'evening'): boolean {
  const stops = stopsOfPurpose(fav, purpose)
  return stops !== null && stops.length === 0
}

/**
 * 该目的已存的站落在选择器正在展示的那个方向的何处——或为何无法放在那里。
 *
 * 该站按它存储的那一对读取（站名 + 站序），并由唯一那条共享规则定位：已存的站序只定位它
 * 自己的站；而只留了站名的旧记录，仅当该站名在本方向只出现一次时才能定位，否则**不可用**
 * （绝不取首个匹配，那正是 第36站 变成 第1站 的来路）。
 * `undefined` 表示列表还没读到，那是未知而非无服务。
 */
function boardStopPlacement(fav: UserFavoriteLine, purpose: 'morning' | 'evening'): BoardStopPlacement {
  const stop = resolveBoardStopRef(fav, purpose)
  const dir = pickerDirection(fav, purpose)
  if (dir === null || !fav.id) return placeBoardStop(undefined, stop)
  // 该方向作答且没有站点：面板自己会这么说，
  // 故此处不是声称该站无服务的地方。
  if (stationsUnavailable(fav, purpose)) return placeBoardStop(undefined, stop)
  // 读取没答上来时 `stopsOf` 给 null，`placeBoardStop` 把它读成 not-loaded（还没有这份事实），
  // 只有真的答了才拿它那张表去定位这一对。
  return placeBoardStop(stopsOf(fav, dir) ?? undefined, stop)
}

/**
 * 面板必须就这个已存的站说什么；没有可说时为 null。
 *
 * 每个原因一句话，因为它们是不同的原因，而其中只有一个是本方向不服务的站：出现两次的站名
 * **不是**用「不在本方向停靠」来回答的（它确实停那里——两次），而列表不再持有的已存站序
 * 是一次重编号，不是无服务的站。错误的原因会把用户送去修错的东西。
 */
function boardStopNotice(fav: UserFavoriteLine, purpose: 'morning' | 'evening'): string | null {
  const placement = boardStopPlacement(fav, purpose)
  if (placement.state === 'absent') return `「${placement.name}」不在本方向停靠，请重选`
  if (placement.state === 'stale') {
    return `「${placement.name} 第${placement.order}站」在本方向已不存在，请重选`
  }
  if (placement.state === 'ambiguous') {
    return `「${placement.name}」在本方向有 ${placement.orders.length} 站同名，无法确定是哪一站，请重选`
  }
  return null
}

/**
 * 已存的站作为选择器自己的值：该行持有的那一对。
 *
 * 是这一对而不是站名：仅站名无法解析回列表，而选择器的触发器读站序来说**两个**同名站里被
 * 固定的是哪一个。旧记录的站序为 null，触发器就只渲染站名——而该站名出现两次时，渲染为
 * 琥珀色，并在旁边由 `boardStopNotice` 说明原因。
 */
function pinnedChoice(fav: UserFavoriteLine, purpose: 'morning' | 'evening'): StationChoice | null {
  return resolveBoardStopRef(fav, purpose)
}

/**
 * 两个目的乘坐**同一**物理方向时的中性提示。
 *
 * 允许，而非阻止：线性线路上不可能（不能同时往两个方向走），但环线存在、用户可能有理由，
 * 而且下游没有东西假设两者不同。点名方向让这种重叠一眼可见，
 * 而不是留给用户去比对两个区块。
 *
 * 只有两个方向可选时才有此提示：单方向线路上同一个值就是唯一的值，
 * 故「选另一个方向」会是用户无法照做的建议。
 */
function sameDirectionNote(fav: UserFavoriteLine): string | null {
  if (directionOptions(fav).length < 2) return null
  const morning = effectiveCommuteDirection(fav, 'morning')
  const evening = effectiveCommuteDirection(fav, 'evening')
  if (morning === null || morning !== evening) return null
  const label = directionLabels.value[pinKey(fav.id!, morning)]
  return label
    ? `上班和下班都是「${label}」，返程通常应选另一个方向`
    : '上班和下班是同一方向，返程通常应选另一个方向'
}

/**
 * 记录选择器报告的站。
 *
 * 值**就是**选择器挑的那一对（站名 + 站序），并按一对写入：仅站名无法定位回一个方向的
 * 站点列表。清空时把这一对作为 null 送出。
 */
async function onPinChange(
  fav: UserFavoriteLine,
  purpose: 'morning' | 'evening',
  choice: StationChoice | null,
): Promise<void> {
  pinError.value = null
  try {
    await transitStore.setBoardStop(fav.id!, purpose, choice)
  }
  catch (err) {
    pinError.value = err instanceof Error ? err.message : '上车点保存失败'
  }
}

/**
 * 记录某个目的所乘坐的方向。
 *
 * 新方向不服务该站时，上车点刻意保持不动：那是真实情况（站只在其中一个方向存在），
 * 而用户手打的选择值得保持可见、好让他自己判断，而不是在他脚下被删掉。随后
 * `boardStopNotice` 会标记它——而这一对是一个存储值，故新方向绝不会按站名重新解析它。
 */
async function onDirectionChange(
  fav: UserFavoriteLine,
  purpose: 'morning' | 'evening',
  direction: 0 | 1,
): Promise<void> {
  pinError.value = null
  try {
    await transitStore.updateCommuteSlot(fav.id!, purpose, { direction })
  }
  catch (err) {
    pinError.value = err instanceof Error ? err.message : '方向保存失败'
  }
}

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
    await transitStore.moveFavorite(movedId, anchorId)
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

  const followed = await transitStore.addFavorite({
    lineId: primary.lineId,
    lineName: item.lineName,
    preferredDirection: primary.direction,
    reverseLineId: other ? other.lineId : undefined,
    cityCode: item.cityCode || cityStore.currentCode,
  })
  // 被拒绝的关注（该线路已关注：每条线路一行）必须把被搜索的那一行
  // 留在屏幕上，好让它自己的控件陈述结果。
  if (!followed) return
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

/**
 * 哪些关注项的站点编辑器是打开的，用单元素数组是因为 AccordionRoot 的单开模式以这种方式
 * 报告它的值。一次一个：每个展开的行携带两个组合框，
 * 让多个同时打开会重建紧凑行本来要避免的那堵控件墙。
 */
const expandedFavorite = shallowRef<string[]>([])

/** 排队等待移除的关注项，以及上一次尝试的失败。 */
const pendingRemoval = shallowRef<UserFavoriteLine | null>(null)
const removingFavorite = shallowRef(false)
const removalError = shallowRef<string | null>(null)

function requestRemoval(fav: UserFavoriteLine): void {
  removalError.value = null
  pendingRemoval.value = fav
}

/**
 * 取消关注排队的目标，并让对话框保持到请求落定。
 *
 * 确认控件是普通 button，不是 reka-ui 的 `AlertDialogAction`：后者**就是** `DialogClose`，
 * 它自己的点击处理会关闭对话框，而 Vue 在消费者的 fallthrough 处理之前运行组件自己的处理
 * ——关闭先清空了 `pendingRemoval`，故处理读到 `null` 并直接返回，永远没发出 DELETE。
 *
 * 显式关闭也让按钮的进行中状态诚实：请求在途时它保持禁用并显示「处理中…」，
 * 失败则让对话框带着原因开着，而不是在动作中途消失。
 */
async function confirmRemoval(): Promise<void> {
  const target = pendingRemoval.value
  if (!target || removingFavorite.value) return
  removalError.value = null
  removingFavorite.value = true
  try {
    await transitStore.removeFavorite(target.id || target.lineId)
    pendingRemoval.value = null
  }
  catch (err) {
    removalError.value = err instanceof Error ? err.message : '取消关注失败'
  }
  finally {
    removingFavorite.value = false
  }
}

/**
 * 每个目的一行，使折叠的行仍回答它存在的那个问题：首页卡会报哪几个站。
 *
 * 它**不得**做的，是把本行自己的方向定位不到的站当成已定来印：「🏠 和平东桥」放在该站名
 * 出现两次的方向旁，会在卡片说不出可行动内容时告诉用户某个站已就绪。每个原因读作它自己，
 * 而这一对只在列表确实定位到它时才印出。
 */
function stopSummaryPart(fav: UserFavoriteLine, purpose: 'morning' | 'evening'): string | null {
  const mark = purpose === 'morning' ? '🏠' : '🏢'
  const stop = resolveBoardStopRef(fav, purpose)
  if (!stop) return null
  const placement = boardStopPlacement(fav, purpose)
  if (placement.state === 'placed') return `${mark} ${placement.name} 第${placement.order}站`
  if (placement.state === 'ambiguous') return `${mark} ${placement.name}（同名${placement.orders.length}站）`
  if (placement.state === 'stale') return `${mark} ${placement.name} 第${placement.order}站（站序已变）`
  if (placement.state === 'absent') return `${mark} ${placement.name}（不在本方向）`
  // 还没读到：站名是该行持有的内容，而它落在哪里一无所知。
  return `${mark} ${stop.name}`
}

function stopSummary(fav: UserFavoriteLine): string {
  const parts = (['morning', 'evening'] as const)
    .map(purpose => stopSummaryPart(fav, purpose))
    .filter((part): part is string => part !== null)
  return parts.length > 0 ? parts.join(' · ') : '未设置上车点'
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
            class="min-h-[44px] shrink-0 rounded-lg bg-slate-800 px-4 text-xs text-slate-200 transition hover:bg-cyan-500 hover:text-slate-950 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50 lg:px-5 lg:text-base"
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

      <!-- 已关注列表：紧凑行，一次展开一行。AccordionRoot（单开）拥有展开状态与触发器/
           内容的 ARIA 接线，故一次只有一行的编辑器可以打开。

           各行是**存储**顺序，而这份列表正是编辑那个顺序的地方，故它经拖拽容器渲染，
           而不是直接读 store 的数组：那个数组携带首页的呈现方式，而被拖动的行必须从它
           实际持有的位置离开——并落在那里。 -->
      <AccordionRoot
        v-if="cityFavorites.length > 0"
        v-model="expandedFavorite"
        type="single"
        collapsible
        class="mt-3 rounded-xl border border-slate-800 bg-slate-950"
      >
        <LineOrderList :items="cityFavorites" @move="onReorder">
          <AccordionItem
            v-for="item in cityFavorites"
            :key="item.id || item.lineId"
            :value="item.id || item.lineId"
          >
            <AccordionHeader as-child>
              <!-- 纵向内边距如此设置，好让折叠的行在只带一行文字时仍满足 44px 触点目标。 -->
              <AccordionTrigger
                class="group flex w-full items-center gap-2.5 px-3 py-3.5 text-left transition hover:bg-slate-900/60"
              >
                <!-- 拖拽唯一可以开始的地方。整行任意位置都响应按压的行会吞掉翻页的滑动、
                     并与打开该行的点击相争；touch-none 阻止浏览器认领手柄自己的手势，
                     而被吞掉的点击则让抓取不会切换该行。 -->
                <span
                  data-drag-handle
                  aria-hidden="true"
                  title="拖动调整顺序"
                  class="-ml-1 flex h-9 w-8 shrink-0 cursor-grab touch-none items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-800/60 hover:text-slate-300 active:cursor-grabbing"
                  @click.stop
                >
                  <GripVertical class="h-4 w-4" />
                </span>
                <span
                  class="flex h-7 shrink-0 items-center justify-center rounded-lg border border-cyan-500/20 bg-cyan-500/10 px-2.5 font-mono font-bold whitespace-nowrap text-cyan-400"
                  :class="(item.lineName || '').length > 4 ? 'text-xs min-w-[54px]' : 'text-xs min-w-[36px]'"
                >
                  {{ item.lineName || '线路' }}
                </span>
                <span class="min-w-0 flex-1 truncate text-xs text-slate-300 lg:text-base">{{ stopSummary(item) }}</span>
                <!-- data-state 来自 reka-ui，故箭头无需本地状态绑定。 -->
                <ChevronDown
                  class="h-4 w-4 shrink-0 text-slate-400 transition-transform group-data-[state=open]:rotate-180"
                />
              </AccordionTrigger>
            </AccordionHeader>

            <!-- reka-ui 在关闭时仍保留面板挂载，并把测得的高度暴露为
                 --reka-accordion-content-height；这些工具类据此值动画，故该行滑动而不是突跳。
                 border/padding 放在内层元素上：在 border-box 计量下，height:0 的盒子仍会渲染
                 自己的边框与内边距，折叠时会留下一条多余的线。 -->
            <AccordionContent
              class="overflow-hidden data-[state=open]:animate-accordion-down data-[state=closed]:animate-accordion-up motion-reduce:data-[state=open]:animate-none motion-reduce:data-[state=closed]:animate-none"
            >
              <div class="border-t border-slate-800/60 space-y-4 px-3 pt-3 pb-3">
                <div
                  v-for="purpose in (['morning', 'evening'] as const)"
                  :key="`${item.id}_${purpose}`"
                  class="space-y-2"
                >
                  <div class="flex items-center justify-between gap-2">
                    <span class="text-xs font-medium text-slate-300 lg:text-sm">
                      {{ purpose === 'morning' ? '🏠 上班' : '🏢 下班' }}
                    </span>
                    <span
                      v-if="purposeStopsRead(item, purpose)?.state === 'reading'"
                      class="text-xs text-slate-400"
                    >
                      正在加载站点…
                    </span>
                  </div>

                  <!-- 方向在前：一个站的含义（它的编号、是否真被停靠）取决于车的行驶方向，
                       故先挑站再挑方向会展示一条用户并不乘坐的线路上的编号。 -->
                  <div class="flex flex-wrap items-center gap-2">
                    <span class="text-xs text-slate-400">方向</span>
                    <template v-if="directionOptions(item).length > 1">
                      <RadioGroupRoot
                        :model-value="chosenDirection(item, purpose) ?? undefined"
                        class="flex flex-wrap gap-2"
                        @update:model-value="(v) => onDirectionChange(item, purpose, Number(v) as 0 | 1)"
                      >
                        <RadioGroupItem
                          v-for="opt in directionOptions(item)"
                          :key="`${purpose}_${opt.direction}`"
                          :value="opt.direction"
                          class="min-h-11 rounded-lg border px-3 text-xs transition"
                          :class="chosenDirection(item, purpose) === opt.direction
                            ? 'border-cyan-500/60 bg-cyan-500/15 text-cyan-200'
                            : 'border-slate-700 bg-slate-950 text-slate-300 hover:border-cyan-500/40'"
                        >
                          {{ opt.label ?? `方向 ${opt.direction}` }}
                        </RadioGroupItem>
                      </RadioGroupRoot>
                    </template>
                    <span v-else class="text-xs text-slate-400">
                      {{ directionOptions(item)[0]?.label ?? '方向未知' }}
                    </span>
                  </div>

                  <div v-if="chosenDirection(item, purpose) === null && directionOptions(item).length > 1" class="text-xs text-slate-400">
                    请先选择方向
                  </div>
                  <template v-else>
                    <!-- 该方向完全没有站点：此处放一个选择器会永远为空，
                         故说明原因而不是展示它。 -->
                    <p
                      v-if="stationsUnavailable(item, purpose)"
                      class="text-xs text-slate-400 lg:text-base"
                    >
                      该方向暂无站点数据，无法设置上车点
                    </p>
                    <!-- 读取没答上来：这也是一个自己的事实，不是「这个方向没有站」，也不是
                         「还在读」。同样不摆一个永远空的 picker，并说清这一屏现在缺的是哪一步。 -->
                    <p
                      v-else-if="purposeStopsRead(item, purpose)?.state === 'unreadable'"
                      class="text-xs text-slate-400 lg:text-base"
                    >
                      未读到该方向的站点数据，暂时无法设置上车点
                    </p>
                    <template v-else>
                      <StationPinPicker
                        :model-value="pinnedChoice(item, purpose)"
                        :stations="purposeStations(item, purpose)"
                        :direction-label="purpose === 'morning' ? '上班' : '下班'"
                        @update:model-value="(choice) => onPinChange(item, purpose, choice)"
                      />
                      <p
                        v-if="boardStopNotice(item, purpose)"
                        class="flex items-start gap-1.5 text-xs text-amber-400"
                      >
                        <TriangleAlert class="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        <span>{{ boardStopNotice(item, purpose) }}</span>
                      </p>
                    </template>
                  </template>
                </div>

                <!-- 中性提示，不是警告：同向的选择是允许的，用户也可能就是那个意思
                     （环线、只坐一站）。每条线路只放一次，在两个方向区块之后，
                     因为它描述的是这一**对**，而不是任一目的本身。 -->
                <p
                  v-if="sameDirectionNote(item)"
                  class="flex items-start gap-1.5 text-xs text-slate-400"
                >
                  <Info class="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{{ sameDirectionNote(item) }}</span>
                </p>

                <p v-if="pinError" class="flex items-center gap-1.5 text-xs text-rose-400 lg:gap-2 lg:text-base">
                  <TriangleAlert class="h-3.5 w-3.5 shrink-0" />
                  <span>{{ pinError }}</span>
                </p>

                <button
                  class="flex min-h-[44px] items-center gap-1.5 rounded-lg border border-rose-500/20 bg-rose-500/10 px-3 text-xs text-rose-400 transition hover:bg-rose-500/20 active:scale-95 lg:gap-2 lg:px-3.5 lg:text-base"
                  @click="requestRemoval(item)"
                >
                  <X class="h-3.5 w-3.5 shrink-0" />
                  <span>取消关注</span>
                </button>
              </div>
            </AccordionContent>
          </AccordionItem>
        </LineOrderList>
      </AccordionRoot>

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

    <!-- 取消关注确认。取消关注在界面上不可逆（必须重新搜索该线路），故它要求显式确认，
         而不是在展开行内单击即触发。 -->
    <RemovalDialog
      :open="pendingRemoval !== null"
      :line-name="pendingRemoval?.lineName ?? null"
      :removing="removingFavorite"
      :error="removalError"
      @confirm="confirmRemoval"
      @cancel="pendingRemoval = null"
    />
  </div>
</template>
