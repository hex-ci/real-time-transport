/**
 * 置顶与取消置顶的位移动画，以及把移动过的那张带进视野的滚动。
 *
 * 两个方向的目的地性质不同，动画因此不对称：置顶送到**列表顶部**（已知，按钮就写着「置顶」），
 * 取消置顶送回**它自己那一槽**（任意，使用者不知道它会回到第几位）。所以取消置顶那张走得更远、
 * 也更需要被看清 —— 不做动画时它会从顶上消失、在下面某处冒出来。
 *
 * 方向由**实测的位移**读出，不由动作名：写入失败时 store 会回滚，卡片实际走的方向与按下的
 * 动作相反，按动作名取方向会把回滚画成反向动画。
 *
 * 文件分两半：上面是纯决策（给定数字算出该画什么、该滚到哪），下面才是碰 DOM 的那一半。
 */

/** 重排前后一张卡片的位置，视口坐标。 */
export interface CardBox {
  left: number
  top: number
  right: number
  bottom: number
}

/** 卡片往哪边走。 */
export type Travel = 'up' | 'down'

/** 它往哪边走 —— 正数表示新位置更高（往上走）。 */
export function travelOf(dy: number): Travel {
  return dy > 0 ? 'up' : 'down'
}

/**
 * 抬起（置顶）或下沉（取消置顶）的幅度，带符号：负数向上。
 *
 * 宽屏的卡片更大，同样的像素看不出来，故幅度也大一点。
 */
export function liftFor(travel: Travel, wide: boolean): number {
  const base = wide ? 6 : 4
  return travel === 'up' ? -base : base
}

/**
 * 放大（置顶）或微缩（取消置顶）。
 *
 * 窄屏不做缩放：卡片几乎占满宽度，缩一点点就会看到左右边缘在动，读起来像抖动而不是「放回去」。
 * 宽屏有富余，缩放正是「抬起 / 放下」那一半信息 —— 光看方向不必去读按钮文字。
 */
export function scaleFor(travel: Travel, wide: boolean): number {
  if (!wide) return 1
  return travel === 'up' ? 1.02 : 0.99
}

export const PIN_DURATION_MS = 400
/** 取消置顶的行程更长（要走过整段列表回到自己的槽），故多给一点 —— 同样时长下越远越像跳变。 */
export const UNPIN_EXTRA_MS = 80

export function durationFor(travel: Travel): number {
  return PIN_DURATION_MS + (travel === 'down' ? UNPIN_EXTRA_MS : 0)
}

/** 卡片与 sticky 顶栏之间留的空隙。 */
const GAP_PX = 8
/** 已经对齐到顶栏下方时的容差 —— 免得一次点按把视口挪一两个像素。 */
const ALIGN_TOLERANCE_PX = 12

export interface ScrollPlanInput {
  /** 被移动的那张卡片，重排后的位置。 */
  card: CardBox
  /** 列表顶，重排后的位置。 */
  gridTop: number
  /** sticky 顶栏的底边。 */
  headerBottom: number
  scrollY: number
  travel: Travel
  /** 它重排后是不是第一张。 */
  isFirst: boolean
}

/**
 * 该滚到哪；`null` 表示不必滚。
 *
 * 只有置顶会动视口：它的目的地是列表顶部，要让人看见「它到最上面了」，所以问的是「列表顶对齐了没有」。
 * 取消置顶一律不动视口 —— 它只是回到自己那一槽，卡片自己会走过去；此时再挪屏幕，等于为一个「离开」
 * 的动作把使用者的阅读位置也一起搬走。
 */
export function scrollTargetFor(input: ScrollPlanInput): number | null {
  const { card, gridTop, headerBottom, scrollY, travel, isFirst } = input

  if (travel !== 'up') return null

  const aligned = Math.abs(card.top - headerBottom - GAP_PX) <= ALIGN_TOLERANCE_PX
  if (isFirst && aligned) return null
  return Math.max(0, Math.round(scrollY + gridTop - headerBottom - GAP_PX))
}

/* ------------------------------------------------------------------ */
/* 以下碰 DOM。上面那一半是它据以决策的规则，两者都只需「一个矩形」这一个概念。 */
/* ------------------------------------------------------------------ */

const EASING = 'cubic-bezier(0.22, 0.61, 0.36, 1)'
const WIDE_QUERY = '(min-width: 768px)'
/** 抬起：被置顶那张的阴影. */
const LIFT_SHADOW = '0 22px 48px rgba(0, 0, 0, .6)'
/** 下沉：被取消置顶那张，比抬起轻一档 —— 它不在被强调，只是在离开. */
const SINK_SHADOW = '0 14px 32px rgba(0, 0, 0, .5)'

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function isWide(): boolean {
  return window.matchMedia(WIDE_QUERY).matches
}

/**
 * 三次贝塞尔求值器，与 CSS `cubic-bezier(x1, y1, x2, y2)` 同一套定义。
 *
 * 因为要与卡片自身的位移共用一条曲线，所以得在这里求值 —— 见 `animateScrollTo`。
 */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (x: number) => number {
  const ax = 1 - 3 * x2 + 3 * x1
  const bx = 3 * x2 - 6 * x1
  const cx = 3 * x1
  const ay = 1 - 3 * y2 + 3 * y1
  const by = 3 * y2 - 6 * y1
  const cy = 3 * y1
  const curveX = (t: number) => ((ax * t + bx) * t + cx) * t
  const curveY = (t: number) => ((ay * t + by) * t + cy) * t
  const slopeX = (t: number) => (3 * ax * t + 2 * bx) * t + cx

  return (x: number) => {
    if (x <= 0) return 0
    if (x >= 1) return 1
    // 牛顿迭代：由 x 反解参数 t，再取曲线上的 y。
    let t = x
    for (let i = 0; i < 8; i += 1) {
      const error = curveX(t) - x
      if (Math.abs(error) < 1e-6) break
      const d = slopeX(t)
      if (Math.abs(d) < 1e-6) break
      t -= error / d
    }
    return curveY(t)
  }
}

