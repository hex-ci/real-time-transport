<script setup lang="ts">
/**
 * 一条通勤链路自己的页面：`/settings/chains/new` 与 `/settings/chains/:chainId` 共用它。
 *
 * 内容是原先插在卡片里的那块表单（名称、通勤目的、各段乘车段），原样搬过来 —— 区别是它现在
 * 有草稿语义：改了字段按「保存」才落库，取消（或直接返回）丢弃这次改动（见 `docs/PRD.md` §4.1）。
 * 把表单插在列表里时，页面高度随编辑态跳动、一次只能编一个。
 *
 * 删除链路也在这里，不在列表行上：它是这一条自己的事，且要进来看到全貌之后才做得出来。
 * **新建页没有它** —— 一条还不存在的链路没什么可删的。确认弹窗与列表行时代的那个是同一个
 * （`ChainRemovalDialog`）。
 *
 * 认不出的参数**不发明默认值**：`chainId` 是服务端生成的行 id，取值范围开放，故路由表不加正则，
 * 由本页在链路列表**作答**之后说「这条链路不存在」。读取还没作答时什么都不说 —— 那时候没人知道
 * 这个 id 有没有对应一行。
 *
 * 表单要等它的前提有答案才挂载：一份已存链路的草稿是从**线路选项**里解析出来的（地铁的两个方向
 * 共用一个 id，一段走哪边靠它自己的站序在选项的站点列表里定位），在那些列表还在路上时就起草，
 * 会把这一段读到列表里的第一条，而保存会把它写到他没坐过的那个方向上去。
 */
import { computed, onMounted, shallowRef } from 'vue'
import { useRouter } from 'vue-router'
import { RefreshCw, Trash2, TriangleAlert } from '@lucide/vue'
import { storeToRefs } from 'pinia'
import type { CommuteChain } from '@real-time-transport/shared'
import { readingText, type ReadValue } from '@/read-state'
import { runWithFeedback } from '@/action-feedback'
import { useTransitStore } from '@/stores/transit.store'
import type { CommuteChainWrite } from '@/stores/transit.store'
import { BackToSettings, ChainForm, ChainRemovalDialog } from './components'
import { editorOptionsFor } from './chain-draft'
import { settingsReadOf } from './index-summary'
import type { StoredAnchors } from './anchors'
import { useLineStops } from './line-stops'

const props = defineProps<{ chainId: string | null }>()

const transitStore = useTransitStore()
const router = useRouter()
const { commuteChains } = storeToRefs(transitStore)

const {
  chainLineOptions,
  favoritesRead,
  readFavorites,
} = useLineStops()

/**
 * 家与公司的坐标，以及这次读取自己的三种状态。
 *
 * 答不上来时记成「未读到」，绝不记成「未设置」——后者是关于用户存了什么的主张，
 * 而这个请求根本没有作答。读取作答而两处都没坐标时，`settingsReadOf` 给出的是已读到、
 * 坐标为 null，由参考点自己的规则说成「未设置家的位置」。
 */
const anchorsRead = shallowRef<ReadValue<StoredAnchors>>({ state: 'reading' })

async function readAnchors(): Promise<void> {
  try {
    const res = await fetch('/api/transit/settings')
    anchorsRead.value = settingsReadOf(await res.json()).anchors
  }
  catch {
    anchorsRead.value = { state: 'unreadable' }
  }
}

/** 在已存链路的首次读取作答之前为 true。 */
const loading = shallowRef(true)
/** 读取本身失败——它自己的状态，绝不借用空状态的措辞。 */
const loadError = shallowRef<string | null>(null)

/**
 * 读取已存的链路。
 *
 * 与列表页同一条读法：读失败陈述为自己的成因，并给出唯一能修好它的重试。
 */
async function load(): Promise<void> {
  loading.value = true
  const answered = await transitStore.fetchCommuteChains()
  loading.value = false
  loadError.value = answered ? null : '换乘链读取失败'
}

onMounted(() => {
  void readAnchors()
  void load()
})

