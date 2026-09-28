import { defineComponent, h } from 'vue'
import { toast } from 'vue-sonner'
import { X } from '@lucide/vue'
import type { RefreshOutcome, RefreshStatusText } from '@/stores/transit.store'

/**
 * 刷新结局的提示。
 *
 * 宿主只有一份（`App.vue` 里的 `<Toaster />`），故三页共用同一条提示，页面只说结局、不排版。
 * 这里是本仓与提示库之间唯一的接缝：时长、身份与色调都在这一处，库换了只有这个文件要改。
 */

/** 冷却那一条的身份。倒计时的每一秒都改写同一条，而不是每秒新弹一条。 */
export const REFRESH_COOLDOWN_TOAST_ID = 'refresh-cooldown'

/** 成功与失败自己退场；冷却驻留，因为它说的是「还要等多久」，一次说死就是假的。 */
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
 * 冷却那一条的两个节点。
 *
 * 库自己那个 polite 区域把整条提示都圈在播报范围内，于是逐秒改写的秒数会被读屏每秒念一遍。
 * 秒数单独一个 `aria-hidden` 的节点 —— 被隐藏的文本变化不触发播报，而宣告语留在它外面，
 * 一条提示说什么仍旧读得出来。两段是兄弟节点：宣告语绝不在被隐藏的那一段里面。
 *
 * 库用到自定义组件时不放它自己那枚关闭按钮（它的关闭按钮只在它自己排版的那一条上），
 * 而这一条驻留，故这个组件自己带着一枚，接到库交进来的那个处理器上。
 */
export const RefreshCooldownContent = defineComponent({
  props: {
    /** 宣告语：状态本身，进 live region 被读出。 */
    announcement: { type: String, required: true },
    /** 秒数那一段：逐秒改写，故它对读屏隐藏。 */
    detail: { type: String, required: true },
    /** 库交进来的关闭处理：本组件那枚关闭按钮就用它。 */
    onCloseToast: { type: Function, required: false },
    /** 库报出的交互状态。本组件不据它改样子，但认下它，免得它落到根节点上成一个属性。 */
    isPaused: { type: Boolean, default: false },
  },
  setup(props) {
    return () => h('div', { class: 'flex w-full items-center gap-3 p-4' }, [
      h('span', { class: 'min-w-0 flex-1' }, [
        h('span', null, props.announcement),
        h('span', { 'aria-hidden': 'true' }, props.detail),
      ]),
      h('button', {
        'type': 'button',
        'aria-label': '关闭提示',
        'class': 'shrink-0 rounded-lg p-1 text-slate-400 transition hover:text-slate-100',
        'onClick': () => props.onCloseToast?.(),
      }, h(X, { 'class': 'h-3.5 w-3.5', 'aria-hidden': 'true' })),
    ])
  },
})

/**
 * 一次按下的结局说一次。
 *
 * 成功与失败不给固定 id：同一个结局连着发生两次也该各说一次，而库按 id 会把第二条读成第一条的更新。
 *
 * 被拒是另一类：它驻留，并由此开始逐秒改写自己 —— 它是闸住动作的信息，一次说死就是假的。
 */
export function announceRefreshOutcome(outcome: RefreshOutcome, text: RefreshStatusText): void {
  if (outcome === 'throttled') {
    announceRefreshCooldown(text)
    return
  }
  // 上一次的倒计时说的那个窗口已被这次按下花掉，故先撤掉它。
  dismissRefreshCooldown()
  toast(textOf(text), {
    duration: REFRESH_RESULT_DURATION_MS,
    class: `${TOAST_ITEM_CLASS} ${TONE_OF[outcome]}`,
  })
}

/** 冷却：驻留，并用同一个 id 把秒数改写成下一秒。 */
export function announceRefreshCooldown(text: RefreshStatusText): void {
  // 自定义组件不被库按它自己那一套排版，故宽度自己写一份：就是它给自排条目用的那个宽度。
  const classes = `${TOAST_ITEM_CLASS} ${TONE_OF.throttled} w-[var(--width)]`
  toast.custom(RefreshCooldownContent, {
    id: REFRESH_COOLDOWN_TOAST_ID,
    duration: Infinity,
    class: classes,
    componentProps: { announcement: text.announcement, detail: text.detail },
  })
}

export function dismissRefreshCooldown(): void {
  toast.dismiss(REFRESH_COOLDOWN_TOAST_ID)
}
