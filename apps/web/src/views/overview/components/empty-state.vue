<script setup lang="ts">
import { ChevronRight, RefreshCw, TriangleAlert } from '@lucide/vue'
import { followedLinesUnreadableText, type ReadState } from '@/read-state'

/**
 * The home screen with no card to show — and the THREE reasons that can happen, which must
 * not be told as one.
 *
 * `state` is the followed-lines read's own state, handed down by the page that made the
 * read. It matters here because this card used to be rendered on an empty array alone, and
 * an array is empty both when the user follows nothing and when nobody read their list:
 * 「当前城市（北京市）还没有关注线路」 then states a fact about the stored rows that no answer
 * supports, and its link sends the user to re-follow lines they already follow. 设置's index
 * row was fixed for exactly this (`未读到`, not a count nobody obtained); the home screen is
 * the same failure with a bigger consequence.
 *
 *  - `reading`    nothing was answered yet, so nothing is claimed;
 *  - `unreadable` the read failed: it says so, and offers the one action that can change it;
 *  - `read`       the list answered and is empty — the only state this message is true in,
 *                 and the link is its action.
 */
defineProps<{
  cityName: string
  state?: ReadState
}>()

defineEmits<{
  (e: 'retry'): void
}>()
</script>

<template>
  <div class="rounded-3xl border border-dashed border-slate-700 bg-slate-900/40 p-10 text-center">
    <!-- An unreadable list: the cause is the read, and the action is another read. -->
    <template v-if="state === 'unreadable'">
      <p class="flex items-center justify-center gap-1.5 text-sm text-rose-400 lg:text-base">
        <TriangleAlert class="h-4 w-4 shrink-0" aria-hidden="true" />
        <span>{{ followedLinesUnreadableText('暂时无法显示通勤卡片') }}</span>
      </p>
      <button
        type="button"
        class="mt-3 inline-flex min-h-[44px] items-center gap-1 rounded-xl border border-slate-700 bg-slate-950 px-4 py-2 text-xs font-semibold text-slate-200 transition hover:border-cyan-500/40 active:scale-95 lg:gap-1.5 lg:px-4.5 lg:py-2.5 lg:text-base"
        @click="$emit('retry')"
      >
        <RefreshCw class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>重试</span>
      </button>
    </template>

    <!-- Still reading: a state of its own, and it does not borrow the empty one's words. -->
    <p v-else-if="state === 'reading'" class="text-sm text-slate-400 lg:text-base">
      正在读取关注线路…
    </p>

    <template v-else>
      <p class="text-sm text-slate-400 lg:text-base">
        当前城市（{{ cityName }}）还没有关注线路
      </p>
      <!-- 设置 is an index plus four pages now, so this pointer names the page that holds
           what this screen is missing (关注线路) instead of the index, which would cost a
           second tap on the one screen that exists to remove this state. -->
      <RouterLink
        to="/settings/lines"
        class="mt-3 inline-flex items-center gap-1 rounded-xl border border-cyan-500/30 bg-cyan-500/10 px-4 py-2 text-xs font-semibold text-cyan-400 transition hover:bg-cyan-500/20 lg:gap-1.5 lg:px-4.5 lg:py-2.5 lg:text-base"
      >
        <span>去搜索并关注线路</span>
        <ChevronRight class="h-3.5 w-3.5" />
      </RouterLink>
    </template>
  </div>
</template>
