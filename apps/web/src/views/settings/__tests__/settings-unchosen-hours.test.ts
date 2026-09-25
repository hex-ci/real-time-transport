import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_COMMUTE_HOURS } from '@real-time-transport/shared'
import {
  RouterLinkStub,
  mountComponent,
  type HostElement,
  type MountedHost,
  type Route,
} from './settings-harness'
import { hoursText, settingsReadOf } from '../index-summary'
import SchedulePage from '../schedule.vue'
import CommuteHoursForm from '../components/commute-hours-form.vue'

/**
 * T2 的读/报一面：「行在、但四个通勤时刻从没选过」。
 *
 * 服务端把这件事说成 `settingsState: 'stored'` + 四个 null（009 之后 NULL 就是「从未选择」），
 * 而 NULL 不许在任何地方被当成一个值印出来。`settingsReadOf` 是这条规则唯一的落点：设置
 * 索引行、通勤时段页、时段编辑器都从它读，所以这三种状态 —— `unset`（没有这一行）、
 * `unchosen`（行在、时刻没选过）、`unreadable`（读失败/答得自相矛盾）—— 在这里一次分清楚，
 * 各处就不再有机会各自解释。
 *
 * 编辑器是另一个面：它必须给得出四个可编辑的起始值，而那四个**是编辑器的起点**，不是
 * 存过的时段 —— 屏幕上写着「尚未保存过通勤时段…」（这句话对 unset 与 unchosen 都成立：
 * 使用者确实没有保存过通勤时段）。
 */

const START = DEFAULT_COMMUTE_HOURS

/** The wire answer of a row whose four times were never chosen. */
function unchosenRow(anchors: Record<string, unknown> = { homeLat: 39.9, homeLng: 116.4 }): unknown {
  return {
    success: true,
    settingsState: 'stored',
    data: {
      morningStart: null,
      morningEnd: null,
      eveningStart: null,
      eveningEnd: null,
      ...anchors,
    },
  }
}

/** A row that carries its four chosen times. */
function storedRow(): unknown {
  return {
    success: true,
    settingsState: 'stored',
    data: { ...START, homeLat: 39.9, homeLng: 116.4 },
  }
}

function routes(settings: () => unknown): Route[] {
  return [
    [/\/api\/transit\/settings/, settings],
    [/\/api\/transit\/commute-chains\?/, () => ({ success: true, data: [] })],
    [/\/api\/transit\/favorites$/, () => ({ success: true, data: [] })],
  ]
}

async function mount(component: Parameters<typeof mountComponent>[0], settings: () => unknown): Promise<MountedHost> {
  const host = await mountComponent(component, {
    routes: routes(settings),
    components: { RouterLink: RouterLinkStub },
  })
  await host.flush()
  return host
}

/** The 通勤时段 card's collapsed trigger, whose text is the summary the user reads. */
function collapsedHoursTrigger(host: MountedHost): HostElement {
  return host.node(
    item => item.tag === 'button' && host.textOf(item).includes('通勤时段'),
    'the collapsed 通勤时段 trigger',
  )
}

/** The four `type="time"` inputs of the hours editor, in the order the form renders them. */
function timeInputs(host: MountedHost): HostElement[] {
  return host.nodes(item => item.tag === 'input' && item.props.type === 'time')
}

afterEach(async () => {
  await new Promise(resolve => setTimeout(resolve, 0))
  vi.unstubAllGlobals()
})

describe('settingsReadOf：四个 null 是「没选过」，不是读不到，也不是一个值', () => {
  it('行在、四个时刻都是 null → 时段这一域是 unchosen', () => {
    const read = settingsReadOf(unchosenRow())

    expect(read.hours.state, 'a row with no chosen hour was read as a stored schedule').toBe('unchosen')
    // 同一行的锚点照旧按它自己的列读，不被时段的状态牵走。
    expect(read.anchors.state).toBe('read')
    expect(read.anchors.state === 'read' ? read.anchors.value.homeLat : null).toBe(39.9)
  })

  it('unchosen 的措辞是「未设置」，绝不是那四个内置时刻', () => {
    const text = hoursText(settingsReadOf(unchosenRow()).hours)

    expect(text).toBe('未设置')
    for (const invented of ['06:30', '11:30', '17:00', '22:00']) {
      expect(text.includes(invented), `the summary printed the built-in ${invented}`).toBe(false)
    }
  })

  it('没有这一行仍然是 unset，两者不合并', () => {
    const read = settingsReadOf({ success: true, settingsState: 'unset', data: null })
    expect(read.hours.state).toBe('unset')
    expect(hoursText(read.hours)).toBe('未设置')
  })

  it('答得自相矛盾（只有一半时刻）仍然是读不到，不被读成「未设置」', () => {
    // 半写的行不该存在（写侧的两端同生同灭拒绝它），真出现时也不许被解释成任何一种事实：
    // 「未设置」会声称没人选过，而库里有一个值。
    const read = settingsReadOf({
      success: true,
      settingsState: 'stored',
      data: { morningStart: '07:15', morningEnd: null, eveningStart: null, eveningEnd: null },
    })

    expect(read.hours.state, 'half a window was read as a fact').toBe('unreadable')
    expect(hoursText(read.hours)).toBe('未读到')
  })
})

describe('通勤时段页：行在、时刻没选过，折叠摘要说「未设置」', () => {
  it('摘要说「未设置」，不说内置时段，也不说「未读到」', async () => {
    const host = await mount(SchedulePage, unchosenRow)

    const summary = host.textOf(collapsedHoursTrigger(host))
    expect(summary).toContain('未设置')
    expect(summary, 'the built-in window is printed for a user who never chose one').not.toContain('06:30')
    expect(summary).not.toContain('17:00')
    expect(summary).not.toContain('未读到')
    host.unmount()
  })

  it('正对照：存过的时刻照旧逐字印出来', async () => {
    const host = await mount(SchedulePage, storedRow)

    expect(host.textOf(collapsedHoursTrigger(host))).toContain('06:30–11:30 · 17:00–22:00')
    host.unmount()
  })
})

describe('时段编辑器：起始值处处可见地是「起点」', () => {
  it('行在、时刻没选过：屏幕上写着尚未保存过通勤时段，四个输入仍是起点', async () => {
    const host = await mount(CommuteHoursForm, unchosenRow)

    const text = host.text()
    expect(text, 'the editor opened on built-in numbers without saying where they come from')
      .toContain('尚未保存过通勤时段')
    expect(text).toContain('起点')

    // 起点就是那四个内置时刻 —— 它们能出现在输入框里，正是因为上面那句话说明了它们是什么。
    const inputs = timeInputs(host)
    expect(inputs.map(input => String(input.props.value))).toEqual([
      START.morningStart,
      START.morningEnd,
      START.eveningStart,
      START.eveningEnd,
    ])
    host.unmount()
  })

  it('没有这一行时，编辑器说的是同一句话', async () => {
    const host = await mount(CommuteHoursForm, () => ({ success: true, settingsState: 'unset', data: null }))

    expect(host.text()).toContain('尚未保存过通勤时段')
    host.unmount()
  })

  it('正对照：存过的时刻进输入框，那句话消失', async () => {
    const host = await mount(CommuteHoursForm, storedRow)

    expect(host.text()).not.toContain('尚未保存过通勤时段')
    expect(timeInputs(host).map(input => String(input.props.value))).toEqual([
      START.morningStart,
      START.morningEnd,
      START.eveningStart,
      START.eveningEnd,
    ])
    host.unmount()
  })
})
