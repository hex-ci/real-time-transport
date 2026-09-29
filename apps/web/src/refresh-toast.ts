import { toast } from 'vue-sonner'
import type { RefreshOutcome, RefreshStatusText } from '@/stores/transit.store'

/**
 * 刷新结局的提示。
 *
 * 宿主只有一份（`App.vue` 里的 `<Toaster />`），故三页共用同一条提示，页面只说结局、不排版。
 * 这里是本仓与提示库之间唯一的接缝：时长与色调都在这一处，库换了只有这个文件要改。
 */

/** 每一个结局自己退场：冷却那一条也只说一次，不驻留（见 `docs/PRD.md` F11）。 */
export const REFRESH_RESULT_DURATION_MS = 4000

/** 条目样式对齐全站；色调只是给那句话撑腰，话本身携带状态。 */
export const TOAST_ITEM_CLASS = 'rounded-xl border border-slate-700 bg-slate-800/90 text-xs'

const TONE_OF: Record<RefreshOutcome, string> = {
  ok: 'text-cyan-300',
  throttled: 'text-amber-300',
  unavailable: 'text-rose-300',
  offline: 'text-rose-300',
}

/** 一条提示的全文：粗粒度状态，冷却时再带上它自己那个秒数。 */
function textOf(text: RefreshStatusText): string {
  return `${text.announcement}${text.detail}`
}

/**
 * 一次按下的结局说一次。
 *
 * 四个结局同一条路径（含被拒）：按服务端答的时长说「还要等多久」，一次说清，然后自己退场。
 * 秒数不逐秒改写 —— 用户再问（再点一下）时 store 会按那一刻重算再答一次。
 *
 * 不给固定 id：同一个结局连着发生两次也该各说一次，而库按 id 会把第二条读成第一条的更新。
 */
export function announceRefreshOutcome(outcome: RefreshOutcome, text: RefreshStatusText): void {
  toast(textOf(text), {
    duration: REFRESH_RESULT_DURATION_MS,
    class: `${TOAST_ITEM_CLASS} ${TONE_OF[outcome]}`,
  })
}
