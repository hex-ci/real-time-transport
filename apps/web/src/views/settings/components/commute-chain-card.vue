<script setup lang="ts">
/**
 * F10's chain editor, as 设置's own card: the chains the user recorded, and the one
 * place they are created, edited and deleted.
 *
 * It is a CARD inside this screen rather than a page of its own, and that is the
 * requirement's shape: 「链路由使用者录入」, and 「链路页是读结论的地方，不是录入的地方」 —
 * the first-level entry beside the home screen shows what the chains conclude, while
 * recording them belongs with the other once-set preferences.
 *
 * Nothing here computes a conclusion: no margin, no wait, no duration of any kind. The
 * editor records facts (a line, a board station, an alight station), and the chain page
 * is where they are walked against live readings. A save is answered by the server's
 * own record of what was stored, so the list can never show a chain the server does
 * not hold, and a refusal is printed verbatim rather than swallowed.
 */
import { computed, onMounted, shallowRef } from 'vue'
import { Pencil, Plus, RefreshCw, Route, Trash2, TriangleAlert } from '@lucide/vue'
import { storeToRefs } from 'pinia'
import type { CommuteChain } from '@real-time-transport/shared'
import ChainForm from './chain-form.vue'
import ChainRemovalDialog from './chain-removal-dialog.vue'
import type { ReadState } from '@/read-state'
import { useTransitStore } from '@/stores/transit.store'
import type { CommuteChainWrite } from '@/stores/transit.store'
import {
  anchorText,
  editorOptionsFor,
  legPositionText,
  purposeText,
  stationPairText,
} from '../chain-draft'
import type { ChainLineOption } from '../types'

const props = defineProps<{
  /** Every line+direction a ride leg may name, supplied by the page that loads them. */
  lines: ChainLineOption[]
  /**
   * The followed-lines read's own state, passed straight through to the editor.
   *
   * The page (`chains.vue`) owns that read — it is `line-stops.ts`'s, shared with 关注线路 —
   * and the editor is the surface that feels its absence, so the card carries the state and
   * the retry between them rather than judging either itself.
   */
  linesRead: ReadState
}>()

const emit = defineEmits<{
  (e: 'retry-lines'): void
}>()

const transitStore = useTransitStore()
const { commuteChains } = storeToRefs(transitStore)

/** True until the first read of the stored chains has answered. */
const loading = shallowRef(true)
/** The read itself failed — a state of its own, never the empty state's words. */
const loadError = shallowRef<string | null>(null)

/** Which chain the editor is open on: a new one, an existing one, or none. */
const editing = shallowRef<{ chain: CommuteChain | null } | null>(null)
const saving = shallowRef(false)
/** The server's refusal of the last save, verbatim. */
const saveError = shallowRef<string | null>(null)

/** The chain queued for removal, and the failure of the last attempt. */
const pendingRemoval = shallowRef<CommuteChain | null>(null)
const removing = shallowRef(false)
const removalError = shallowRef<string | null>(null)

const rows = computed(() => commuteChains.value)

/**
 * The lines the open editor may offer: the page's followed ones, plus a line the chain
 * being edited already names when it can no longer be chosen from. Without the second
 * part a stored leg whose route was unfollowed would open with no line selected, and the
 * save would refuse a draft the user never made.
 */
const editorLines = computed(() => editorOptionsFor(editing.value?.chain ?? null, props.lines))

/**
 * Read the stored chains.
 *
 * A read that fails is stated as its own cause, with the retry that is the only thing
 * that can fix it — never as the empty state's 「还没有录入」, which would claim an
 * emptiness nobody read. Nothing here re-reads on a timer: this card is what writes the
 * list, so the only read that can fail is one the user asked for by opening the screen.
 */
async function load(): Promise<void> {
  loading.value = true
  const answered = await transitStore.fetchCommuteChains()
  loading.value = false
  loadError.value = answered ? null : '换乘链读取失败'
}

