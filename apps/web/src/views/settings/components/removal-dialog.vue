<script setup lang="ts">
import { TriangleAlert } from '@lucide/vue'
import {
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogRoot,
  AlertDialogTitle,
} from 'reka-ui'

defineProps<{
  /** 对话框是否显示；由视图拥有它（视图跟踪目标）。 */
  open: boolean
  /** 正在被取消关注的那条线路的名字。 */
  lineName: string | null
  removing: boolean
  error: string | null
}>()

const emit = defineEmits<{
  (e: 'confirm'): void
  (e: 'cancel'): void
}>()
</script>

<template>
  <!-- 取消关注确认。取消关注从界面上看是不可逆的（这条线路要重新搜索才能找到），所以要一次
       明确的确认，而不是在展开的行里点一下就直接执行。 -->
  <AlertDialogRoot :open="open" @update:open="(v) => { if (!v) emit('cancel') }">
    <AlertDialogPortal>
      <AlertDialogOverlay class="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm" />
      <AlertDialogContent
        class="fixed top-1/2 left-1/2 z-50 w-[calc(100vw-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-slate-700 bg-slate-900 p-5 shadow-2xl"
      >
        <AlertDialogTitle class="text-sm font-semibold text-white lg:text-base">
          取消关注 {{ lineName || '该线路' }}？
        </AlertDialogTitle>
        <AlertDialogDescription class="mt-2 text-xs text-slate-400 lg:text-base">
          取消后首页不再显示这条线路的实时车辆与到站信息，上车点设置也会一并移除。需要重新搜索才能再次关注。
        </AlertDialogDescription>
        <div class="mt-5 flex justify-end gap-2">
          <AlertDialogCancel
            class="min-h-[44px] rounded-xl border border-slate-700 bg-slate-800 px-4 text-xs text-slate-200 transition hover:bg-slate-700 active:scale-95 lg:px-5 lg:text-base"
          >
            保留
          </AlertDialogCancel>
          <!-- 普通按钮，不是 AlertDialogAction：那个组件是一个 DialogClose，它自己的点击处理会在这个
       处理读到待处理目标之前就关掉对话框、清掉目标。见 confirmRemoval。 -->
          <button
            type="button"
            class="min-h-[44px] rounded-xl border border-rose-500/30 bg-rose-500/15 px-4 text-xs font-semibold text-rose-300 transition hover:bg-rose-500/25 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50 lg:px-5 lg:text-base"
            :disabled="removing"
            @click="emit('confirm')"
          >
            {{ removing ? '处理中…' : '确认取消关注' }}
          </button>
        </div>
        <p
          v-if="error"
          class="mt-3 flex items-center gap-1.5 text-xs text-rose-400 lg:gap-2 lg:text-base"
        >
          <TriangleAlert class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{{ error }}</span>
        </p>
      </AlertDialogContent>
    </AlertDialogPortal>
  </AlertDialogRoot>
</template>
