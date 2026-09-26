import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CommuteChainPurpose } from '@real-time-transport/shared'
import { chainView, conclusion, leg } from './chain-fixtures'
import {
  mountChainPage,
  pickPurpose,
  purposeRadios,
  type MountedChainPage,
  type Route,
} from './chain-page-harness'

/**
 * 本页首次进入时选中哪个目的，由**行为**守住。
 *
 * 傍晚打开本页时默认勾选哪个页签，是一个用户看得见的事实，故此处断言的是页面自己陈述的东西：
 * 选中的那个单选、它向端点索要的目的、以及屏幕上真出现的那条链路。
 *
 * 三条边界与一条不变量：
 *   1. 时段覆盖此刻 → 按它选定（早上上班、傍晚下班）；
 *   2. 此刻落在两个时段之外 → 停留默认（上班），就像今天做的；
 *   3. 没有时段可跟随（没有存储行 / 四个时刻从未选过 / profile 读不到）→ 同样停留默认，不猜一个时段；
 *   4. 手动点过页签之后，任何 profile 重读都不得把它切回去 —— 使用者的选择胜过时段。
 *
 * 目的与「通勤目的」端点一次只服务一个：故「默认选中哪个」不能只看页签，还得看页面问了什么、
 * 屏幕上是谁的链路。
 */

/** 傍晚 / 早上 / 时段之外：三个已存时段的回答。 */
const STORED_EVENING = {
  success: true,
  data: { mode: 'home', description: '晚通勤时段', windowState: 'stored' },
}
const STORED_MORNING = {
  success: true,
  data: { mode: 'work', description: '早通勤时段', windowState: 'stored' },
}
const STORED_OUTSIDE = {
  success: true,
  data: { mode: 'auto', description: '非通勤时段', windowState: 'stored' },
}

/** 没有时段可跟随的两种事实，以及「没人读过」这第三种。 */
const NO_WINDOW_UNSET = {
  success: true,
  data: { mode: 'auto', description: '未设置通勤时段', windowState: 'unset' },
}
const NO_WINDOW_UNCHOSEN = {
  success: true,
  data: { mode: 'auto', description: '未设置通勤时段', windowState: 'unchosen' },
}

/** 每个目的的链路名不同，使「屏幕上是谁的答案」可读。 */
const CHAIN_NAME: Record<string, string> = { morning: '上班的链路', evening: '下班的链路' }

/** 端点按被问的目的作答，答案带着该目的自己的链路。 */
const DEDUCTIONS: Route = [
  /commute-chains\/deductions/,
  (request) => {
    const purpose = (/purpose=(\w+)/.exec(request.url)?.[1] ?? 'morning') as CommuteChainPurpose
    return {
      success: true,
      data: {
        purpose,
        chains: [chainView(conclusion([leg({ seq: 0 })]), {
          purpose,
          name: CHAIN_NAME[purpose] ?? purpose,
        })],
      },
    }
  },
]

/** 页面勾选的那个目的，按单选组自己的陈述。 */
function chosenPurpose(page: MountedChainPage): string {
  const checked = purposeRadios(page).filter(radio => radio.props['aria-checked'] === true)
  expect(checked, 'the page checked no purpose at all').toHaveLength(1)
  return String(checked[0]!.props.value)
}

/** 页面每次向端点索要的目的，按顺序。 */
function askedPurposes(page: MountedChainPage): string[] {
  return page.server
    .seen(/commute-chains\/deductions/)
    .map(request => /purpose=(\w+)/.exec(request.url)?.[1] ?? '')
}

