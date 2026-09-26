import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { nearbyEmptyNoticeOf, nearbyLocationStateOf } from '../views/overview/nearby-notice'

/**
 * 附近卡片的空态，以及它不得混淆的两种成因。
 *
 * 附近卡片不显示站台有两种原因：应用完全没有位置（从未询问、被拒、请求仍在途），或者有位置
 * 而本线路没有站点解析在附近。卡片曾用 `mode === 'nearby' && rows.length === 0` 判断空态，
 * 它对两者都成立，于是对已授权定位的用户说了「开启定位后显示离你最近的站点车辆」。
 *
 * 因此位置事实从 location store 经视图作为显式输入进入卡片，共 store 可区分的三种状态；
 * 措辞在此，末尾的守卫钉单元测试看不到的接线。
 */

describe('the two causes of an empty nearby card are worded as what they are', () => {
  it('does not claim 「开启定位」 for a card that already has a position', () => {
    const noFix = nearbyEmptyNoticeOf('absent')
    const hasFix = nearbyEmptyNoticeOf('fix')

    expect(hasFix, 'the position and no-position causes read the same').not.toBe(noFix)
    // 本缺陷的句子：已有定位时，开启定位并非缺失之物，故本状态不得提它。
    expect(hasFix).not.toContain('开启定位')
    expect(hasFix).toContain('站台')
    expect(noFix).toContain('开启定位')
  })

  it('names a fix that has not arrived yet as a request, not as an unset permission', () => {
    const locating = nearbyEmptyNoticeOf('locating')
    // 用户这里什么都不缺：定位在途中，状态如实说，不要求任何设置。与另两种成因不同，
    // 因为等待定位与从未授权的用户处境不同、下一步也不同。
    expect(locating).not.toBe(nearbyEmptyNoticeOf('absent'))
    expect(locating).not.toBe(nearbyEmptyNoticeOf('fix'))
    expect(locating).not.toContain('开启定位')
  })

  it('keeps every notice one short line of body text', () => {
    for (const state of ['absent', 'locating', 'fix', 'unsupported'] as const) {
      expect(nearbyEmptyNoticeOf(state).length, state).toBeLessThanOrEqual(24)
    }
  })

  it('reads every state as a sentence of its own, so no two can be confused', () => {
    const states = ['absent', 'locating', 'fix', 'unsupported'] as const
    const notices = states.map(state => nearbyEmptyNoticeOf(state))
    expect(new Set(notices).size, 'two states word the same situation').toBe(notices.length)
  })
})

/**
 * 完全没有 geolocation API 的浏览器。
 *
 * `useGeolocation` 通过 `isSupported` 上报它，store 已在 `locationError` 中点名；附近卡片曾把每种
 * 失败都映射为 `absent`，其句子让用户去开启定位——而该浏览器做不到，因为能力是缺失而非被拒。
 * 因此这种情况有自己的状态，其句子陈述该浏览器的真实处境。
 *
 * 权限被拒与从未询问**刻意**不拆分：`absent` 让两者都去授予权限（经由浏览器提示或
 * 最近站按钮），对两者都是正确的下一步；只有能力缺失有别的下一步，也只有它值得自己的措辞。
 */
describe('a browser that cannot locate at all is told what is true of it', () => {
  it('reads a browser with no geolocation support as its own state', () => {
    expect(nearbyLocationStateOf({ hasFix: false, requesting: false, failed: false, supported: false }))
      .toBe('unsupported')
    // 被拒与从未询问都是「尚无权限」：下一步相同（授予，或点击发起询问的按钮），故留在一起。
    expect(nearbyLocationStateOf({ hasFix: false, requesting: false, failed: true, supported: true }))
      .toBe('absent')
  })

  it('lets a fix in hand outrank the capability read', () => {
    // 状态先回答「是否有定位」：已经上报的位置就是位置，不管 store 说浏览器支持什么。
    expect(nearbyLocationStateOf({ hasFix: true, requesting: false, failed: false, supported: false }))
      .toBe('fix')
  })

  it('words that state as the browser lacking the capability, not as a setting', () => {
    const unsupported = nearbyEmptyNoticeOf('unsupported')
    expect(unsupported, 'a browser with no geolocation was told to enable location')
      .not.toContain('开启定位')
    expect(unsupported).not.toBe(nearbyEmptyNoticeOf('absent'))
    // 它点名缺失的能力及缺失之处，使用户不去找一个无济于事的权限。
    expect(unsupported).toContain('浏览器')
    expect(unsupported).toContain('不支持定位')
  })
})

