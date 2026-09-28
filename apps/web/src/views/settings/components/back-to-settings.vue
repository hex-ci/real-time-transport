<script setup lang="ts">
/**
 * 设置各子页面的返回方式 —— 一个自己的控件，不是系统手势，也不是浏览器的返回键。
 *
 * 看得见的字就是无障碍名。语音控制的用户读出来的正是屏幕上那几个字，所以用一个别的名字替换它们
 * （`aria-label="返回"`，或任何更短的词组）会做出一个「读出来也叫不动」的控件（WCAG 2.5.3）。
 * 故 `label` 与 `to` 必须一致：回到哪一层，屏幕上就说哪一层。
 *
 * 缺省回到设置索引 —— 四个域的子页面都是从那里进来的。锚点自己的子页面（家 / 公司）是从
 * `/settings/anchors` 进来的，故那里传 `to="/settings/anchors"` 与 `label="返回位置锚点"`：
 * 写死回设置索引会让用户跳过锚点列表那一层。
 */
import { ArrowLeft } from '@lucide/vue'

const { to = '/settings', label = '返回设置' } = defineProps<{
  to?: string
  label?: string
}>()
</script>

<template>
  <RouterLink
    :to="to"
    class="inline-flex min-h-[44px] items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-900 px-3.5 text-xs font-semibold text-slate-200 transition hover:border-cyan-500/40 active:scale-95 lg:px-4 lg:text-base"
  >
    <ArrowLeft class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
    <span>{{ label }}</span>
  </RouterLink>
</template>