/**
 * 自己驱动滚动，而不是用 `scrollTo({ behavior: 'smooth' })`。
 *
 * 原生平滑滚动的时长由浏览器定、改不了；卡片自己的位移是一条 400ms 的曲线。两者不同步时，快的
 * 那一半先跑完 —— 实测滚 975 → 74 那一刻，卡片冲到视口上方 354px（**整张卡都在屏幕外**）再掉
 * 回来。共用同一条曲线与同一个时长，两个动作相加之后卡片的视口路径才是单调的。
 */
function animateScrollTo(target: number, duration: number): void {
  const start = window.scrollY
  const distance = target - start
  if (Math.abs(distance) < 1) return
  if (prefersReducedMotion()) {
    window.scrollTo(0, target)
    return
  }
  const ease = cubicBezier(0.22, 0.61, 0.36, 1)
  const began = performance.now()
  const step = () => {
    const elapsed = performance.now() - began
    const progress = Math.min(1, elapsed / duration)
    window.scrollTo(0, start + distance * ease(progress))
    if (progress < 1) requestAnimationFrame(step)
  }
  requestAnimationFrame(step)
}

/** 卡片元素 —— 带关注 id 的那些，两处都以这个属性为准。 */
function cardsOf(grid: HTMLElement): HTMLElement[] {
  return [...grid.querySelectorAll<HTMLElement>('[data-favorite-id]')]
}

/** 记下每张卡此刻的位置，键是关注 id。 */
export function captureCards(grid: HTMLElement): Map<string, CardBox> {
  const boxes = new Map<string, CardBox>()
  for (const el of cardsOf(grid)) {
    const id = el.dataset.favoriteId
    if (!id) continue
    const r = el.getBoundingClientRect()
    boxes.set(id, { left: r.left, top: r.top, right: r.right, bottom: r.bottom })
  }
  return boxes
}

interface Move {
  el: HTMLElement
  dx: number
  dy: number
  isTarget: boolean
}

/**
 * 把这次重排画出来：让位的卡片平移过去，被移动的那张抬起/下沉，然后把它的新位置带进视野。
 *
 * `before` 是重排前量的位置，`targetId` 是使用者按下的那一条（回滚时仍是它）。
 */
export function playReorder(
  grid: HTMLElement,
  before: Map<string, CardBox>,
  targetId: string | null,
): void {
  if (before.size === 0) return

  const cards = cardsOf(grid)
  const target = targetId ? cards.find(el => el.dataset.favoriteId === targetId) ?? null : null

  // 先把所有卡片量完再开始画：边量边画的话，后面的卡片会量到前面那张动画中的位置。
  const moves: Move[] = []
  for (const el of cards) {
    const id = el.dataset.favoriteId
    const was = id ? before.get(id) : undefined
    if (!was) continue
    const r = el.getBoundingClientRect()
    const dx = was.left - r.left
    const dy = was.top - r.top
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue
    moves.push({ el, dx, dy, isTarget: el === target })
  }
  // 什么都没动就没有「走去哪」可言，滚动的目标位置也就无从判断 —— 这一拍真的不用管。
  if (moves.length === 0) return

  const movedTarget = moves.find(m => m.isTarget)
  const firstMove = moves[0]!
  const travel = travelOf(movedTarget ? movedTarget.dy : firstMove.dy)
  const wide = isWide()
  const reduced = prefersReducedMotion()

  if (!reduced) {
    for (const { el, dx, dy, isTarget } of moves) {
      if (isTarget) {
        const natural = getComputedStyle(el).boxShadow
        el.style.zIndex = '2'
        el.animate(
          [
            {
              transform: `translate(${dx}px, ${dy}px) translateY(${liftFor(travel, wide)}px) scale(${scaleFor(travel, wide)})`,
              boxShadow: travel === 'up' ? LIFT_SHADOW : SINK_SHADOW,
            },
            // 阴影收回它本来那一档（读出来的，不是写死的），否则动画一结束会「啪」地跳一下。
            { transform: 'translate(0, 0) scale(1)', boxShadow: natural },
          ],
          { duration: durationFor(travel), easing: EASING, fill: 'none' },
        ).finished.finally(() => { el.style.zIndex = '' })
        continue
      }
      el.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }],
        { duration: durationFor(travel), easing: EASING, fill: 'none' },
      )
    }
  }

  if (!target) return

  // 滚动：置顶把列表顶带进视野，取消置顶只在它看不见时才滚。
  const r = target.getBoundingClientRect()
  const header = document.querySelector('header')
  const desired = scrollTargetFor({
    card: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
    gridTop: grid.getBoundingClientRect().top,
    headerBottom: header ? header.getBoundingClientRect().bottom : 0,
    scrollY: window.scrollY,
    travel,
    isFirst: cards[0] === target,
  })
  if (desired !== null && Math.abs(desired - window.scrollY) > 4) {
    // 与卡片自己的位移共用同一条曲线、同一个时长 —— 见 `animateScrollTo`。
    animateScrollTo(desired, durationFor(travel))
  }
}