/** 这一页在编的那一条；新建页（`chainId` 为 null）没有它。 */
const chain = computed<CommuteChain | null>(() => (props.chainId === null
  ? null
  : commuteChains.value.find(item => item.id === props.chainId) ?? null))

/** 参数认不出：列表作答了，而这一条不在其中。 */
const missing = computed(() => props.chainId !== null
  && !loading.value && loadError.value === null && chain.value === null)

/**
 * 已存链路的每一段，其方向是否已经读得出来。
 *
 * 一个线路 id 只对应一个方向时（公交的两个方向是两个 id），这一段走哪边已由 id 定死，
 * 列表到没到都不影响起草。地铁两个方向共用一个 id，方向要靠已存站序在站点列表里定位，故那种段
 * 必须等到那份列表有答案（答了站表，或答不上来）才起草。
 */
const draftsResolvable = computed(() => {
  const row = chain.value
  if (!row) return true
  return row.legs.every((leg) => {
    const candidates = chainLineOptions.value.filter(option => option.lineId === leg.lineId)
    if (candidates.length <= 1) return true
    return candidates.every(option => option.stops !== 'loading')
  })
})

/** 表单挂载前还缺哪一次读取；它说的话就是屏幕上正在等的东西。 */
const waitingText = computed(() => {
  if (loading.value) return readingText('换乘链')
  if (favoritesRead.value === 'reading') return readingText('关注线路')
  return readingText('关注线路的站点')
})

/** 表单可以挂载了：前提都有答案，而这一页确实有一条链路要编。 */
const formReady = computed(() => !loading.value && loadError.value === null
  && !missing.value && favoritesRead.value !== 'reading' && draftsResolvable.value)

/**
 * 表单可提供的线路：已关注的各方向，加上被编辑的链路已经命名、而如今无法再从选项中选到的
 * 那条线路。没有后半部分，一条线路已被取消关注的已存段打开时会没有线路被选中，
 * 而保存会拒绝一份用户从未做过的草稿。
 */
const editorLines = computed(() => editorOptionsFor(chain.value, chainLineOptions.value))

const saving = shallowRef(false)
/** 服务端对上一次保存的拒绝，逐字。 */
const saveError = shallowRef<string | null>(null)

/**
 * 保存：草稿落库的唯一时刻，成功之后回列表。
 *
 * 这一条已经存下来了，留在这一页只会是一份与存储一致的草稿；而新建页上留着的是一张空表单，
 * 那看起来像刚写的没存上。写入路径与列表行时代完全相同（`saveCommuteChain`）。
 */