onMounted(() => {
  void load()
})

function openCreate(): void {
  saveError.value = null
  editing.value = { chain: null }
}

function openEdit(chain: CommuteChain): void {
  saveError.value = null
  editing.value = { chain }
}

function closeEditor(): void {
  editing.value = null
  saveError.value = null
}

async function onSubmit(write: CommuteChainWrite): Promise<void> {
  const target = editing.value
  if (!target) return
  saving.value = true
  saveError.value = null
  try {
    await transitStore.saveCommuteChain(target.chain?.id ?? null, write)
    editing.value = null
  }
  catch (err) {
    // The contract's own message, as the server worded it.
    saveError.value = err instanceof Error ? err.message : '链路保存失败'
  }
  finally {
    saving.value = false
  }
}

/**
 * The draft changed after a save had been answered.
 *
 * The server's refusal is about the request THAT draft produced, so once the input it
 * named is edited the sentence would be describing a request nobody has made any more —
 * the same claim-outliving-its-state the form retires on its own refusal, retired here
 * for the server's. Nothing is lost by it: the next save is answered afresh.
 */
function onDraftEdit(): void {
  saveError.value = null
}

function requestRemoval(chain: CommuteChain): void {
  removalError.value = null
  pendingRemoval.value = chain
}

/**
 * Remove the pending chain, keeping the dialog up until the request settles: a refusal
 * leaves the reason visible on the control the user just pressed instead of the row
 * silently staying put.
 */
async function confirmRemoval(): Promise<void> {
  const target = pendingRemoval.value
  if (!target?.id || removing.value) return
  removing.value = true
  removalError.value = null
  try {
    await transitStore.removeCommuteChain(target.id)
    pendingRemoval.value = null
  }
  catch (err) {
    removalError.value = err instanceof Error ? err.message : '链路删除失败'
  }
  finally {
    removing.value = false
  }
}

/** 「上班 · 从「家」出发」 — the chain's own two stored facts. */
function chainMeta(chain: CommuteChain): string {
  return `${purposeText(chain.purpose)} · 从「${anchorText(chain.originAnchor)}」出发`
}

/** 「第 1 段 · 快线 1 路：东大桥 第3站 → 建国门 第4站」, with an unchosen half left absent. */
function legText(chain: CommuteChain, index: number): string {
  const leg = chain.legs[index]!
  return `${legPositionText(index)} · ${leg.lineName}：${stationPairText(leg.boardStationName, leg.boardStationOrder)} → ${stationPairText(leg.alightStationName, leg.alightStationOrder)}`
}

/** 「接驳额外 5 分」 for a leg that has one configured, and nothing at all for a null. */
function legExtraText(chain: CommuteChain, index: number): string | null {
  const minutes = chain.legs[index]!.transferExtraMinutes
  return minutes === null ? null : `接驳额外 ${minutes} 分`
}
</script>

