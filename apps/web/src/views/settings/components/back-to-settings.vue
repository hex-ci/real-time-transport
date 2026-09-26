<script setup lang="ts">
/**
 * 「设置」各子页面的返回方式 —— 一个自己的控件，不是系统手势，也不是浏览器的返回键。
 *
 * 看得见的字就是无障碍名。语音控制的用户读出来的正是屏幕上那几个字，所以用一个别的名字替换它们
 * （`aria-label="返回"`，或任何更短的词组）会做出一个「读出来也叫不动」的控件（WCAG 2.5.3）。
 * 这里没有任何多余的东西，所以根本不需要 `aria-label`，名字「就是」返回设置。
 */
import { ArrowLeft } from '@lucide/vue'
</script>

<template>
  <RouterLink
    to="/settings"
    class="inline-flex min-h-[44px] items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-900 px-3.5 text-xs font-semibold text-slate-200 transition hover:border-cyan-500/40 active:scale-95 lg:px-4 lg:text-base"
  >
    <ArrowLeft class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
    <span>返回设置</span>
  </RouterLink>
</template>
