<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  DialogClose,
  DialogContent,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
} from 'reka-ui'
import { X } from '@lucide/vue'
import { SearchableCombobox } from '@/components/searchable-combobox'
import type { ComboboxOption } from '@/components/searchable-combobox'
import type { UserFavoriteLine } from '@real-time-transport/shared'

/**
 * 设关注站的弹窗：按方向各选一个站（可只设一边）。
 *
 * 用设置页同款的可搜索下拉（`SearchableCombobox`）：一条线 90 多站时，
 * 先上行后下行的滚动长列表不够直观，下拉+搜索是全站统一的选站交互。
 *
 * 移动端是底部上滑的 sheet，PC 端是居中弹窗 —— 同一组件，定位按断点切换。
 *
 * 入口在关注卡片上（不是线路详情页 —— 那页交互已多，且是移动端优先）。
 * 站的身份是 (站名, 站序) 一对：同名站必须定位到具体的一站，
 * 选项的 key 即站身份，`find(name)` 式的回退在这里不存在。
 */

interface SheetStop { name: string, order: number }

const props = defineProps<{
  open: boolean
  favorite: UserFavoriteLine | null
  /** 两个方向的站表与方向名；缺失的方向不展示。 */
  directions: Array<{
    direction: 0 | 1
    directionName: string
    stops: Array<SheetStop>
  }>
}>()

const emit = defineEmits<{
  (e: 'update:open', open: boolean): void
  (e: 'save', changes: Array<{ direction: 0 | 1, stop: SheetStop | null }>): void
}>()

/** 站身份：站序_站名 —— 同一方向内唯一，两个同名站靠它区分。 */
function identity(s: SheetStop): string {
  return `${s.order}_${s.name}`
}

/** 每方向选中的站；null = 未选（回退链接管）。 */
const picked = ref<{ 0: SheetStop | null, 1: SheetStop | null }>({ 0: null, 1: null })

// 打开时把已存的关注站读成选中态；关掉重开不带上次的草稿。
watch(() => props.open, (open) => {
  if (!open || !props.favorite) return
  const f = props.favorite
  picked.value = {
    0: f.followedStopName0 && f.followedStopOrder0 != null
      ? { name: f.followedStopName0, order: f.followedStopOrder0 }
      : null,
    1: f.followedStopName1 && f.followedStopOrder1 != null
      ? { name: f.followedStopName1, order: f.followedStopOrder1 }
      : null,
  }
})

function optionsFor(direction: 0 | 1): ComboboxOption[] {
  const d = props.directions.find(x => x.direction === direction)
  return (d?.stops ?? []).map(s => ({
    key: identity(s),
    primary: s.name,
    secondary: `第 ${s.order} 站`,
  }))
}

function selectedOf(direction: 0 | 1): { primary: string, secondary: string } | null {
  const s = picked.value[direction]
  return s ? { primary: s.name, secondary: `第 ${s.order} 站` } : null
}

function onSelect(direction: 0 | 1, option: ComboboxOption): void {
  const d = props.directions.find(x => x.direction === direction)
  const hit = d?.stops.find(s => identity(s) === option.key)
  if (hit) picked.value[direction] = { name: hit.name, order: hit.order }
}

function clear(direction: 0 | 1): void {
  picked.value[direction] = null
}

function confirm(): void {
  const f = props.favorite
  if (!f) return
  // 两个方向的变化收拢成一次 save：一次保存动作只弹一个 toast。
  const changes: Array<{ direction: 0 | 1, stop: SheetStop | null }> = []
  for (const direction of [0, 1] as const) {
    const next = picked.value[direction]
    const prevName = direction === 0 ? f.followedStopName0 : f.followedStopName1
    const prevOrder = direction === 0 ? f.followedStopOrder0 : f.followedStopOrder1
    const prev = prevName && prevOrder != null ? { name: prevName, order: prevOrder } : null
    if (identityOrNull(next) === identityOrNull(prev)) continue // 没动过，不送
    changes.push({ direction, stop: next })
  }
  if (changes.length > 0) {
    emit('save', changes)
  }
  emit('update:open', false)
}

function identityOrNull(s: SheetStop | null): string | null {
  return s ? identity(s) : null
}

const title = computed(() => props.favorite ? `${props.favorite.lineName} · 设关注站` : '设关注站')
</script>

