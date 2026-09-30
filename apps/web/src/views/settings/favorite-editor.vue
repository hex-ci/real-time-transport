<script setup lang="ts">
/**
 * 一条关注线路自己的页面：`/settings/lines/:favoriteId`。
 *
 * 内容就是原先在列表行里就地展开的那一块（上班 / 下班两段：方向 + 上车点），原样搬过来 ——
 * 区别是它现在有草稿语义：改方向或上车点只改这一页的草稿，按「保存」才落库，返回（或点返回控件）
 * 丢弃这次改动（见 `docs/PRD.md` §4.1）。就地展开时每一次选择都当场写库，故没有「保存」这一步。
 *
 * 取消关注也在这里，不在列表行上：它是这一条自己的事，且要进来看到全貌之后才做得出来。
 * 确认弹窗与列表行时代的那个是同一个（`RemovalDialog`）。
 *
 * 认不出的参数**不发明默认值**：`/settings/lines/:favoriteId` 的 id 空间是开放的（服务端生成的
 * 行 id），故路由表不加正则，由本页在关注列表**作答**之后说「这条关注不存在」。读取还没作答时
 * 什么都不说 —— 那时候没人知道这个 id 有没有对应一行。
 */
import { computed, shallowRef, watch } from 'vue'
import { useRouter } from 'vue-router'
import { RadioGroupItem, RadioGroupRoot } from 'reka-ui'
import { Info, RefreshCw, TriangleAlert, X } from '@lucide/vue'
import type { UserFavoriteLine } from '@real-time-transport/shared'
import { readingText, unreadText } from '@/read-state'
import { runWithFeedback } from '@/action-feedback'
import { useTransitStore } from '@/stores/transit.store'
import { BackToSettings, RemovalDialog, StationPinPicker } from './components'
import { COMMUTE_PURPOSES, useFavoriteSlots, type CommutePurpose } from './favorite-slots'
import { useLineStops } from './line-stops'
import type { StationChoice } from './types'

const props = defineProps<{ favoriteId: string }>()

const transitStore = useTransitStore()
const router = useRouter()

const stops = useLineStops()
const {
  cityFavorites,
  favoritesRead,
  readFavorites,
} = stops

const {
  storedSlot,
  purposeStations,
  purposeStopsRead,
  stationsUnavailable,
  boardStopNotice,
  sameDirectionNote,
} = useFavoriteSlots(stops)

/**
 * 这一页在编的那一行，或 null。
 *
 * 只在**当前城市**的关注列表里找：列表页一次只展示一个城市，而本页是从那一行进来的，
 * 故它不把另一城市里碰巧同 id 的行当成这一条。
 */
const favorite = computed<UserFavoriteLine | null>(() =>
  cityFavorites.value.find(item => item.id === props.favoriteId) ?? null,
)

/** 草稿里一个目的的两件东西；`null` 表示用户还没选过方向。 */
interface SlotDraft {
  direction: 0 | 1 | null
  stop: StationChoice | null
}

type Draft = Record<CommutePurpose, SlotDraft>

/**
 * 这一页的草稿，或 null（还没有一行可以据以起草）。
 *
 * 从**存储值**起草：方向取生效的那一个（单向线路上就是它唯一的方向），上车点取这一对。
 *
 * 起草的时机是**换了哪一条**，不是「每次存储值变了」：同一条上的一次后台重读不该把用户手里的
 * 改动抹掉，而 vue-router 在 `/settings/lines/a` 与 `/settings/lines/b` 之间会**复用**同一个组件
 * 实例（同一条路由记录），故草稿必须跟着 id 走 —— 否则从一条的页面进到另一条时，屏幕上还是上一条
 * 的草稿，按保存就会把上一条的字段写到这一条上。
 */
const draft = shallowRef<Draft | null>(null)
/** 当前草稿是为哪一条起草的；`null` 表示还没起草。 */
const draftedFor = shallowRef<string | null>(null)

function draftOf(fav: UserFavoriteLine): Draft {
  const slotOfPurpose = (purpose: CommutePurpose): SlotDraft => {
    const stored = storedSlot(fav, purpose)
    return {
      direction: stored.direction,
      stop: stored.stop ? { name: stored.stop.name, order: stored.stop.order } : null,
    }
  }
  return { morning: slotOfPurpose('morning'), evening: slotOfPurpose('evening') }
}

/** 这一页现在编的是哪一条；参数换了就是换了一条。 */
const editingId = computed(() => favorite.value?.id ?? null)

