<script setup lang="ts">
/**
 * 通勤链路：一屏看全已录入的链路，以及每行一个进编辑页的入口。
 *
 * 它是**列表页**：列表、拖动排序，以及标题行里的「新增链路」。录入与编辑在
 * `/settings/chains/new` 与 `/settings/chains/:chainId` 那两页里（见 `docs/PRD.md` §4.1
 * 「列表页与编辑页的分工」）。把表单就地插进列表会让页面高度随编辑态跳动、一次只能编一个，
 * 而拖动排序还得跳过编辑中的那一行。
 *
 * 行印出的摘要是**存储值**：链路自己的目的与由它推出的起点，加上每一段自己的线路与那一对
 * (站名, 站序)。它说的是这一条链路的事实，故一行也不改地随行一起进编辑页。
 *
 * 读取自己失败与「还没有录入」是两个原因，谁也不遮住谁：读失败陈述自己的成因并给出唯一能修好
 * 它的重试，绝不借用空状态的措辞 —— 后者是关于用户存了什么的主张。
 */
import { computed, onMounted, shallowRef } from 'vue'
import { storeToRefs } from 'pinia'
import { ChevronRight, GripVertical, Plus, RefreshCw, Route, TriangleAlert } from '@lucide/vue'
import type { CommuteChain } from '@real-time-transport/shared'
import { anchorForPurpose } from '@real-time-transport/shared'
import { runWithFeedback } from '@/action-feedback'
import { useTransitStore } from '@/stores/transit.store'
import { BackToSettings, DragOrderList } from './components'
import { anchorText, legPositionText, purposeText, stationPairText } from './chain-draft'

const transitStore = useTransitStore()
const { commuteChains } = storeToRefs(transitStore)

const rows = computed(() => commuteChains.value)

/** 在已存链路的首次读取作答之前为 true。 */
const loading = shallowRef(true)
/** 读取本身失败——它自己的状态，绝不借用空状态的措辞。 */
const loadError = shallowRef<string | null>(null)

/**
 * 读取已存的链路。
 *
 * 读失败陈述为自己的成因，并给出唯一能修好它的重试——绝不措辞成空状态的「还没有录入」，
 * 那会声称一种无人读过的空。这里不按定时器重读：本页就是写这份列表的东西，
 * 故唯一可能失败的读取，是用户打开本屏所求的那一次。
 */
async function load(): Promise<void> {
  loading.value = true
  const answered = await transitStore.fetchCommuteChains()
  loading.value = false
  loadError.value = answered ? null : '换乘链读取失败'
}

onMounted(() => {
  void load()
})

/** 上一次排序写入的失败，好让被拒绝的拖放绝不沉默。 */
const orderError = shallowRef<string | null>(null)

/**
 * 落一次拖放：被拖动的链路占据它落在其上的那条链路的格子（`moveCommuteChain`）。
 *
 * 一次排序**不**碰链路的其他字段 —— 名字、目的、乘车段、接驳方式都不在这次写入里；
 * 写入失败的顺序会弹回存储里的那个，故拒绝在这里说出原因，而不是让列表悄悄变回去。
 */
async function onReorder(movedId: string, anchorId: string): Promise<void> {
  orderError.value = null
  try {
    await runWithFeedback('chain-reorder', () => transitStore.moveCommuteChain(movedId, anchorId))
  }
  catch (err) {
    orderError.value = err instanceof Error ? err.message : '顺序保存失败'
  }
}

/** 一条链路的编辑页地址。**绝不发明默认值**：认不出的 id 由那一页自己说不存在。 */
function editorHref(chain: CommuteChain): string {
  return `/settings/chains/${chain.id}`
}

/**
 * 「上班 · 从「家」出发」——链路自己的目的，加上由它推出的起点。
 * 起点不是链路上的一列，故这里与引擎读的是同一个推导（`anchorForPurpose`）。
 */
function chainMeta(chain: CommuteChain): string {
  return `${purposeText(chain.purpose)} · 从「${anchorText(anchorForPurpose(chain.purpose))}」出发`
}

/** 「第 1 段 · 快线 1 路：东大桥 第3站 → 建国门 第4站」，未选的那一半留为空缺。 */
function legText(chain: CommuteChain, index: number): string {
  const leg = chain.legs[index]!
  return `${legPositionText(index)} · ${leg.lineName}：${stationPairText(leg.boardStationName, leg.boardStationOrder)} → ${stationPairText(leg.alightStationName, leg.alightStationOrder)}`
}

/** 配置了额外时间的段显示「接驳额外 5 分」；为 null 时什么都不显示。 */
function legExtraText(chain: CommuteChain, index: number): string | null {
  const minutes = chain.legs[index]!.transferExtraMinutes
  return minutes === null ? null : `接驳额外 ${minutes} 分`
}

/**
 * 段的接驳方式，如使用者选的：null 是「没选过」，它以自己的字显示，
 * 绝不显示成步行 —— 那会把一个没人做过的选择当成他的选择。
 */
const MODE_TEXT = { walk: '步行', cycle: '骑行' } as const

function legModeText(chain: CommuteChain, index: number): string {
  const mode = chain.legs[index]!.connectionMode
  return mode === null ? '接驳未选方式' : `接驳${MODE_TEXT[mode]}`
}
</script>

