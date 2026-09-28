<script setup lang="ts">
import { computed } from 'vue'
import { LocateFixed } from '@lucide/vue'
import { SearchableCombobox } from '@/components/searchable-combobox'
import type { ComboboxOption, SelectedText } from '@/components/searchable-combobox'

const props = defineProps<{
  stationOptions: string[]
  landmarkHint: string
  detecting: boolean
}>()

const emit = defineEmits<{
  (e: 'detect'): void
  (e: 'change'): void
}>()

/** 所选站台；由视图持有，因为发车随它切换而重载。 */
const stationName = defineModel<string>({ required: true })

/**
 * 每个站台一个选项，主文本就是站名：本屏按站名选站，站序在这里不是使用者认的东西。
 * 一侧的站可以多到几十个，故用带搜索框的下拉。
 */
const options = computed<ComboboxOption[]>(() =>
  props.stationOptions.map(name => ({ key: name, primary: name, secondary: null })))

/** 触发器显示的就是视图持有的站名；列表还没读到时它为空，那时显示「选择站台」。 */
const selected = computed<SelectedText | null>(() =>
  (stationName.value ? { primary: stationName.value, secondary: null } : null))
</script>

<template>
  <div class="rounded-2xl border border-slate-800 bg-slate-900/80 p-3.5 shadow-xl backdrop-blur-md sm:rounded-3xl sm:p-5 md:p-6">
    <div class="flex flex-col gap-2.5 md:flex-row md:items-center md:justify-between md:gap-4">
      <div>
        <span class="text-xs font-semibold uppercase tracking-wider text-cyan-400">
          虚拟候车亭 · 多线聚合起降牌
        </span>
        <h2 class="mt-0.5 flex items-center gap-2 text-lg font-bold text-white sm:mt-1 md:text-2xl">
          当前站台：<span class="max-w-[260px] truncate text-cyan-300">{{ stationName || '选择中...' }}</span>
        </h2>
        <p class="text-xs text-slate-400">
          {{ landmarkHint }} · 按预计到站时间升序排列
        </p>
      </div>

      <div class="flex w-full items-center gap-2 md:w-auto">
        <button
          class="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-cyan-500/30 bg-cyan-500/10 text-cyan-400 transition hover:bg-cyan-500/20 active:scale-95"
          :disabled="detecting"
          :aria-busy="detecting"
          aria-label="定位最近站台"
          @click="emit('detect')"
        >
          <LocateFixed
            class="h-4 w-4 shrink-0"
            :class="detecting ? 'animate-spin' : ''"
            aria-hidden="true"
          />
        </button>
        <!-- 换站是一次重读的触发：选中之后本屏的车况要按新站台重问一遍（视图的 `change`）。 -->
        <SearchableCombobox
          v-model="stationName"
          label="选择站台"
          :options="options"
          :selected="selected"
          placeholder="选择站台"
          search-placeholder="搜索站台名…"
          empty-text="未找到匹配站台"
          class="min-w-0 flex-1 md:w-60 md:flex-none lg:w-64"
          @select="emit('change')"
        />
      </div>
    </div>
  </div>
</template>
