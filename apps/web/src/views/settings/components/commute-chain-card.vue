<script setup lang="ts">
/**
 * 通勤链路的编辑器，作为 设置 自己的一张卡片：用户录入的链路，以及创建、编辑与删除它们的
 * 唯一之处。
 *
 * 它是本屏内的**卡片**而非独立页面：链路由使用者录入，而链路页是读结论的地方、不是录入的
 * 地方——首页旁的一级入口展示链路得出的结论，而录入属于其他「一次设定的偏好」。
 *
 * 这里不计算任何结论：没有余量、没有等待、没有任何形式的时长。编辑器记录事实（一条线路、
 * 一个上车站、一个下车站），链路页才是把它们对着实时读数走一遍的地方。一次保存由服务端
 * 自己的存储记录作答，故列表绝不会展示一条服务端并不持有的链路；
 * 而拒绝被逐字印出，绝不吞掉。
 *
 * 列表同时是可拖动的存储顺序：拖动即是写入 `displayOrder`（与关注线路列表共用
 * `drag-order-list.vue`），新增落到末尾。一次排序不是一次编辑，故它只写序号，
 * 名字、目的、乘车段与接驳方式都不被那次请求碰到。
 */
import { computed, onMounted, shallowRef } from 'vue'
import { GripVertical, Pencil, Plus, RefreshCw, Route, Trash2, TriangleAlert } from '@lucide/vue'
import { storeToRefs } from 'pinia'
import type { CommuteChain } from '@real-time-transport/shared'
import { anchorForPurpose } from '@real-time-transport/shared'
import ChainForm from './chain-form.vue'
import ChainRemovalDialog from './chain-removal-dialog.vue'
import DragOrderList from './drag-order-list.vue'
import type { ReadState, ReadValue } from '@/read-state'
import type { StoredAnchors } from '../anchors'
import { useTransitStore } from '@/stores/transit.store'
import type { CommuteChainWrite } from '@/stores/transit.store'
import {
  anchorText,
  editorOptionsFor,
  legPositionText,
  purposeText,
  stationPairText,
} from '../chain-draft'
import type { ChainLineOption } from '../types'

const props = defineProps<{
  /** 一段乘车段可以命名的每条线路+方向，由加载它们的页面提供。 */
  lines: ChainLineOption[]
  /**
   * 关注线路读取自己的状态，原样透传给编辑器。
   *
   * 页面（`chains.vue`）拥有那次读取——它属于 `line-stops.ts`，与关注线路共享——而编辑器
   * 是感受其缺席的那个界面，故卡片把状态与重试夹在中间，而不是自己去判断任何一个。
   */
  linesRead: ReadState
  /**
   * 家与公司的坐标，以及它们那次读取自己的状态，原样透传给编辑器。
   *
   * 录入屏要按它量每个站到链路的起点/目的有多远，故这一读数属于本屏；卡片只把它夹在中间，
   * 不自己去判断（「没存下来」与「没读到」是两句不同的话）。
   */
  anchorsRead: ReadValue<StoredAnchors>
}>()

const emit = defineEmits<{
  (e: 'retry-lines'): void
}>()

const transitStore = useTransitStore()
const { commuteChains } = storeToRefs(transitStore)

/** 在已存链路的首次读取作答之前为 true。 */
const loading = shallowRef(true)
/** 读取本身失败——它自己的状态，绝不借用空状态的措辞。 */
const loadError = shallowRef<string | null>(null)

/** 编辑器打开在哪条链路上：新的、已存的，或没有。 */
const editing = shallowRef<{ chain: CommuteChain | null } | null>(null)
const saving = shallowRef(false)
/** 服务端对上一次保存的拒绝，逐字。 */
const saveError = shallowRef<string | null>(null)

/** 排队等待移除的链路，以及上一次尝试的失败。 */
const pendingRemoval = shallowRef<CommuteChain | null>(null)
const removing = shallowRef(false)
const removalError = shallowRef<string | null>(null)

const rows = computed(() => commuteChains.value)

/** 上一次排序写入的失败，好让被拒绝的拖放绝不沉默。 */
const orderError = shallowRef<string | null>(null)

/**
 * 打开的编辑器可以提供哪些线路：页面已关注的，加上被编辑的链路已经命名、而如今无法再从
 * 选项中选到的那条线路。没有后半部分，一条线路已被取消关注的已存段打开时会没有线路被选中，
 * 而保存会拒绝一份用户从未做过的草稿。
 */
