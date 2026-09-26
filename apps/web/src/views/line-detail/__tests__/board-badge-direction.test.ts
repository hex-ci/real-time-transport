import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * 报站板上两个通勤上车点角标的方向行为，以及它上面那段注释说的是不是真事。
 *
 * Konva 的静态层没有测试台（这个仓库没有 DOM harness，也没有 jsdom），所以规则本身在这里按
 * 源码钉住 —— 与 `commute-stop-pair.test.ts` 钉它「按 (站名, 站序) 一对认站」那一处同一个
 * 理由。页面把什么交给报站板，在 `direction-one-source.test.ts` 里按行为钉（挂载真实的详情页，
 * 看桩件收到的 props）。
 *
 * 一屏一个方向，而上车点是按「通勤目的」存的：`morningStopDirection` / `eveningStopDirection`
 * 是使用者存下来的选择（收藏行自己的编号），与这一屏画的 `shownDirection` 同一套，
 * 与 `lineDetail.direction`（payload 自己的编号）不是同一套 —— 对同一条真实线路两者可以相反。
 */
describe('报站板的上车点角标只出现在它自己那个方向上', () => {
  const board = readFileSync(
    fileURLToPath(new URL('../components/route-board.vue', import.meta.url)),
    'utf8',
  )

  it('角标的判据里带着方向，不是只对上 (站名, 站序) 就标', () => {
    expect(board).toContain(
      'onShownDirection(morningStopDirection) && storedStopAt(pt.station, morningStopName, morningStopOrder)',
    )
    expect(board).toContain(
      'onShownDirection(eveningStopDirection) && storedStopAt(pt.station, eveningStopName, eveningStopOrder)',
    )
  })

  it('方向不同就不标；方向未知时按这一对走（旧行没有方向字段，这一对就是它唯一的说法）', () => {
    expect(board).toContain('function onShownDirection(purposeDirection: 0 | 1 | null): boolean')
    expect(board).toContain('if (purposeDirection === null || shownDirection === null) return true')
    expect(board).toContain('return purposeDirection === shownDirection')
  })

  it('方向来自页面给的 props（收藏行的编号），不与 payload 的方向号互相比', () => {
    expect(board).toContain('shownDirection?: 0 | 1 | null')
    expect(board).toContain('morningStopDirection?: 0 | 1 | null')
    expect(board).toContain('eveningStopDirection?: 0 | 1 | null')
    // 两套编号不是同一套：拿它们直接比较，对 52 路这类收藏行会把角标标到反方向那一条上。
    expect(board, 'the board compares the favourite’s numbering with the payload’s')
      .not.toContain('morningStopDirection === lineDetail.direction')
    expect(board).not.toContain('eveningStopDirection === lineDetail.direction')
  })

  it('使用者改了通勤方向，角标会重画（方向在重画的键里）', () => {
    expect(board).toContain(
      'morningStopOrder, eveningStopName, eveningStopOrder, shownDirection, morningStopDirection, eveningStopDirection',
    )
  })

  it('注释说的是现在成立的事：不再声称方向是由两个上车点的站序推出来的', () => {
    // 005 把「按站序推断通勤方向」整段删掉了（`packages/shared/src/line-group.ts` 的
    // `deriveCommuteDirections` 现在只留给一次性回填），方向改由使用者显式选择；
    // 而「两个角标一起看就看出方向」这句话在那之后就不成立了。
    expect(board, 'the badge comment still claims the direction verdict is derived from the pins’ order')
      .not.toContain('the leg is derived from their order')
    expect(board).toContain('按站序推断方向的那套推导 005 已删')
  })
})