<template>
  <div class="mx-auto max-w-3xl space-y-6 pb-12">
    <BackToSettings />
    <h2 class="text-xl font-bold text-white md:text-2xl">
      通勤链路
    </h2>

    <!-- 该区域由它自己可见的标题命名，而不是由 `aria-label` 里该文本的副本：标签属性会
         重复标题已经渲染的词，故屏幕阅读器先播区域、再播标题，「通勤链路」会被听两遍。
         `aria-labelledby` 指向标题的文本，故名字**就是**标题。 -->
    <section
      aria-labelledby="commute-chain-heading"
      class="rounded-3xl border border-slate-800 bg-slate-900/80 p-4 shadow-xl sm:p-5"
    >
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h3 class="flex items-center gap-2 text-sm font-semibold text-slate-200 lg:text-base">
          <Route class="h-4 w-4 shrink-0 text-cyan-400" aria-hidden="true" />
          <span id="commute-chain-heading">通勤链路</span>
          <!-- 条数是关于已存列表的事实，故只在列表被**读取**之后印出：从失败的读取取来的条数，
               是一个无人取得过的数字。 -->
          <span v-if="!loading && !loadError && rows.length > 0" class="font-normal text-slate-400">({{ rows.length }})</span>
        </h3>
        <!-- 新增是一条链路自己的页面，故它是一个链接而不是就地展开：脚本跳转要自己接语义、
           键盘可达与「在新标签页打开」，而这三样浏览器原生就给了。 -->
        <RouterLink
          to="/settings/chains/new"
          class="flex min-h-[44px] items-center gap-1.5 rounded-xl border border-cyan-500/30 bg-cyan-500/10 px-3 text-xs font-semibold text-cyan-400 transition hover:bg-cyan-500/20 active:scale-95 lg:text-base"
        >
          <Plus class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>新增链路</span>
        </RouterLink>
      </div>

      <p class="mt-1 text-xs text-slate-400">
        链路自己录入，不由系统规划：逐段选线路、上车站与下车站
      </p>

      <!-- 读取自己的失败，以及唯一能修好它的东西。 -->
      <div v-if="loadError" class="mt-3 flex flex-wrap items-center gap-2">
        <p class="flex items-center gap-1.5 text-xs text-rose-400 lg:text-base">
          <TriangleAlert class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{{ loadError }}</span>
        </p>
        <button
          type="button"
          class="flex min-h-[44px] items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-950 px-3 text-xs text-slate-200 transition hover:border-cyan-500/40 active:scale-95 lg:text-base"
          @click="load"
        >
          <RefreshCw class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>重试</span>
        </button>
      </div>

      <!-- 仍在读取：这不是空状态，也不得借用它的措辞。 -->
      <p v-else-if="loading" class="mt-3 text-xs text-slate-400 lg:text-base">
        正在读取换乘链…
      </p>

      <!-- 什么都没录入：成因是本页自己的主题，动作是它上面的那个链接。
           上面的读失败是另一个成因，绝不被这一个遮住。 -->
      <p
        v-else-if="rows.length === 0"
        class="mt-3 rounded-xl border border-dashed border-slate-800 bg-slate-950/60 p-4 text-xs text-slate-400 lg:text-base"
      >
        还没有录入通勤链路。点「新增链路」逐段录入：名称、通勤目的，加上每一段的线路、上车站与下车站
      </p>

      <!-- 各行是**存储**顺序，而这条列表正是编辑那个顺序的地方，故它经与关注线路列表共用的
           拖动容器渲染。`tag="ul"`：它仍是一份列表，不是一摞 div。

           整行是进编辑页的**链接**，行内不放编辑器；拖拽手柄与链接是**两个**元素：手柄自己吃掉
           按压（`@click.stop`），点行才进编辑。手柄若长在链接里，一次抓取会同时被读成一次导航。 -->
      <DragOrderList
        v-else
        :items="rows"
        tag="ul"
        class="mt-3 divide-y divide-slate-800/80 rounded-xl border border-slate-800 bg-slate-950"
        @move="onReorder"
      >
        <li v-for="chain in rows" :key="chain.id" class="flex items-center">
          <!-- 拖拽唯一可以开始的地方。整行任意位置都响应按压的行会吞掉翻页的滑动、并与进入
               编辑页的点击相争；touch-none 阻止浏览器认领手柄自己的手势。它是本行的手指落点，
               故两个方向都是 44px。 -->
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
            :to="editorHref(chain)"
            class="flex min-h-[44px] min-w-0 flex-1 items-center gap-2.5 py-2 pr-3 transition hover:bg-slate-900/60"
          >
            <span class="min-w-0 flex-1 space-y-0.5">
              <span class="block truncate text-xs font-semibold text-slate-200 lg:text-base">{{ chain.name }}</span>
              <span class="block text-xs text-slate-400">{{ chainMeta(chain) }}</span>
              <!-- 每一段一行，与编辑页里说同一批事实的那些句子共用同一份判断。名字截断，段落的
                   文字换行：行宽由容器决定，绝不把行尾的箭头挤出屏外。 -->
              <span v-for="(_, index) in chain.legs" :key="index" class="block text-xs text-slate-300">
                {{ legText(chain, index) }}
                <span class="text-slate-400">
                  · {{ legModeText(chain, index) }}<template v-if="legExtraText(chain, index)"> · {{ legExtraText(chain, index) }}</template>
                </span>
              </span>
            </span>
            <ChevronRight class="h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
          </RouterLink>
        </li>
      </DragOrderList>

      <!-- 落下的行立即被写入，故被拒绝的写入必须在此说明：列表已经弹回存储顺序，
           否则会看起来像那次拖拽从未发生。 -->
      <p
        v-if="orderError"
        class="mt-2 flex items-center gap-1.5 text-xs text-rose-400 lg:text-base"
      >
        <TriangleAlert class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>{{ orderError }}</span>
      </p>
    </section>
  </div>
</template>
