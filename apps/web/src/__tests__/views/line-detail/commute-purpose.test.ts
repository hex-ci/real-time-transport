import { describe, expect, it } from 'vitest'
import { purposeForMinutes } from '@/composables/use-commute-purpose'

/**
 * 通勤时段判断（纯函数）：四个时刻 + 现在几点几分 → 处于哪个通勤时段。
 *
 * 这是智能聚焦的事实基础 —— 上班时段聚焦上班上车站、下班时段聚焦下班上车站。
 * 钉住边界语义：起点含、终点不含；早晚窗口重叠时早上优先（与界面层一致）；
 * 从未设置过时刻时按默认窗口启发式（只决定镜头行为，不在界面上主张）。
 */
describe('purposeForMinutes', () => {
  const HOURS = {
    morningStart: '06:30',
    morningEnd: '11:30',
    eveningStart: '17:00',
    eveningEnd: '22:00',
  }

  it('上班时段内报 morning，边界起点含、终点不含', () => {
    expect(purposeForMinutes(HOURS, 6 * 60 + 30)).toBe('morning')
    expect(purposeForMinutes(HOURS, 8 * 60)).toBe('morning')
    expect(purposeForMinutes(HOURS, 11 * 60 + 29)).toBe('morning')
    expect(purposeForMinutes(HOURS, 11 * 60 + 30)).toBeNull()
  })

  it('下班时段内报 evening', () => {
    expect(purposeForMinutes(HOURS, 17 * 60)).toBe('evening')
    expect(purposeForMinutes(HOURS, 19 * 60 + 30)).toBe('evening')
    expect(purposeForMinutes(HOURS, 21 * 60 + 59)).toBe('evening')
    expect(purposeForMinutes(HOURS, 22 * 60)).toBeNull()
  })

  it('两个窗口之外报 null：不聚焦，走原来的镜头逻辑', () => {
    expect(purposeForMinutes(HOURS, 12 * 60)).toBeNull()
    expect(purposeForMinutes(HOURS, 2 * 60)).toBeNull()
    expect(purposeForMinutes(HOURS, 23 * 60)).toBeNull()
  })

  it('从未设置过时刻时按默认窗口（06:30–11:30 / 17:00–22:00）启发式', () => {
    expect(purposeForMinutes(null, 8 * 60)).toBe('morning')
    expect(purposeForMinutes(null, 18 * 60)).toBe('evening')
    expect(purposeForMinutes(null, 13 * 60)).toBeNull()
  })

  it('时刻缺失或非法时不报：缺时刻不是"全天都是通勤时段"', () => {
    expect(purposeForMinutes({ ...HOURS, morningStart: null }, 8 * 60)).toBeNull()
    expect(purposeForMinutes({ ...HOURS, eveningEnd: 'xx' }, 18 * 60)).toBeNull()
  })

  it('跨午夜的窗口按两段算', () => {
    const overnight = { ...HOURS, eveningStart: '22:00', eveningEnd: '02:00' }
    expect(purposeForMinutes(overnight, 23 * 60)).toBe('evening')
    expect(purposeForMinutes(overnight, 1 * 60)).toBe('evening')
    expect(purposeForMinutes(overnight, 3 * 60)).toBeNull()
  })
})
