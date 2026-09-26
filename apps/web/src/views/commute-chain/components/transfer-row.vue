<script setup lang="ts">
import BandChip from './band-chip.vue'
import type { BranchView, TransferRowView } from '../types'

/**
 * 一段换乘：上哪一班、在此站台等多久、余量是多少，连同余量所对照之物。
 *
 * 这一行关于一班车，即正要上的那一班。余量所对照的车已走时（`referenceGone`）
 * 不印任何余量：印在用户正走向的车旁的负分钟会被读成那班车自己的余量。
 * 此时该行所印的数字属于下一班，`basisText` 两种情形都陈述——没有参照的余量是没有车的数字。
 */
defineProps<{
  row: TransferRowView
  /** F4 在这一段的标记；链路已在陈述那个词时为 null。 */
  markText: string | null
  /** 余量不可解析时的两个读数；其余各段为 null。 */
  branches: BranchView[] | null
}>()
</script>

<template>
  <li class="rounded-xl border border-slate-800 bg-slate-950/60 p-2.5 lg:p-3">
    <div class="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
      <p class="text-sm font-medium text-slate-100 lg:text-base">
        {{ row.lineName }}
      </p>
      <BandChip :band="row.band" :label="row.bandLabel" />
    </div>

    <p class="mt-1 text-xs text-slate-300 lg:text-base">
      {{ row.positionText }} · {{ row.vehicleText }} · {{ row.waitText }}
    </p>
    <p v-if="row.marginText" class="mt-0.5 text-xs text-slate-200 lg:text-base">
      {{ row.marginText }}
    </p>
    <p class="mt-0.5 text-xs text-slate-400 lg:text-base">
      {{ row.basisText }}
    </p>
    <p class="mt-0.5 text-xs text-slate-400 lg:text-base">
      {{ row.rideText }} · {{ row.alightText }}
    </p>
    <p v-if="markText" class="mt-0.5 text-xs text-slate-400 lg:text-base">
      {{ markText }}
    </p>

    <ul v-if="branches" class="mt-1.5 space-y-1">
      <li
        v-for="branch in branches"
        :key="branch.outcomeText"
        class="rounded-lg border border-slate-800 bg-slate-900/60 px-2.5 py-1.5"
      >
        <p class="text-xs font-medium text-slate-200 lg:text-base">{{ branch.outcomeText }}</p>
        <p class="mt-0.5 text-xs text-slate-400 lg:text-base">{{ branch.detailText }}</p>
      </li>
    </ul>
  </li>
</template>
