import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  PIN_DURATION_MS,
  UNPIN_EXTRA_MS,
  cubicBezier,
  durationFor,
  liftFor,
  scaleFor,
  scrollTargetFor,
  travelOf,
  type CardBox,
} from '../../../views/overview/pin-motion'

/**
 * 置顶 / 取消置顶的位移动画与滚动：决策部分。
 *
 * 这些断言钉住的是**不对称**那一条：两个方向的目的地性质不同（顶部是已知的、自己那一槽是
 * 任意的），所以抬起/下沉、时长、以及「该滚到哪」问的都不是同一个问题。滚动规则尤其容易被
 * 简化回「一律滚」或「一律不滚」—— 它在单列上会失效（手机一屏看得见两张，置顶后新位置仍算
 * 「可见」，于是不滚，可使用者要的是「看它到最上面了没有」）。
 */

function box(top: number, bottom: number): CardBox {
  return { left: 0, top, right: 100, bottom }
}

describe('方向由实测的位移读出，不由动作名读出', () => {
  it('新位置更高就是往上走（置顶），更低就是往下走（取消置顶）', () => {
    expect(travelOf(120)).toBe('up')
    expect(travelOf(-120)).toBe('down')
  })

  it('位移为零也归为往下 —— 写入失败回滚时卡片确实在往下走', () => {
    expect(travelOf(0)).toBe('down')
  })
})

describe('抬起与下沉在两端幅度不同', () => {
  it('置顶向上、取消置顶向下，两者符号相反', () => {
    expect(liftFor('up', false)).toBeLessThan(0)
    expect(liftFor('down', false)).toBeGreaterThan(0)
    expect(liftFor('up', true)).toBeLessThan(0)
    expect(liftFor('down', true)).toBeGreaterThan(0)
  })

  it('宽屏卡片更大，同样的像素看不出来，故幅度也更大', () => {
    expect(Math.abs(liftFor('up', true))).toBeGreaterThan(Math.abs(liftFor('up', false)))
  })

  it('窄屏不做缩放 —— 卡片几乎占满宽度，缩一点就看到边缘在动', () => {
    expect(scaleFor('up', false)).toBe(1)
    expect(scaleFor('down', false)).toBe(1)
  })

  it('宽屏靠放大与微缩说出「送上去」还是「放回去」', () => {
    expect(scaleFor('up', true)).toBeGreaterThan(1)
    expect(scaleFor('down', true)).toBeLessThan(1)
  })
})

describe('取消置顶的行程更长，故时间也更长', () => {
  it('同样时长下走得越远越像跳变', () => {
    expect(durationFor('down')).toBe(PIN_DURATION_MS + UNPIN_EXTRA_MS)
    expect(durationFor('up')).toBe(PIN_DURATION_MS)
    expect(durationFor('down')).toBeGreaterThan(durationFor('up'))
  })
})

describe('该滚到哪', () => {
  const headerBottom = 82

  it('置顶：它已经落在首位且已对齐到顶栏下方 → 不滚', () => {
    expect(scrollTargetFor({
      card: box(headerBottom + 8, 400),
      gridTop: headerBottom + 8,
      headerBottom,
      scrollY: 300,
      travel: 'up',
      isFirst: true,
    })).toBeNull()
  })

  it('置顶：它还没到首位 → 把列表顶带进顶栏下方', () => {
    expect(scrollTargetFor({
      card: box(900, 1200),
      gridTop: 500,
      headerBottom,
      scrollY: 0,
      travel: 'up',
      isFirst: false,
    })).toBe(410)
  })

  it('置顶：它已是首位、但列表顶被滚上去了 → 仍要滚回来', () => {
    // 单列上就是这个情形：手机滚到 1056 处点最后一张，它重排后确实落在首位，可它的新位置在
    // 视口上方（top 为负）—— 只问「是不是首位」会得出「不必滚」，于是使用者看不到它到没到顶。
    expect(scrollTargetFor({
      card: box(-892, -600),
      gridTop: -892,
      headerBottom,
      scrollY: 1056,
      travel: 'up',
      isFirst: true,
    })).toBe(74)
  })

  it('置顶：列表顶已在顶栏之上时，落点不会为负', () => {
    // scrollTo 传负数会被当成 0，但算式里先算出来的负值会让「要不要滚」的判断出错。
    expect(scrollTargetFor({
      card: box(50, 300),
      gridTop: 50,
      headerBottom,
      scrollY: 0,
      travel: 'up',
      isFirst: false,
    })).toBe(0)
  })

  it('取消置顶一律不动视口 —— 它掉到哪里都不滚', () => {
    // 它是「离开」：卡片自己会走回那一槽，再把使用者的阅读位置也一起搬走，就是为一个离开的动作
    // 打扰阅读。下面三种是取消置顶时真会出现的落点：看不见、露出半张、以及被顶栏遮住。
    const cases: Array<{ card: CardBox, gridTop: number, scrollY: number }> = [
      { card: box(900, 1200), gridTop: 200, scrollY: 0 },
      { card: box(300, 600), gridTop: 200, scrollY: 400 },
      { card: box(10, 300), gridTop: -800, scrollY: 500 },
    ]
    for (const one of cases) {
      expect(scrollTargetFor({ ...one, headerBottom, travel: 'down', isFirst: false })).toBeNull()
    }
  })
})