watch(editingId, (id) => {
  if (id === null || id === draftedFor.value) return
  const row = favorite.value
  if (!row) return
  draftedFor.value = id
  draft.value = draftOf(row)
}, { immediate: true })

/** 保存成功之后：草稿从存储值重新起草，故「改动过」回到空。 */
function redraft(): void {
  const row = favorite.value
  if (!row) return
  draft.value = draftOf(row)
}

/** 一个目的当前的取值，按草稿；草稿还没起草时是空。 */
function slotOf(purpose: CommutePurpose): SlotDraft {
  return draft.value?.[purpose] ?? { direction: null, stop: null }
}

function setDirection(purpose: CommutePurpose, direction: 0 | 1): void {
  const current = draft.value
  if (!current) return
  draft.value = { ...current, [purpose]: { ...current[purpose], direction } }
}

function setStop(purpose: CommutePurpose, choice: StationChoice | null): void {
  const current = draft.value
  if (!current) return
  draft.value = { ...current, [purpose]: { ...current[purpose], stop: choice } }
}

const saving = shallowRef(false)

/** 一个目的在**存储里**的上车点这一对。清空时它是写 null 的依据：屏幕上没有值、存储里有值，
 * 说明使用者清掉了它，那就得把这两列一起写下去。 */
function storedChoice(fav: UserFavoriteLine, purpose: CommutePurpose): StationChoice | null {
  const stop = storedSlot(fav, purpose).stop
  return stop ? { name: stop.name, order: stop.order } : null
}

/**
 * 保存：把屏幕上这两个目的各写一次。
 *
 * 写的是既有的两条写入路径（`updateCommuteSlot` 走方向、`setBoardStop` 走上车点那一对），
 * 故一对 (站名, 站序) 的本地校验、清空要写两列这些规则与详情页完全一致。
 *
 * **不按「改动过」筛选**：按下保存就是把这一屏按现在这个样子存下来 —— 幂等，也正是使用者
 * 按下它的意思。于是没改动时也写：没有可写的（方向未知、上车点没选）就跳过那一半。
 *
 * 方向只写**真的有得选**的那一种情况（双向线路）：单向线路上那个值不是使用者的选择（存储里是
 * NULL），把它写下去会记下一个他从没做过的选择。
 *
 * 一次点击是**一次动作**，故回话只有一句：写在这里面的是「往库里写什么」，成败由外面那一次
 * `runWithFeedback` 统一说 —— 逐条报会把一次保存说成两三次（两个目的各写一次方向）。
 */
async function writeSlots(fav: UserFavoriteLine): Promise<void> {
  for (const purpose of COMMUTE_PURPOSES) {
    const slot = slotOf(purpose)
    const hasDirectionChoice = stops.directionOptions(fav).length > 1
    if (hasDirectionChoice && slot.direction !== null) {
      await transitStore.updateCommuteSlot(fav.id!, purpose, { direction: slot.direction })
    }
    // 上车点：屏幕上有值就写它；屏幕上没有值（清空过或从未设过）时，只有**存储里有值**才写
    // ——那种情况下的 null 是「清空」这个动作本身，两列一起写（只写站名会留下站序与空名字并排）。
    if (slot.stop !== null || storedChoice(fav, purpose) !== null) {
      await transitStore.setBoardStop(fav.id!, purpose, slot.stop)
    }
  }
}

async function save(): Promise<void> {
  const fav = favorite.value
  if (!fav?.id || saving.value) return
  saving.value = true
  try {
    await runWithFeedback('favorite-save', () => writeSlots(fav), { name: fav.lineName })
    // 存下来的就是屏幕上那几件：草稿从存储值重新起草，故「改动过」回到空。
    redraft()
    // 这一页的事已经办完：留在它上面只会让人再点一次保存（与锚点页、链路编辑页同一条）。
    // 写在成功这一支里 —— 失败时留在页上，原因由 toast 说一次。
    await router.push('/settings/lines')
  }
  catch {
    // 原因已由 toast 说过；这里只是接住重抛，别让它变成未处理的拒绝。
  }
  finally {
    saving.value = false
  }
}

/** 排队等待移除的关注项，以及上一次尝试的失败。 */
const removalOpen = shallowRef(false)
const removing = shallowRef(false)