<template>
  <!-- The section is named BY its own visible heading rather than by a copy of that text
       in `aria-label`: a label attribute repeats the words the heading already renders, so
       a screen reader announcing the region and then the heading hears 「通勤链路」 twice.
       `aria-labelledby` points at the heading's text, so the name IS the heading. -->
  <section
    aria-labelledby="commute-chain-heading"
    class="rounded-3xl border border-slate-800 bg-slate-900/80 p-4 shadow-xl sm:p-5"
  >
    <div class="flex flex-wrap items-center justify-between gap-2">
      <h3 class="flex items-center gap-2 text-sm font-semibold text-slate-200 lg:text-base">
        <Route class="h-4 w-4 shrink-0 text-cyan-400" aria-hidden="true" />
        <span id="commute-chain-heading">通勤链路</span>
        <span v-if="rows.length > 0" class="font-normal text-slate-400">({{ rows.length }})</span>
      </h3>
      <button
        type="button"
        class="flex min-h-[44px] items-center gap-1.5 rounded-xl border border-cyan-500/30 bg-cyan-500/10 px-3 text-xs font-semibold text-cyan-400 transition hover:bg-cyan-500/20 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
        :disabled="editing !== null"
        @click="openCreate"
      >
        <Plus class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>新增链路</span>
      </button>
    </div>

    <p class="mt-1 text-xs text-slate-400">
      链路自己录入，不由系统规划：逐段选线路、上车站与下车站
    </p>

    <ChainForm
      v-if="editing"
      :key="editing.chain?.id ?? 'new'"
      class="mt-3 border-t border-slate-800/60 pt-3"
      :chain="editing.chain"
      :lines="editorLines"
      :lines-read="linesRead"
      :saving="saving"
      :error="saveError"
      @submit="onSubmit"
      @cancel="closeEditor"
      @edit="onDraftEdit"
      @retry-lines="emit('retry-lines')"
    />

    <!-- The read's own failure, and the only thing that can fix it. -->
    <div v-if="loadError" class="mt-3 flex flex-wrap items-center gap-2">
      <p class="flex items-center gap-1.5 text-xs text-rose-400">
        <TriangleAlert class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>{{ loadError }}</span>
      </p>
      <button
        type="button"
        class="flex min-h-[44px] items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-950 px-3 text-xs text-slate-200 transition hover:border-cyan-500/40 active:scale-95"
        @click="load"
      >
        <RefreshCw class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>重试</span>
      </button>
    </div>

    <!-- Still reading: this is not the empty state, and must not borrow its words. -->
    <p v-else-if="loading" class="mt-3 text-xs text-slate-400">
      正在读取换乘链…
    </p>

    <!-- Nothing recorded: the cause is this card's own subject, and the action is the
         control above it. The failed read above is a different cause and is never
         shadowed by this one. -->
    <p
      v-else-if="rows.length === 0"
      class="mt-3 rounded-xl border border-dashed border-slate-800 bg-slate-950/60 p-4 text-xs text-slate-400"
    >
      还没有录入通勤链路。点「新增链路」逐段录入：名称、起点、通勤目的，加上每一段的线路、上车站与下车站
    </p>

    <ul v-else class="mt-3 divide-y divide-slate-800/80 rounded-xl border border-slate-800 bg-slate-950">
      <li v-for="chain in rows" :key="chain.id" class="space-y-1.5 p-3">
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0">
            <div class="truncate text-xs font-semibold text-slate-200">
              {{ chain.name }}
            </div>
            <div class="mt-0.5 text-xs text-slate-400">
              {{ chainMeta(chain) }}
            </div>
          </div>
          <div class="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              class="flex min-h-[44px] items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-3 text-xs text-slate-200 transition hover:border-cyan-500/40 active:scale-95"
              @click="openEdit(chain)"
            >
              <Pencil class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>编辑</span>
            </button>
            <button
              type="button"
              class="flex min-h-[44px] items-center gap-1.5 rounded-lg border border-rose-500/20 bg-rose-500/10 px-3 text-xs text-rose-400 transition hover:bg-rose-500/20 active:scale-95"
              @click="requestRemoval(chain)"
            >
              <Trash2 class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>删除</span>
            </button>
          </div>
        </div>
        <div class="space-y-0.5">
          <p v-for="(_, index) in chain.legs" :key="index" class="text-xs text-slate-300">
            {{ legText(chain, index) }}
            <span v-if="legExtraText(chain, index)" class="text-slate-400">
              · {{ legExtraText(chain, index) }}
            </span>
          </p>
        </div>
      </li>
    </ul>

    <ChainRemovalDialog
      :open="pendingRemoval !== null"
      :chain-name="pendingRemoval?.name ?? null"
      :removing="removing"
      :error="removalError"
      @confirm="confirmRemoval"
      @cancel="pendingRemoval = null"
    />
  </section>
</template>