async function mountWithProfile(profile: unknown | (() => never)): Promise<MountedChainPage> {
  return mountChainPage({
    routes: [
      DEDUCTIONS,
      [/commute-profile/, () => (typeof profile === 'function' ? profile() : profile)],
    ],
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('首次进入时按当前通勤时段选定', () => {
  it('傍晚（晚通勤时段）：默认下班，屏幕上也是下班那条链路', async () => {
    const page = await mountWithProfile(STORED_EVENING)

    expect(chosenPurpose(page)).toBe('evening')
    expect(askedPurposes(page).at(-1)).toBe('evening')
    expect(page.text()).toContain(CHAIN_NAME.evening!)
    // 一个目的一个答案：早上那条不得留在屏幕上。
    expect(page.text()).not.toContain(CHAIN_NAME.morning!)
    page.unmount()
  })

  it('早上（早通勤时段）：默认上班', async () => {
    const page = await mountWithProfile(STORED_MORNING)

    expect(chosenPurpose(page)).toBe('morning')
    expect(page.text()).toContain(CHAIN_NAME.morning!)
    page.unmount()
  })
})

describe('没有目的可跟随就停留默认（上班），不猜一个时段', () => {
  it('此刻落在两个时段之外：停留上班', async () => {
    const page = await mountWithProfile(STORED_OUTSIDE)

    expect(chosenPurpose(page)).toBe('morning')
    // 「不猜」= 从不曾问过另一个目的：首屏若按一个编造的时段选了，这里会多出一次读取。
    expect(askedPurposes(page)).toEqual(['morning'])
    page.unmount()
  })

  it('没有存储行、或四个时刻从未选过：同样停留上班', async () => {
    for (const profile of [NO_WINDOW_UNSET, NO_WINDOW_UNCHOSEN]) {
      const page = await mountWithProfile(profile)

      expect(chosenPurpose(page), JSON.stringify(profile)).toBe('morning')
      expect(askedPurposes(page), JSON.stringify(profile)).toEqual(['morning'])
      page.unmount()
    }
  })

  it('profile 读不到（应答失败或连接断了）：同样停留上班', async () => {
    const failing: Array<[string, unknown | (() => never)]> = [
      ['应答失败', { success: false, error: '读取失败' }],
      ['连接断了', () => { throw new Error('the connection is down') }],
    ]

    for (const [name, profile] of failing) {
      const page = await mountWithProfile(profile)

      expect(chosenPurpose(page), name).toBe('morning')
      expect(askedPurposes(page), name).toEqual(['morning'])
      page.unmount()
    }
  })
})

describe('使用者点过的页签不被 profile 重读覆盖', () => {
  it('手动选过之后，之后每一次 profile 读取都不得切回去', async () => {
    // 第一次读是傍晚（首屏默认下班），其后每次读都说早上：若页面无条件跟随时段，
    // 手动选出的上班会在重读时被翻回，反方向同理。
    const answers = [STORED_EVENING, STORED_MORNING]
    let reads = 0
    const page = await mountChainPage({
      routes: [
        DEDUCTIONS,
        [/commute-profile/, () => answers[Math.min(reads++, answers.length - 1)]],
      ],
    })

    expect(chosenPurpose(page)).toBe('evening')

    // 使用者手动改成上班 —— 一次刻意做出的选择。
    await pickPurpose(page, 'morning')
    expect(chosenPurpose(page)).toBe('morning')

    // 又一次读到 profile（另一个页面把 store 的那次读取重做）。
    await page.store.fetchCommuteProfile()
    await page.flush()

    expect(chosenPurpose(page), 'a profile re-read overwrote the manual choice').toBe('morning')
    expect(askedPurposes(page).at(-1)).toBe('morning')
    expect(page.text()).toContain(CHAIN_NAME.morning!)

    // 反方向：选了下班之后，说早上的那次重读同样不得覆盖它。
    await pickPurpose(page, 'evening')
    await page.store.fetchCommuteProfile()
    await page.flush()

    expect(chosenPurpose(page), 'a profile re-read overwrote the manual choice').toBe('evening')
    expect(askedPurposes(page).at(-1)).toBe('evening')
    expect(page.text()).toContain(CHAIN_NAME.evening!)
    page.unmount()
  })
})
