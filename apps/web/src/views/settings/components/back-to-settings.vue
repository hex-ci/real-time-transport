<script setup lang="ts">
/**
 * 设置's sub-pages' way back — a control of its own, not the system gesture and not the
 * browser's back key (`§4.1`).
 *
 * THE VISIBLE WORDS ARE THE ACCESSIBLE NAME. What a voice-control user reads out is the
 * words on screen, so a name that replaces them — `aria-label="返回"`, or any shorter
 * phrase — is a control that cannot be called by reading it (WCAG 2.5.3 Label in Name,
 * Level A). This repo shipped exactly that defect and fixed it in
 * `chain-leg-fields.vue`: the visible words come first and anything extra is a
 * parenthetical (`删除该段（第 1 段）`). Here nothing is extra, so there is no `aria-label`
 * at all and the name IS 「返回设置」.
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
