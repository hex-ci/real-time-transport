<script setup lang="ts">
/**
 * Removal confirmation for one recorded chain.
 *
 * Deleting is not reversible from the UI: the legs were typed in one by one, and
 * getting them back means recording the chain again. So it takes an explicit confirm
 * rather than firing on a single tap inside the row.
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
  /** Whether the dialog is showing; the card owns this (it tracks the target). */
  open: boolean
  /** Name of the chain being deleted. */
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
          <!-- A plain button, NOT AlertDialogAction: that component is a DialogClose,
               whose own click handler closes the dialog before this one runs, so the
               card would read a cleared target and never send the DELETE. -->
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
