<script setup lang="ts">
/**
 * What the page shows while it has no answer yet: the read in progress, or the read
 * that failed.
 *
 * The two are different facts and neither may read as the other — an empty page
 * that says nothing reads as a page with nothing to show, which is exactly what the
 * user cannot tell apart from a failure. A failed read states that it failed and
 * offers the retry, because the request is the only thing that can fix it.
 */
defineProps<{
  loading: boolean
  loadError: string | null
}>()

defineEmits<{
  (e: 'retry'): void
}>()
</script>

<template>
  <div class="rounded-3xl border border-slate-800 bg-slate-900/60 p-8 text-center">
    <p v-if="loading" class="text-sm text-slate-400 lg:text-base">正在读取换乘链…</p>
    <template v-else>
      <p class="text-sm font-semibold text-rose-400 lg:text-base">{{ loadError }}</p>
      <button
        class="mt-3 inline-flex min-h-11 items-center rounded-xl border border-cyan-500/30 bg-cyan-500/10 px-4 text-xs font-semibold text-cyan-400 transition hover:bg-cyan-500/20 active:scale-95 lg:text-base"
        @click="$emit('retry')"
      >
        重新读取
      </button>
    </template>
  </div>
</template>