describe('同步滚动的曲线', () => {
  const ease = cubicBezier(0.22, 0.61, 0.36, 1)

  it('两端点严格落在 0 与 1', () => {
    expect(ease(0)).toBe(0)
    expect(ease(1)).toBe(1)
    expect(ease(-0.5)).toBe(0)
    expect(ease(1.5)).toBe(1)
  })

  it('单调不减 —— 滚动与位移相加后卡片才可能单调，曲线自己先得单调', () => {
    let last = -1
    for (let i = 0; i <= 100; i += 1) {
      const v = ease(i / 100)
      expect(v).toBeGreaterThanOrEqual(last)
      last = v
    }
    expect(last).toBe(1)
  })

  it('前段推进快于线性（ease-out），这正是它与原生平滑滚动不同步的原因', () => {
    expect(ease(0.25)).toBeGreaterThan(0.25)
    expect(ease(0.5)).toBeGreaterThan(0.5)
  })

  it('线性曲线就是恒等 —— 求值器本身没有额外调味', () => {
    const linear = cubicBezier(0, 0, 1, 1)
    for (const x of [0.1, 0.35, 0.5, 0.8, 0.95]) {
      expect(linear(x)).toBeCloseTo(x, 3)
    }
  })
})

describe('接线：动画拿得到「重排前」的坐标', () => {
  it('网格给每张卡片带上关注 id —— 量坐标与点名都以它为准', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../../views/overview/components/card-grid.vue', import.meta.url)),
      'utf-8',
    )
    expect(source).toContain(':data-favorite-id="line.favoriteId"')
  })

  it('重排前的坐标在 DOM 更新之前量（onBeforeUpdate），画在之后（onUpdated）', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../../views/overview/components/card-grid.vue', import.meta.url)),
      'utf-8',
    )
    // 在 `onUpdated` 里量会把新位置当成旧位置，位移恒为零 —— 动画静默失效。故断言的是
    // **调用顺序**：量坐标必须夹在 onBeforeUpdate 与 onUpdated 之间。
    const beforeIdx = source.indexOf('onBeforeUpdate(')
    const captureIdx = source.indexOf('captureCards(')
    const updatedIdx = source.indexOf('onUpdated(')
    expect(beforeIdx).toBeGreaterThan(-1)
    expect(updatedIdx).toBeGreaterThan(-1)
    expect(captureIdx).toBeGreaterThan(beforeIdx)
    expect(captureIdx).toBeLessThan(updatedIdx)
    expect(source).toMatch(/onUpdated\(\(\) => \{[\s\S]*?playReorder\(/)
  })

  it('点名只在一次置顶动作期间设下 —— 否则到站刷新引起的重排也会被画成动画', () => {
    const page = readFileSync(
      fileURLToPath(new URL('../../../views/overview/index.vue', import.meta.url)),
      'utf-8',
    )
    expect(page).toContain(':motion-target-id="pinMotionTargetId"')
    expect(page).toMatch(/pinMotionTargetId\.value = favoriteId/)
    expect(page).toMatch(/await nextTick\(\)\s*\n\s*pinMotionTargetId\.value = null/)
  })
})
