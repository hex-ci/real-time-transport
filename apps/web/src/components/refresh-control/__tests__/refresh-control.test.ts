import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { mountComponent, press, type MountedHost } from '../../../views/settings/__tests__/settings-harness'
import RefreshControl from '../main.vue'

/**
 * F11 的刷新控件，如三个页面共用时那样。
 *
 * 它只渲染、只发出一次 `refresh`：措辞（读数那一行）由页面从 store 取来交给它，故本组件里没有一个
 * 状态的词 —— 一次按下的结局由全局提示承载，这里连一条 live region 都不该有（两处都播就是两遍）。
 * 它必须做到的三件事：控件自身说得出自己在做什么（在途、被禁用、可访问名）、按钮描述的那一行确实
 * 在本实例里、以及同一个屏幕上出现第二个入口时两个实例的 id 不互相遮挡。
 *
 * 本仓库没有 DOM 测试台，故经 `设置` 页那台无 DOM 宿主挂载（见 settings-harness.ts）。
 */

const FRESHNESS = '最后更新 14:03:21 · 实时'

/**
 * 一个由测试驱动的宿主：接线这个控件的页面每一拍都在改这一行，故控件必须跟着走而不是停在第一次渲染。
 */
let drive: ((next: string) => void) | null = null

const Live = defineComponent({
  setup() {
    const freshness = ref(FRESHNESS)
    drive = (next) => {
      freshness.value = next
    }
    return () => h(RefreshControl, {
      refreshing: false,
      freshness: freshness.value,
      label: '刷新最新车况',
    })
  },
})

/** 挂载一次，页面该给的东西都给上，测试只覆盖它关心的那个。 */
async function mountControl(props: Record<string, unknown> = {}): Promise<MountedHost> {
  const host = await mountComponent(RefreshControl, {
    props: { refreshing: false, freshness: FRESHNESS, label: '刷新最新车况', ...props },
  })
  await host.flush()
  return host
}

function regionOf(host: MountedHost) {
  return host.node(node => node.props['aria-label'] === '数据刷新', 'refresh region')
}

function buttonOf(host: MountedHost) {
  return host.node(node => node.tag === 'button', 'refresh button')
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('一屏一次刷新：控件说得清自己在做什么', () => {
  it('渲染交给它的那一行读数', async () => {
    const host = await mountControl()
    expect(host.text()).toContain(FRESHNESS)
    host.unmount()
  })

  it('图标按钮是 44×44 的触摸目标，带着页面给它的可访问名', async () => {
    const host = await mountControl()
    const button = buttonOf(host)
    const classes = String(button.props.class)

    expect(classes).toContain('h-11')
    expect(classes).toContain('w-11')
    // 图标按钮没有可见文字，故名字只能来自页面 —— 本组件不产出词。
    expect(button.props['aria-label']).toBe('刷新最新车况')
    expect(button.props['aria-describedby']).toBe('refresh-freshness')
    host.unmount()
  })

  it('按钮描述的正是本实例渲染的那一行读数', async () => {
    const host = await mountControl()
    const described = host.nodes(node => node.props.id === 'refresh-freshness')
    expect(described).toHaveLength(1)
    expect(host.textOf(described[0]!)).toBe(FRESHNESS)
    host.unmount()
  })

  it('页面上没有读数那一半时不描述任何一处虚空', async () => {
    // 两页的工具栏撤掉了读数那一半，而那一半此前是这枚按钮唯一描述的东西。
    const host = await mountControl({ hasReading: false })
    expect(buttonOf(host).props['aria-describedby']).toBeUndefined()
    // 撤的是描述，不是控件：名字与 44 那一档都还在。
    expect(buttonOf(host).props['aria-label']).toBe('刷新最新车况')
    expect(String(buttonOf(host).props.class)).toContain('h-11')
    host.unmount()

    // 而页面别处仍渲染读数时（默认）它照样描述那一行。
    const withReading = await mountControl()
    expect(buttonOf(withReading).props['aria-describedby']).toBe('refresh-freshness')
    withReading.unmount()
  })

  it('在途时对辅助技术也标出忙碌，并且按不下第二次', async () => {
    const idle = await mountControl()
    expect(buttonOf(idle).props['aria-busy']).toBe(false)
    expect(buttonOf(idle).props.disabled).toBe(false)
    idle.unmount()

    const busy = await mountControl({ refreshing: true })
    expect(buttonOf(busy).props['aria-busy']).toBe(true)
    expect(buttonOf(busy).props.disabled).toBe(true)
    busy.unmount()
  })

  it('页面说自己没有可重读的东西时也禁用，且这不是「在途」', async () => {
    const host = await mountControl({ disabled: true })
    expect(buttonOf(host).props.disabled).toBe(true)
    // 两个原因不同：一个是在花窗口，一个是无事可做，故忙碌标记不跟着禁用位走。
    expect(buttonOf(host).props['aria-busy']).toBe(false)
    host.unmount()
  })

  it('按下只发出一次 refresh，由页面决定它意味着什么', async () => {
    let presses = 0
    const host = await mountControl({
      onRefresh: () => {
        presses += 1
      },
    })
    await press(host, buttonOf(host))
    expect(presses).toBe(1)
    host.unmount()
  })

  it('跟着页面交给它的字走，而不是停在第一次渲染', async () => {
    const host = await mountComponent(Live, {})
    await host.flush()
    expect(host.text()).toContain(FRESHNESS)

    drive!('最后更新 14:03:39 · 实时')
    await host.flush()

    expect(host.text()).toContain('14:03:39')
    expect(host.text(), 'the control kept its first render').not.toContain('14:03:21')
    host.unmount()
  })

  it('控件自己不说一个结局，也不带第二条播报源', async () => {
    // 结局由全局提示承载；这里再有一条 live region 会把同一个结局播两遍。
    const host = await mountControl()
    expect(host.nodes(node => node.props.role === 'status')).toHaveLength(0)
    expect(host.nodes(node => node.props['aria-live'] !== undefined)).toHaveLength(0)
    expect(host.nodes(node => node.props.id === 'refresh-status')).toHaveLength(0)
    host.unmount()
  })
})

describe('同一个屏幕上两个入口不互相遮挡', () => {
  it('带前缀的实例把那一行读数与按钮的描述一起挪到前缀下', async () => {
    const host = await mountControl({ idPrefix: 'desktop-' })

    // 移动端抽屉里那个仍持有不带前缀的 id，桌面那个各有各的。
    expect(host.nodes(node => node.props.id === 'desktop-refresh-freshness')).toHaveLength(1)
    expect(host.nodes(node => node.props.id === 'refresh-freshness')).toHaveLength(0)
    expect(buttonOf(host).props['aria-describedby']).toBe('desktop-refresh-freshness')
    host.unmount()
  })

  it('不带前缀时 id 就是页面既有契约里的那一个', async () => {
    const host = await mountControl()
    expect(host.nodes(node => node.props.id === 'refresh-freshness')).toHaveLength(1)
    host.unmount()
  })

  it('区域名在本组件里只有一个，落点在哪一页都读作同一块区域', async () => {
    const host = await mountControl()
    expect(regionOf(host).props['aria-label']).toBe('数据刷新')
    host.unmount()
  })
})
