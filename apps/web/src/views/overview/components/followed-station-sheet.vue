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
import type { UserFavoriteLine } from '@real-time-transport/shared'

/**
 * 设关注站的弹窗：按方向各选一个站（可只设一边）。
 *
 * 移动端是底部上滑的 sheet，PC 端是居中弹窗 —— 同一组件，定位按断点切换，
 * PC 上用移动端的 sheet 会很奇怪。两端都有搜索框：一条线 90 多站时纯滚动不可用。
 *
 * 入口在关注卡片上（不是线路详情页 —— 那页交互已多，且是移动端优先）。
 * 站的身份是 (站名, 站序) 一对：同名站（环线首末站、长线路重名站）必须点到具体的一站，
 * 只给站名时保存会被拒绝（store 先拦，服务端 schema 也拦）。
 */

const props = defineProps<{
  open: boolean
  favorite: UserFavoriteLine | null
  /** 两个方向的站表与方向名；缺失的方向不展示。 */
  directions: Array<{
    direction: 0 | 1
    directionName: string
    stops: Array<{ name: string, order: number }>
  }>
}>()

const emit = defineEmits<{
  (e: 'update:open', open: boolean): void
  (e: 'save', direction: 0 | 1, stop: { name: string, order: number } | null): void
}>()

/** 每方向当前选中的站序；null = 未选（回退链接管）。 */
const picked = ref<{ 0: number | null, 1: number | null }>({ 0: null, 1: null })
/** 站名搜索：按字面包含过滤，不排序（站序是行驶顺序，不动它）。 */
const query = ref('')

// 打开时把已存的关注站读成选中态、清空搜索；关掉重开不带上次的草稿。
watch(() => props.open, (open) => {
  if (!open || !props.favorite) return
  picked.value = {
    0: props.favorite.followedStopOrder0 ?? null,
    1: props.favorite.followedStopOrder1 ?? null,
  }
  query.value = ''
  // 存了站序但站名对不上（上游改了站表）时不预选 —— placeBoardStop 会判 stale，
  // 这里不替用户指认，保持未选让回退链工作。
})

function currentName(direction: 0 | 1): string | null {
  const f = props.favorite
  if (!f) return null
  return direction === 0 ? (f.followedStopName0 ?? null) : (f.followedStopName1 ?? null)
}

function isPicked(direction: 0 | 1, order: number): boolean {
  return picked.value[direction] === order
}

function toggle(direction: 0 | 1, stop: { name: string, order: number }): void {
  // 点已选中的站 = 取消该方向的关注（回退链接管）。
  picked.value[direction] = isPicked(direction, stop.order) ? null : stop.order
}

/** 过滤后的站表：空查询返回全部；只按站名包含，不过滤掉站序。 */
function filteredStops(stops: Array<{ name: string, order: number }>): Array<{ name: string, order: number }> {
  const q = query.value.trim()
  if (!q) return stops
  return stops.filter(s => s.name.includes(q))
}

function confirm(): void {
  const f = props.favorite
  if (!f) return
  for (const d of props.directions) {
    const order = picked.value[d.direction]
    const prevOrder = d.direction === 0 ? f.followedStopOrder0 : f.followedStopOrder1
    const prevName = currentName(d.direction)
    if (order === (prevOrder ?? null)) continue // 没动过，不送
    if (order === null) {
      emit('save', d.direction, null)
      continue
    }
    const stop = d.stops.find(s => s.order === order)
    if (stop) emit('save', d.direction, { name: stop.name, order: stop.order })
    else if (prevName !== null) emit('save', d.direction, null)
  }
  emit('update:open', false)
}

const title = computed(() => props.favorite ? `${props.favorite.lineName} · 设关注站` : '设关注站')
</script>

<template>
  <DialogRoot :open="open" @update:open="emit('update:open', $event)">
    <DialogPortal>
      <DialogOverlay class="followed-overlay fixed inset-0 z-[90] bg-slate-950/75 backdrop-blur-sm" />
      <DialogContent
        class="followed-sheet fixed z-[100] flex h-[85dvh] flex-col border-slate-700/80 bg-slate-900 shadow-2xl focus:outline-none
          inset-x-0 bottom-0 rounded-t-3xl border-t
          lg:inset-0 lg:m-auto lg:h-[70vh] lg:max-h-[36rem] lg:w-[36rem] lg:rounded-3xl lg:border"
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
        <p class="shrink-0 px-4 pb-2 text-xs text-slate-400">
          每个方向各选一个站（可只设一边）。设了的站，卡片不再依赖定位，随时显示它的到站。
        </p>
        <!-- 搜索：站名包含匹配；90 多站的线路纯滚动不可用 -->
        <div class="shrink-0 px-4 pb-2">
          <input
            v-model="query"
            type="search"
            placeholder="搜索站名…"
            aria-label="搜索站名"
            class="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-base text-slate-200 placeholder:text-slate-500 focus:border-cyan-500/60 focus:outline-none"
          >
        </div>

        <div class="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
          <div v-for="d in directions" :key="d.direction" class="mb-4">
            <div class="sticky top-0 bg-slate-900 py-1.5 text-xs font-semibold text-slate-300">
              {{ d.direction === 0 ? '上行' : '下行' }} · {{ d.directionName }}
              <span v-if="currentName(d.direction)" class="ml-1 font-normal text-cyan-300">
                当前：{{ currentName(d.direction) }}
              </span>
            </div>
            <div
              v-for="s in filteredStops(d.stops)"
              :key="`${d.direction}-${s.order}`"
              role="radio"
              :aria-checked="isPicked(d.direction, s.order)"
              tabindex="0"
              class="flex cursor-pointer items-center justify-between rounded-lg px-3 py-2.5 text-sm"
              :class="isPicked(d.direction, s.order)
                ? 'bg-cyan-500/15 text-cyan-200'
                : 'text-slate-300 hover:bg-slate-800'"
              @click="toggle(d.direction, s)"
              @keydown.enter="toggle(d.direction, s)"
              @keydown.space.prevent="toggle(d.direction, s)"
            >
              <span class="min-w-0 truncate">{{ s.name }}</span>
              <span class="ml-2 shrink-0 font-mono text-xs text-slate-500">第 {{ s.order }} 站</span>
            </div>
            <div v-if="filteredStops(d.stops).length === 0" class="px-3 py-2 text-xs text-slate-500">
              {{ d.stops.length === 0 ? '该方向站表尚未加载' : '没有匹配的站名' }}
            </div>
          </div>
        </div>

        <!-- 底部按钮栏：iOS 底部 safe area 计入内边距，按钮不贴 Home 指示条 -->
        <div class="flex shrink-0 gap-2 border-t border-slate-800 px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
          <DialogClose
            class="flex-1 rounded-xl border border-slate-700 px-4 py-2.5 text-sm font-medium text-slate-300 hover:bg-slate-800"
          >
            取消
          </DialogClose>
          <button
            type="button"
            class="flex-1 rounded-xl border border-cyan-500/60 bg-cyan-500/15 px-4 py-2.5 text-sm font-medium text-cyan-200 hover:bg-cyan-500/25"
            @click="confirm"
          >
            完成
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
