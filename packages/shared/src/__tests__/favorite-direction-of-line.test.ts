import { describe, expect, it } from 'vitest'
import { favoriteDirectionOfLine, resolveFavoriteLineId } from '../line-group.js'

/**
 * 一行「这一条上游线路属于收藏行编号里的哪个方向」的换算。
 *
 * 详情页要显示的那条线路说的是它自己 payload 的方向号（`detail.direction`），而收藏行存的
 * `morningDirection` / `eveningDirection` 是收藏行自己的编号 —— 锚在 `preferredDirection`
 * 上（设置页的单选、首页卡片、回填脚本都按这一套读）。两者对同一条真实线路可以相反：
 * 真实数据里 52 路收藏行的 `lineId` 是上游方向 0 的那条（`010-52-0`），而它自己的
 * `preferredDirection` 是 1。
 *
 * 所以要有一个名字明确、位置明确的换算，而不是各处各自推。两种形状都要证明：
 *  - 公交：两个方向是两条上游 lineId，线路本身已经定住了方向；
 *  - 地铁：两个方向共用一条 lineId，只能按 payload 自己的号（`preferredDirection`
 *    正是收录时上游对这条 lineId 给出的号）。
 */
describe('favoriteDirectionOfLine', () => {
  /** 52 路：存的是上游方向 0 的那条线，收藏行却把它记为方向 1。 */
  const FAV_52 = {
    lineId: '010-52-0',
    reverseLineId: '010-52-1',
    preferredDirection: 1,
  }

  it('公交（两个方向两条 lineId）：线路自己定方向，与 preferredDirection 的翻转无关', () => {
    expect(favoriteDirectionOfLine(FAV_52, '010-52-0', 0)).toBe(1)
    expect(favoriteDirectionOfLine(FAV_52, '010-52-1', 1)).toBe(0)
  })

  it('公交（编号本来就一致的行）：也就直接得到那个号', () => {
    const fav = { lineId: '001073243721', reverseLineId: '001073243761', preferredDirection: 0 }
    expect(favoriteDirectionOfLine(fav, '001073243721', 0)).toBe(0)
    expect(favoriteDirectionOfLine(fav, '001073243761', 1)).toBe(1)
  })

  it('地铁（两个方向共用一条 lineId）：lineId 分不出来，payload 自己的号就是收藏行的号', () => {
    const subway = { lineId: 'subway_027_1', reverseLineId: 'subway_027_1', preferredDirection: 0 }
    expect(favoriteDirectionOfLine(subway, 'subway_027_1', 0)).toBe(0)
    expect(favoriteDirectionOfLine(subway, 'subway_027_1', 1)).toBe(1)
    // 换算的结果与 `resolveFavoriteLineId` 互相印证：这个方向确实由这条 lineId 服务。
    for (const d of [0, 1] as const) {
      expect(resolveFavoriteLineId(subway, d)).toBe('subway_027_1')
    }
  })

  it('单向线路：收藏行只有一个方向，这条线就是那一个', () => {
    const oneWay = { lineId: '001000000001', preferredDirection: 0 }
    expect(favoriteDirectionOfLine(oneWay, '001000000001', 0)).toBe(0)
  })

  it('不属于这一行的线路：说 null，不猜一个方向', () => {
    expect(favoriteDirectionOfLine(FAV_52, '010-300-0', 0)).toBeNull()
  })
})
