<script setup lang="ts">
/**
 * 一条已录链路的删除确认。
 *
 * 删除在界面上不可撤销：每一段都是逐条录入的，要恢复就得重新录入。
 * 故它要求显式确认，而不是在行内单击即触发。
 */
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
  /** 对话框是否显示；由卡片持有（它跟踪目标）。 */
  open: boolean
  /** 正在删除的链路名。 */
  chainName: string | null
  removing: boolean
  error: string | null
}>()

const emit = defineEmits<{
  (e: 'confirm'): void
  (e: 'cancel'): void
}>()
</script>

<template>
  <AlertDialogRoot :open="open" @update:open="(value) => { if (!value) emit('cancel') }">
    <AlertDialogPortal>
      <AlertDialogOverlay class="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm" />
      <AlertDialogContent
        class="fixed top-1/2 left-1/2 z-50 w-[calc(100vw-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-slate-700 bg-slate-900 p-5 shadow-2xl"
      >
        <AlertDialogTitle class="text-sm font-semibold text-white">
          删除通勤链路「{{ chainName || '该链路' }}」？
        </AlertDialogTitle>
        <AlertDialogDescription class="mt-2 text-xs text-slate-400">
          删除后换乘链路页不再有这条链路，每一段的上车站与下车站需要重新录入才能恢复。
        </AlertDialogDescription>
        <div class="mt-5 flex justify-end gap-2">
          <AlertDialogCancel class="min-h-[44px] rounded-xl border border-slate-700 bg-slate-800 px-4 text-xs text-slate-200 transition hover:bg-slate-700 active:scale-95">
            保留
          </AlertDialogCancel>
          <!-- 普通 button，刻意不用 AlertDialogAction：后者是 DialogClose，它自己的点击
               处理会先关闭对话框，卡片随后读到已清空的目标，永远发不出 DELETE。 -->
          <button
            type="button"
            class="min-h-[44px] rounded-xl border border-rose-500/30 bg-rose-500/15 px-4 text-xs font-semibold text-rose-300 transition hover:bg-rose-500/25 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="removing"
            @click="emit('confirm')"
          >
            {{ removing ? '处理中…' : '确认删除' }}
          </button>
        </div>
        <p v-if="error" role="alert" class="mt-3 flex items-center gap-1.5 text-xs text-rose-400">
          <TriangleAlert class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{{ error }}</span>
        </p>
      </AlertDialogContent>
    </AlertDialogPortal>
  </AlertDialogRoot>
</template>