/**
 * 取消关注。
 *
 * 确认控件是普通 button，不是 reka-ui 的 `AlertDialogAction`：后者**就是** `DialogClose`，
 * 它自己的点击处理会关闭对话框，而 Vue 在消费者的 fallthrough 处理之前运行组件自己的处理
 * ——关闭先清空了排队的目标，故处理读到 `null` 并直接返回，永远没发出 DELETE。
 *
 * 成功之后回列表：这一条已经不在存储里，留在这一页只会渲染成「这条关注不存在」。
 * 失败时对话框留在原地，原因由 toast 说一次 —— 页上不再说第二遍。
 */
async function confirmRemoval(): Promise<void> {
  const fav = favorite.value
  if (!fav?.id || removing.value) return
  removing.value = true
  try {
    await runWithFeedback(
      'favorite-remove',
      () => transitStore.removeFavorite(fav.id || fav.lineId),
      { name: fav.lineName },
    )
    removalOpen.value = false
    await router.push('/settings/lines')
  }
  catch {
    // 原因已由 toast 说过；这里只是接住重抛，别让它变成未处理的拒绝。
  }
  finally {
    removing.value = false
  }
}

/** 两个目的当前的取值，`sameDirectionNote` 就这一对说话。 */
const directions = computed<Record<CommutePurpose, 0 | 1 | null>>(() => ({
  morning: slotOf('morning').direction,
  evening: slotOf('evening').direction,
}))
</script>