describe('the state comes from what the location store already reports', () => {
  // 本块全程 `supported: true`：能力读取现在是必需输入，而这些用例都关于**能**定位的浏览器——
  // 有定位、请求在途、请求失败。省略它的调用会被当作不能定位的浏览器应答。
  it('reads a fix in hand as the fix state, whatever else is in flight', () => {
    // `isLocating` 即 `tracking && 无定位`，两者由构造一致——在此钉住，因为卡片的措辞随这一个值翻转。
    expect(nearbyLocationStateOf({ hasFix: true, requesting: true, failed: false, supported: true }))
      .toBe('fix')
    expect(nearbyLocationStateOf({ hasFix: true, requesting: false, failed: true, supported: true }))
      .toBe('fix')
  })

  it('reads a request with no fix yet as locating', () => {
    expect(nearbyLocationStateOf({ hasFix: false, requesting: true, failed: false, supported: true }))
      .toBe('locating')
  })

  it('reads a failed or never-made request as absent rather than still coming', () => {
    // 被拒的请求在 store 里仍保持 `tracking` 为真，故只看请求标志会永远说「正在获取定位…」，
    // 而定位永不到来。
    expect(nearbyLocationStateOf({ hasFix: false, requesting: true, failed: true, supported: true }))
      .toBe('absent')
    expect(nearbyLocationStateOf({ hasFix: false, requesting: false, failed: false, supported: true }))
      .toBe('absent')
  })
})

describe('the card is handed the position fact and words none of it itself', () => {
  const card = readFileSync(
    fileURLToPath(new URL('../views/overview/components/line-mini-card.vue', import.meta.url)),
    'utf8',
  )
  const script = card.slice(0, card.indexOf('<template>'))

  it('takes the state as a prop and words the notice from it', () => {
    expect(card, 'the card does not receive the position state').toContain('nearbyLocation')
    expect(script, 'the card does not word the notice through the module')
      .toContain('nearbyEmptyNoticeOf(')
  })

  it('words no location cause in its own template', () => {
    // 「开启定位」现在属于 copy 模块：状态在那里变成措辞。
    expect(card.slice(card.indexOf('<template>')), 'the card template states a location cause itself')
      .not.toContain('开启定位')
    // 对「浏览器缺少 geolocation」的成因同理：卡片渲染模块的句子，不自带一句。
    expect(card.slice(card.indexOf('<template>')), 'the card template words the unsupported case itself')
      .not.toContain('不支持定位')
  })
})

describe('the overview reads the position fact from the location store', () => {
  const overview = readFileSync(
    fileURLToPath(new URL('../views/overview/index.vue', import.meta.url)),
    'utf8',
  )
  const grid = readFileSync(
    fileURLToPath(new URL('../views/overview/components/card-grid.vue', import.meta.url)),
    'utf8',
  )

  it('derives it from the store\'s own reads', () => {
    // 复用 store 的区分而非另造：有定位、请求在途、请求失败。
    expect(overview).toContain('locationStore.userCoords')
    expect(overview).toContain('locationStore.isLocating')
    expect(overview).toContain('locationStore.locationError')
    expect(overview).toContain('nearbyLocationStateOf(')
  })

  it('takes the capability reading from the store too, not from a guess', () => {
    // 浏览器能否定位是 **store** 持有的事实（`geo.isSupported`）；视图若从失败推断它，
    // 会把被拒的权限说成「不支持」并把用户送去换浏览器。
    expect(overview).toContain('locationStore.isSupported')
    expect(overview).toContain('supported:')
  })

  it('passes it to the grid, which passes it to every card', () => {
    expect(overview, 'the overview does not pass the position state').toContain(':nearby-location=')
    expect(grid, 'the card grid drops the position state on its way to the card')
      .toContain(':nearby-location="nearbyLocation"')
  })
})