async function onSubmit(write: CommuteChainWrite): Promise<void> {
  if (saving.value) return
  saving.value = true
  saveError.value = null
  try {
    await runWithFeedback(
      'chain-save',
      () => transitStore.saveCommuteChain(chain.value?.id ?? null, write),
      { name: write.name },
    )
    await router.push('/settings/chains')
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

/** 删除确认开着没有，以及上一次尝试的失败。 */
const removalOpen = shallowRef(false)
const removing = shallowRef(false)
const removalError = shallowRef<string | null>(null)

/**
 * 移除这一条，并让对话框保持到请求落定：拒绝会把原因留在用户刚按下的控件上，
 * 而不是那一行静默地原地不动。
 *
 * 成功之后回列表：这一条已经不在存储里，留在这一页只会渲染成「这条链路不存在」。
 */
async function confirmRemoval(): Promise<void> {
  const target = chain.value
  if (!target?.id || removing.value) return
  // 在闭包里读到的 id 不再是被守卫过的那个属性，故先取出它。
  const chainId = target.id
  removing.value = true
  removalError.value = null
  try {
    await runWithFeedback(
      'chain-remove',
      () => transitStore.removeCommuteChain(chainId),
      { name: target.name },
    )
    removalOpen.value = false
    await router.push('/settings/chains')
  }
  catch (err) {
    removalError.value = err instanceof Error ? err.message : '链路删除失败'
  }
  finally {
    removing.value = false
  }
}
</script>

<template>
  <div class="mx-auto max-w-3xl space-y-6 pb-12">
    <BackToSettings to="/settings/chains" label="返回通勤链路" />

    <!-- 读取还没作答：这一帧里没人知道这个 id 有没有对应一行，故「不存在」这句话还说不出来。 -->
    <p v-if="loading" class="rounded-3xl border border-slate-800 bg-slate-900/60 p-8 text-center text-sm text-slate-400 lg:text-base">
      {{ waitingText }}
    </p>

    <!-- 读取没答上来：这是它自己的事实，带着唯一能改变它的重试；也不是「不存在」。 -->
    <div v-else-if="loadError" class="rounded-3xl border border-slate-800 bg-slate-900/60 p-6">
      <p class="flex items-center gap-1.5 text-sm text-rose-400 lg:text-base">
        <TriangleAlert class="h-4 w-4 shrink-0" aria-hidden="true" />
        <span>{{ loadError }}</span>
      </p>
      <button
        type="button"
        class="mt-3 flex min-h-[44px] items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-950 px-3 text-xs text-slate-200 transition hover:border-cyan-500/40 active:scale-95 lg:text-base"
        @click="load"
      >
        <RefreshCw class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>重试</span>
      </button>
    </div>

    <!-- 读取作答而这一条不在其中：这就是「这条链路不存在」。不给第二个返回控件 ——
         上面那个已经指向链路列表，两枚同目标的按钮只会让人犹豫。 -->
    <div v-else-if="missing" class="rounded-3xl border border-slate-800 bg-slate-900/60 p-8 text-center">
      <p class="text-sm font-semibold text-slate-200 lg:text-base">这条链路不存在</p>
    </div>

    <!-- 前提还没答完：这一帧里起草会把一段的方向读错，故说出还在等的是哪一次读取。 -->
    <p v-else-if="!formReady" class="rounded-3xl border border-slate-800 bg-slate-900/60 p-8 text-center text-sm text-slate-400 lg:text-base">
      {{ waitingText }}
    </p>

    <template v-else>
      <h2 class="text-xl font-bold text-white md:text-2xl">
        {{ chain === null ? '新增链路' : `编辑 ${chain.name}` }}
      </h2>

      <section class="rounded-3xl border border-slate-800 bg-slate-900/80 p-4 shadow-xl sm:p-5">
        <p class="text-xs text-slate-400 lg:text-base">
          逐段录入，不由系统规划
        </p>

        <!-- `key` 跟着编的是哪一条走：vue-router 在同一条路由记录上复用同一个组件实例，
             故从一条的页面进到另一条时，草稿必须重新起草 —— 否则按保存会把上一条写下来。 -->
        <ChainForm
          :key="chain?.id ?? 'new'"
          class="mt-3"
          :chain="chain"
          :lines="editorLines"
          :lines-read="favoritesRead"
          :anchors-read="anchorsRead"
          :saving="saving"
          :error="saveError"
          @submit="onSubmit"
          @edit="onDraftEdit"
          @retry-lines="readFavorites"
        >
          <!-- 破坏性动作：新建页没有它（一条还不存在的链路没什么可删的），且它要进得来看过
               全貌之后才做得出。 -->
          <template v-if="chain" #actions>
            <button
              type="button"
              class="flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-xl border border-rose-500/20 bg-rose-500/10 px-3 text-xs text-rose-400 transition hover:bg-rose-500/20 active:scale-95 lg:gap-2 lg:px-3.5 lg:text-base"
              @click="removalOpen = true"
            >
              <Trash2 class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>删除链路</span>
            </button>
          </template>
        </ChainForm>
      </section>
    </template>

    <!-- 删除链路确认。删除在界面上不可逆（每一段都是逐条录入的），故它要求显式确认。 -->
    <ChainRemovalDialog
      :open="removalOpen"
      :chain-name="chain?.name ?? null"
      :removing="removing"
      :error="removalError"
      @confirm="confirmRemoval"
      @cancel="removalOpen = false"
    />
  </div>
</template>