<template>
  <div class="mx-auto max-w-3xl space-y-6 pb-12">
    <BackToSettings to="/settings/lines" label="返回关注线路" />

    <!-- 读取还在路上：这一帧里没人知道这个 id 有没有对应一行，故「不存在」这句话还说不出来。 -->
    <p v-if="favoritesRead === 'reading'" class="rounded-3xl border border-slate-800 bg-slate-900/60 p-8 text-center text-sm text-slate-400 lg:text-base">
      {{ readingText('关注线路') }}
    </p>

    <!-- 读取没答上来：这是它自己的事实，带着唯一能改变它的重试；也不是「不存在」。 -->
    <div v-else-if="favoritesRead === 'unreadable'" class="rounded-3xl border border-slate-800 bg-slate-900/60 p-6">
      <p class="flex items-center gap-1.5 text-sm text-rose-400 lg:text-base">
        <TriangleAlert class="h-4 w-4 shrink-0" aria-hidden="true" />
        <span>{{ unreadText('关注线路', '暂时无法显示这一条') }}</span>
      </p>
      <button
        type="button"
        class="mt-3 flex min-h-[44px] items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-950 px-3 text-xs text-slate-200 transition hover:border-cyan-500/40 active:scale-95 lg:text-base"
        @click="readFavorites"
      >
        <RefreshCw class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>重试</span>
      </button>
    </div>

    <!-- 读取作答而这一条不在其中：这就是「这条关注不存在」。不给第二个返回控件 ——
         上面那个已经指向关注线路列表，两枚同目标的按钮只会让人犹豫。 -->
    <div v-else-if="!favorite" class="rounded-3xl border border-slate-800 bg-slate-900/60 p-8 text-center">
      <p class="text-sm font-semibold text-slate-200 lg:text-base">这条关注不存在</p>
    </div>

    <template v-else>
      <h2 class="text-xl font-bold text-white md:text-2xl">
        编辑 {{ favorite.lineName || '线路' }}
      </h2>

      <section class="rounded-3xl border border-slate-800 bg-slate-900/80 p-4 shadow-xl sm:p-5">
        <div
          v-for="purpose in COMMUTE_PURPOSES"
          :key="purpose"
          class="space-y-2"
          :class="purpose === 'evening' ? 'mt-4 border-t border-slate-800/60 pt-4' : ''"
        >
          <div class="flex items-center justify-between gap-2">
            <span class="text-xs font-medium text-slate-300 lg:text-sm">
              {{ purpose === 'morning' ? '🏠 上班' : '🏢 下班' }}
            </span>
            <span
              v-if="purposeStopsRead(favorite, slotOf(purpose))?.state === 'reading'"
              class="text-xs text-slate-400"
            >
              正在加载站点…
            </span>
          </div>

          <!-- 方向在前：一个站的含义（它的编号、是否真被停靠）取决于车的行驶方向，
               故先挑站再挑方向会展示一条用户并不乘坐的线路上的编号。 -->
          <div class="flex flex-wrap items-center gap-2">
            <span class="text-xs text-slate-400">方向</span>
            <template v-if="stops.directionOptions(favorite).length > 1">
              <RadioGroupRoot
                :model-value="slotOf(purpose).direction ?? undefined"
                class="flex flex-wrap gap-2"
                @update:model-value="(v) => setDirection(purpose, Number(v) as 0 | 1)"
              >
                <RadioGroupItem
                  v-for="opt in stops.directionOptions(favorite)"
                  :key="`${purpose}_${opt.direction}`"
                  :value="opt.direction"
                  class="min-h-11 rounded-lg border px-3 text-xs transition"
                  :class="slotOf(purpose).direction === opt.direction
                    ? 'border-cyan-500/60 bg-cyan-500/15 text-cyan-200'
                    : 'border-slate-700 bg-slate-950 text-slate-300 hover:border-cyan-500/40'"
                >
                  {{ opt.label ?? `方向 ${opt.direction}` }}
                </RadioGroupItem>
              </RadioGroupRoot>
            </template>
            <span v-else class="text-xs text-slate-400">
              {{ stops.directionOptions(favorite)[0]?.label ?? '方向未知' }}
            </span>
          </div>

          <div v-if="slotOf(purpose).direction === null && stops.directionOptions(favorite).length > 1" class="text-xs text-slate-400">
            请先选择方向
          </div>
          <template v-else>
            <!-- 该方向完全没有站点：此处放一个选择器会永远为空，
                 故说明原因而不是展示它。 -->
            <p
              v-if="stationsUnavailable(favorite, slotOf(purpose))"
              class="text-xs text-slate-400 lg:text-base"
            >
              该方向暂无站点数据，无法设置上车点
            </p>
            <!-- 读取没答上来：这也是一个自己的事实，不是「这个方向没有站」，也不是
                 「还在读」。同样不摆一个永远空的 picker，并说清这一屏现在缺的是哪一步。 -->
            <p
              v-else-if="purposeStopsRead(favorite, slotOf(purpose))?.state === 'unreadable'"
              class="text-xs text-slate-400 lg:text-base"
            >
              未读到该方向的站点数据，暂时无法设置上车点
            </p>
            <template v-else>
              <StationPinPicker
                :model-value="slotOf(purpose).stop"
                :stations="purposeStations(favorite, slotOf(purpose))"
                :direction-label="purpose === 'morning' ? '上班' : '下班'"
                @update:model-value="(choice) => setStop(purpose, choice)"
              />
              <p
                v-if="boardStopNotice(favorite, slotOf(purpose))"
                class="flex items-start gap-1.5 text-xs text-amber-400"
              >
                <TriangleAlert class="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{{ boardStopNotice(favorite, slotOf(purpose)) }}</span>
              </p>
            </template>
          </template>
        </div>

        <!-- 中性提示，不是警告：同向的选择是允许的，用户也可能就是那个意思
             （环线、只坐一站）。每条线路只放一次，在两个方向区块之后，
             因为它描述的是这一**对**，而不是任一目的本身。 -->
        <p
          v-if="sameDirectionNote(favorite, directions)"
          class="mt-4 flex items-start gap-1.5 text-xs text-slate-400"
        >
          <Info class="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{{ sameDirectionNote(favorite, directions) }}</span>
        </p>

        <!-- 底部：保存（草稿落库的唯一时刻），以及取消关注（破坏性动作，带确认）。 -->
        <div class="mt-4 flex flex-wrap items-center gap-2 border-t border-slate-800/60 pt-4">
          <button
            type="button"
            class="min-h-[44px] min-w-0 flex-1 rounded-xl border border-cyan-500/30 bg-cyan-500/10 px-4 text-sm font-semibold text-cyan-400 transition hover:bg-cyan-500/20 active:scale-95 lg:px-5 lg:text-base"
            :disabled="saving"
            @click="save"
          >
            {{ saving ? '保存中…' : '保存' }}
          </button>
          <button
            type="button"
            class="flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-xl border border-rose-500/20 bg-rose-500/10 px-3 text-xs text-rose-400 transition hover:bg-rose-500/20 active:scale-95 lg:gap-2 lg:px-3.5 lg:text-base"
            @click="removalOpen = true"
          >
            <X class="h-3.5 w-3.5 shrink-0" />
            <span>取消关注</span>
          </button>
        </div>
      </section>
    </template>

    <!-- 取消关注确认。取消关注在界面上不可逆（必须重新搜索该线路），故它要求显式确认。 -->
    <RemovalDialog
      :open="removalOpen"
      :line-name="favorite?.lineName ?? null"
      :removing="removing"
      @confirm="confirmRemoval"
      @cancel="removalOpen = false"
    />
  </div>
</template>