const editorLines = computed(() => editorOptionsFor(editing.value?.chain ?? null, props.lines))

/**
 * 读取已存的链路。
 *
 * 读失败陈述为自己的成因，并给出唯一能修好它的重试——绝不措辞成空状态的「还没有录入」，
 * 那会声称一种无人读过的空。这里不按定时器重读：本卡片就是写这份列表的东西，
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

function openCreate(): void {
  saveError.value = null
  editing.value = { chain: null }
}

function openEdit(chain: CommuteChain): void {
  saveError.value = null
  editing.value = { chain }
}

function closeEditor(): void {
  editing.value = null
  saveError.value = null
}

async function onSubmit(write: CommuteChainWrite): Promise<void> {
  const target = editing.value
  if (!target) return
  saving.value = true
  saveError.value = null
  try {
    await transitStore.saveCommuteChain(target.chain?.id ?? null, write)
    editing.value = null
  }
  catch (err) {
    // 契约自己的消息，按服务端的措辞。
    saveError.value = err instanceof Error ? err.message : '链路保存失败'
  }
  finally {
    saving.value = false
  }
}

/**
 * 已作答的保存之后，草稿又变了。
 *
 * 服务端的拒绝是关于**那份**草稿产生的请求，故一旦它点名的输入被编辑，那句话就在描述一个
 * 不再存在的请求——与表单退回它自己的拒绝是同一个「声称活得比状态久」，此处为服务端的
 * 拒绝而退回。没有任何损失：下一次保存会重新作答。
 */
function onDraftEdit(): void {
  saveError.value = null
}

/**
 * 落一次拖放：被拖动的链路占据它落在其上的那条链路的格子（`moveCommuteChain`）。
 *
 * 一次排序**不**碰链路的其他字段 —— 名字、目的、乘车段、接驳方式都不在这次写入里；
 * 写入失败的顺序会弹回存储里的那个，故拒绝在这里说出原因，而不是让列表悄悄变回去。
 */
async function onReorder(movedId: string, anchorId: string): Promise<void> {
  orderError.value = null
  try {
    await transitStore.moveCommuteChain(movedId, anchorId)
  }
  catch (err) {
    orderError.value = err instanceof Error ? err.message : '顺序保存失败'
  }
}

function requestRemoval(chain: CommuteChain): void {
  removalError.value = null
  pendingRemoval.value = chain
}

/**
 * 移除排队的链路，并让对话框保持到请求落定：拒绝会把原因留在用户刚按下的控件上，
 * 而不是那一行静默地原地不动。
 */
async function confirmRemoval(): Promise<void> {
  const target = pendingRemoval.value
  if (!target?.id || removing.value) return
  removing.value = true
  removalError.value = null
  try {
    await transitStore.removeCommuteChain(target.id)
    pendingRemoval.value = null
  }
  catch (err) {
    removalError.value = err instanceof Error ? err.message : '链路删除失败'
  }
  finally {
    removing.value = false
  }
}

