<script setup lang="ts">
/**
 * 还没有答案时页面显示的东西：正在读取，或读取失败。
 *
 * 两者是不同的两个事实，不得读成彼此——什么都不说的空页面读起来与失败无法区分。
 * 读取失败要说明失败并给出重试，因为请求是唯一能修好它的东西。
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
