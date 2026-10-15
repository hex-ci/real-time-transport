import { describe, expect, it } from 'vitest'
import { stopsAwayOf } from '../arrival-ordinals.js'

/**
 * 「到目标站还有几站」的口径：**下一站就是本站时是 0 站**，中间还隔一站才是 1 站。
 *
 * 这个数在两条路径上都要对：服务端组装的到站行，与前端在到站答案回来之前的回退。它们各写一份时
 * 会差一站 —— 用户看到的就是「同一个站一会儿 2 站一会儿 1 站」。
 */
describe('stopsAwayOf', () => {
  it('车下一站就是本站时报 0 站（屏上说「即将到站」）', () => {
    expect(stopsAwayOf({ targetOrder: 14, order: 13, nextOrder: 14 })).toBe(0)
  })

  it('中间还隔一站时报 1 站', () => {
    expect(stopsAwayOf({ targetOrder: 14, order: 12, nextOrder: 13 })).toBe(1)
  })

  it('隔两站报 2 站', () => {
    expect(stopsAwayOf({ targetOrder: 14, order: 11, nextOrder: 12 })).toBe(2)
  })

  it('只有车头时照车头算（它就是下一站）', () => {
    expect(stopsAwayOf({ targetOrder: 14, nextOrder: 14 })).toBe(0)
    expect(stopsAwayOf({ targetOrder: 14, nextOrder: 13 })).toBe(1)
  })

  it('只有「刚经过的那一站」时，车头是它前面那一站', () => {
    expect(stopsAwayOf({ targetOrder: 14, order: 13 })).toBe(0)
    expect(stopsAwayOf({ targetOrder: 14, order: 12 })).toBe(1)
  })

  it('两个序数都没有时不臆造位置，答最近的那一档', () => {
    expect(stopsAwayOf({ targetOrder: 14 })).toBe(0)
  })
})