/**
 * 「上班 · 从「家」出发」——链路自己的目的，加上由它推出的起点。
 * 起点不是链路上的一列，故这里与卡片、引擎读的是同一个推导（`anchorForPurpose`）。
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
        <span v-if="rows.length > 0" class="font-normal text-slate-400">({{ rows.length }})</span>
      </h3>
      <button
        type="button"
        class="flex min-h-[44px] items-center gap-1.5 rounded-xl border border-cyan-500/30 bg-cyan-500/10 px-3 text-xs font-semibold text-cyan-400 transition hover:bg-cyan-500/20 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
        :disabled="editing !== null"
        @click="openCreate"
      >
        <Plus class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>新增链路</span>
      </button>
    </div>

    <p class="mt-1 text-xs text-slate-400">
      链路自己录入，不由系统规划：逐段选线路、上车站与下车站
    </p>

    <ChainForm
      v-if="editing"
      :key="editing.chain?.id ?? 'new'"
      class="mt-3 border-t border-slate-800/60 pt-3"
      :chain="editing.chain"
      :lines="editorLines"
      :lines-read="linesRead"
      :anchors-read="anchorsRead"
      :saving="saving"
      :error="saveError"
      @submit="onSubmit"
      @cancel="closeEditor"
      @edit="onDraftEdit"
      @retry-lines="emit('retry-lines')"
    />

    <!-- 读取自己的失败，以及唯一能修好它的东西。 -->
    <div v-if="loadError" class="mt-3 flex flex-wrap items-center gap-2">
      <p class="flex items-center gap-1.5 text-xs text-rose-400">
        <TriangleAlert class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>{{ loadError }}</span>
      </p>
      <button
        type="button"
        class="flex min-h-[44px] items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-950 px-3 text-xs text-slate-200 transition hover:border-cyan-500/40 active:scale-95"
        @click="load"
      >
        <RefreshCw class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>重试</span>
      </button>
    </div>

    <!-- 仍在读取：这不是空状态，也不得借用它的措辞。 -->
    <p v-else-if="loading" class="mt-3 text-xs text-slate-400">
      正在读取换乘链…
    </p>

    <!-- 什么都没录入：成因是本卡片自己的主题，动作是它上面的控件。
         上面的读失败是另一个成因，绝不被这一个遮住。 -->
    <p
      v-else-if="rows.length === 0"
      class="mt-3 rounded-xl border border-dashed border-slate-800 bg-slate-950/60 p-4 text-xs text-slate-400"
    >
      还没有录入通勤链路。点「新增链路」逐段录入：名称、通勤目的，加上每一段的线路、上车站与下车站
    </p>

    <!-- 各行是**存储**顺序，而这条列表正是编辑那个顺序的地方，故它经与关注线路列表共用的
         拖动容器渲染。`tag="ul"`：它仍是一份列表，不是一摞 div。 -->
    <DragOrderList
      v-else
      :items="rows"
      tag="ul"
      class="mt-3 divide-y divide-slate-800/80 rounded-xl border border-slate-800 bg-slate-950"
      @move="onReorder"
    >
      <li v-for="chain in rows" :key="chain.id" class="flex items-start gap-2 p-3">
        <!-- 拖拽唯一可以开始的地方。整行任意位置都响应按压的行会吞掉翻页的滑动、并与「编辑」
             的点按相争；touch-none 阻止浏览器认领手柄自己的手势。它是本行的手指落点，故两个
             方向都是 44px 的触控目标，并带着它做的事作为名字 —— 一个只有图标的名字说不出
             它做什么。 -->
        <button
          type="button"
          data-drag-handle
          aria-label="拖动排序"
          title="拖动调整顺序"
          class="flex min-h-[44px] min-w-[44px] shrink-0 cursor-grab touch-none items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-800/60 hover:text-slate-300 active:cursor-grabbing"
        >
          <GripVertical class="h-4 w-4" aria-hidden="true" />
        </button>
        <div class="min-w-0 flex-1 space-y-1.5">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <div class="truncate text-xs font-semibold text-slate-200">
                {{ chain.name }}
              </div>
              <div class="mt-0.5 text-xs text-slate-400">
                {{ chainMeta(chain) }}
              </div>
            </div>
            <div class="flex shrink-0 items-center gap-1.5">
              <button
                type="button"
                class="flex min-h-[44px] items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-3 text-xs text-slate-200 transition hover:border-cyan-500/40 active:scale-95"
                @click="openEdit(chain)"
              >
                <Pencil class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>编辑</span>
              </button>
              <button
                type="button"
                class="flex min-h-[44px] items-center gap-1.5 rounded-lg border border-rose-500/20 bg-rose-500/10 px-3 text-xs text-rose-400 transition hover:bg-rose-500/20 active:scale-95"
                @click="requestRemoval(chain)"
              >
                <Trash2 class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>删除</span>
              </button>
            </div>
          </div>
          <div class="space-y-0.5">
            <p v-for="(_, index) in chain.legs" :key="index" class="text-xs text-slate-300">
              {{ legText(chain, index) }}
              <span class="text-slate-400">
                · {{ legModeText(chain, index) }}<template v-if="legExtraText(chain, index)"> · {{ legExtraText(chain, index) }}</template>
              </span>
            </p>
          </div>
        </div>
      </li>
    </DragOrderList>

    <!-- 落下的行立即被写入，故被拒绝的写入必须在此说明：列表已经弹回存储顺序，
         否则会看起来像那次拖拽从未发生。 -->
    <p
      v-if="orderError"
      class="mt-2 flex items-center gap-1.5 text-xs text-rose-400"
    >
      <TriangleAlert class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>{{ orderError }}</span>
    </p>

    <ChainRemovalDialog
      :open="pendingRemoval !== null"
      :chain-name="pendingRemoval?.name ?? null"
      :removing="removing"
      :error="removalError"
      @confirm="confirmRemoval"
      @cancel="pendingRemoval = null"
    />
  </section>
</template>