<template>
  <DialogRoot :open="open" @update:open="emit('update:open', $event)">
    <DialogPortal>
      <DialogOverlay class="followed-overlay fixed inset-0 z-[90] bg-slate-950/75 backdrop-blur-sm" />
      <DialogContent
        class="followed-sheet fixed z-[100] flex flex-col border-slate-700/80 bg-slate-900 shadow-2xl focus:outline-none
          inset-x-0 bottom-0 max-h-[85dvh] rounded-t-3xl border-t
          lg:inset-0 lg:m-auto lg:h-fit lg:max-h-[80vh] lg:w-[36rem] lg:rounded-3xl lg:border"
      >
        <!-- 拖拽指示条：只在移动端 sheet 形态下有意义 -->
        <div class="mx-auto mt-3 h-1 w-10 shrink-0 rounded-full bg-slate-700 lg:hidden"></div>
        <div class="flex shrink-0 items-center justify-between px-4 pb-2 pt-3">
          <DialogTitle class="text-base font-semibold text-slate-100">{{ title }}</DialogTitle>
          <DialogClose
            class="rounded-lg px-2 py-1 text-sm text-slate-400 hover:bg-slate-800 hover:text-slate-200"
            aria-label="关闭"
          >
            ✕
          </DialogClose>
        </div>
        <p class="shrink-0 px-4 pb-3 text-xs text-slate-400">
          每个方向各选一个站（可只设一边）。设了的站，卡片不再依赖定位，随时显示它的到站。
        </p>

        <div class="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-4">
          <div v-for="d in directions" :key="d.direction">
            <div class="pb-1.5 text-xs font-semibold text-slate-300 lg:text-sm">
              {{ d.direction === 0 ? '上行' : '下行' }} · {{ d.directionName }}
            </div>
            <div class="flex items-center gap-1.5">
              <SearchableCombobox
                :model-value="picked[d.direction] ? identity(picked[d.direction]!) : null"
                :selected="selectedOf(d.direction)"
                :options="optionsFor(d.direction)"
                :label="`${d.direction === 0 ? '上行' : '下行'}关注站`"
                placeholder="未设置"
                search-placeholder="搜索站点名或站序…"
                empty-text="未找到匹配站点"
                content-class="z-[110]"
                class="min-w-0 flex-1"
                @select="onSelect(d.direction, $event)"
              />
              <!-- 清除是独立控件：选站与取消是两个意图，combobox 没有内置清除 -->
              <button
                v-if="picked[d.direction]"
                type="button"
                :aria-label="`清除${d.direction === 0 ? '上行' : '下行'}关注站`"
                class="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-slate-700 bg-slate-900 text-slate-400 transition hover:border-rose-500/40 hover:text-rose-400 active:scale-95"
                @click="clear(d.direction)"
              >
                <X class="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
            <div v-if="d.stops.length === 0" class="px-1 pt-1 text-xs text-slate-500">
              该方向站表尚未加载
            </div>
          </div>
        </div>

        <!-- 底部按钮栏：iOS 底部 safe area 计入内边距，按钮不贴 Home 指示条 -->
        <div class="flex shrink-0 gap-2 border-t border-slate-800 px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
          <DialogClose
            class="flex-1 rounded-xl border border-slate-700 px-4 py-2.5 text-xs font-medium text-slate-300 hover:bg-slate-800 lg:text-base"
          >
            取消
          </DialogClose>
          <button
            type="button"
            class="flex-1 rounded-xl border border-cyan-500/60 bg-cyan-500/15 px-4 py-2.5 text-xs font-medium text-cyan-200 hover:bg-cyan-500/25 lg:text-base"
            @click="confirm"
          >
            保存
          </button>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

<style scoped>
/*
 * 进出场动效：reka-ui 在 DialogContent/Overlay 上打 data-state。
 * 移动端 sheet 从底部滑入，PC 端居中弹窗做缩放+淡入 —— 两套 keyframes 按断点切换。
 */

/* 遮罩：两端都是淡入淡出 */
.followed-overlay[data-state='open'] { animation: followed-fade-in 0.2s ease-out; }
.followed-overlay[data-state='closed'] { animation: followed-fade-out 0.15s ease-in; }
@keyframes followed-fade-in { from { opacity: 0; } }
@keyframes followed-fade-out { to { opacity: 0; } }

/* 移动端：底部 sheet 上滑 */
.followed-sheet[data-state='open'] { animation: followed-slide-in 0.28s cubic-bezier(0.32, 0.72, 0, 1); }
.followed-sheet[data-state='closed'] { animation: followed-slide-out 0.2s ease-in; }
@keyframes followed-slide-in { from { transform: translateY(100%); } }
@keyframes followed-slide-out { to { transform: translateY(100%); } }

/* PC 端：居中弹窗缩放+淡入，覆盖掉上面的滑入 */
@media (min-width: 1024px) {
  .followed-sheet[data-state='open'] { animation: followed-zoom-in 0.2s ease-out; }
  .followed-sheet[data-state='closed'] { animation: followed-zoom-out 0.15s ease-in; }
  @keyframes followed-zoom-in { from { opacity: 0; transform: scale(0.96); } }
  @keyframes followed-zoom-out { to { opacity: 0; transform: scale(0.96); } }
}
</style>
