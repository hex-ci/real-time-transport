import { describe, expect, it } from 'vitest'
import {
  mountComponent,
  press,
  type,
  type HostElement,
  type MountedHost,
} from '@/__tests__/views/settings/settings-harness'
import SearchableCombobox from '../../../components/searchable-combobox/main.vue'
import type { ComboboxOption } from '../../../components/searchable-combobox/types'

/**
 * 共用的带搜索的下拉。
 *
 * 本文件钉的是本组件自己的契约——两段文字、值是一个不透明的 key、过滤、键盘、可访问名的来处，
 * 以及值先写、选项后报这一次序（调用方的重读处理器读的是它自己持有的那个值，故那次重读必须问的
 * 是刚选中的这一个）。置于两屏各自用法之内的部分（站台屏的重读、设置页的站序搜索）在它们的屏幕
 * 上被钉。
 *
 * 本应用没有 DOM 测试台，故经设置页那一套宿主驱动（本仓只有这一套，第二套会漂移）：
 * 点、输入、按键都按浏览器投递事件的方式送给渲染出的节点。
 */

/** 一段站表：两个站共用同一个主文本，站序是分开它们的唯一东西。 */
const OPTIONS: ComboboxOption[] = [
  { key: '1_东大桥', primary: '东大桥', secondary: '第1站' },
  { key: '3_团结湖', primary: '团结湖', secondary: '第3站' },
  { key: '4_东大桥', primary: '东大桥', secondary: '第4站' },
]

/**
 * 一次按键，按浏览器投递 keydown 的方式：每个处理器都跑（Vue 把同一事件上的多个处理器存成一个数组），
 * 并记下这次按键被本组件怎么处置 —— 是改了默认行为，还是挡住了冒泡。
 */
function keydown(element: HostElement, key: string): { prevented: boolean, stopped: boolean } {
  let prevented = false
  let stopped = false
  const handler = element.props.onKeydown
  const handlers = Array.isArray(handler) ? handler : [handler]
  const event = {
    type: 'keydown',
    key,
    target: element,
    currentTarget: element,
    preventDefault: () => { prevented = true },
    get defaultPrevented() { return prevented },
    stopPropagation: () => { stopped = true },
  }
  for (const each of handlers) each?.(event)
  return { prevented, stopped }
}

function triggerOf(host: MountedHost): HostElement {
  return host.node(
    (item: HostElement) => item.tag === 'button'
      && (item.props.role === 'combobox' || item.props['aria-expanded'] !== undefined),
    '控件触发器',
  )
}

/** 面板顶上那个搜索框；面板没开时它不在屏上。 */
function searchBoxOf(host: MountedHost): HostElement | null {
  return host.nodes((item: HostElement) => item.tag === 'input' && item.props.role === 'combobox')[0] ?? null
}

function optionsOf(host: MountedHost): HostElement[] {
  return host.nodes((item: HostElement) => item.props.role === 'option')
}

function textsOf(host: MountedHost): string[] {
  return optionsOf(host).map(item => host.textOf(item))
}

/** 印着这一段文字的那个选项。 */
function optionOf(host: MountedHost, text: string): HostElement {
  return host.node(
    (item: HostElement) => item.props.role === 'option' && host.textOf(item) === text,
    `选项「${text}」`,
  )
}

/**
 * 高亮的出处：reka 用 `data-highlighted` 属性标出当前高亮项，样式由类里 `data-[highlighted]:`
 * 那一档给。组件自己算高亮（`activeIndex` + 一个字面量类）是上一版的写法 —— 留着它会让
 * 「谁在控制高亮」有两个答案。
 */
function highlightTokensOf(host: MountedHost): string[][] {
  return optionsOf(host).map(item => String(item.props.class ?? '').split(/\s+/))
}

/** 本组件自己算高亮时会写出的那个类名（整串 token，不带 `data-[…]:` 前缀）。 */
const OWN_HIGHLIGHT_TOKEN = 'bg-cyan-500/15'

/** 某个节点自己或它子树里是否有元素带着这个类。 */
function carriesClass(node: HostElement, token: string): boolean {
  if (String(node.props.class ?? '').split(/\s+/).includes(token)) return true
  return node.children.some(child => carriesClass(child, token))
}

interface Recorded {
  written: string[]
  selected: string[]
  order: string[]
}

async function mountControl(
  over: Record<string, unknown> = {},
): Promise<{ host: MountedHost, recorded: Recorded }> {
  const recorded: Recorded = { written: [], selected: [], order: [] }
  const host = await mountComponent(SearchableCombobox, {
    props: {
      'ariaLabel': '选择站点',
      'options': OPTIONS,
      'modelValue': '3_团结湖',
      'selected': { primary: '团结湖', secondary: '第3站' },
      'onUpdate:modelValue': (key: string) => {
        recorded.written.push(key)
        recorded.order.push('value')
      },
      'onSelect': (option: ComboboxOption) => {
        recorded.selected.push(option.key)
        recorded.order.push('select')
      },
      ...over,
    },
  })
  return { host, recorded }
}

describe('两段文字与值', () => {
  it('每个选项印主文本与次要细节，值持有的那一个带勾', async () => {
    const { host } = await mountControl()
    await press(host, triggerOf(host))

    expect(textsOf(host)).toEqual(['东大桥 第1站', '团结湖 第3站', '东大桥 第4站'])
    // 勾落在**值所持有的那一对**上：两个「东大桥」里，第 4 站那个不是被选中的。
    const checked = optionsOf(host).filter(item => item.props['data-state'] === 'checked')
    expect(checked.map(item => host.textOf(item))).toEqual(['团结湖 第3站'])
    host.unmount()
  })

  it('主文本相同的两个选项各报自己的 key：值不是主文本', async () => {
    const { host, recorded } = await mountControl()
    await press(host, triggerOf(host))

    await press(host, optionOf(host, '东大桥 第4站'))

    expect(recorded.written).toEqual(['4_东大桥'])
    expect(recorded.selected).toEqual(['4_东大桥'])
    host.unmount()
  })

  it('值先写、选项后报：调用方在它自己的处理器里读到的已是刚选中的这一个', async () => {
    const { host, recorded } = await mountControl()
    await press(host, triggerOf(host))

    await press(host, optionOf(host, '东大桥 第1站'))

    expect(recorded.order).toEqual(['value', 'select'])
    host.unmount()
  })

  it('值不在列表里时触发器照原样显示它并带上告警色，且列表里没有任何一项被打勾', async () => {
    const { host } = await mountControl({
      modelValue: '9_东大桥',
      selected: { primary: '东大桥', secondary: '第9站' },
      warning: true,
    })

    expect(host.textOf(triggerOf(host))).toBe('东大桥 第9站')
    expect(carriesClass(triggerOf(host), 'text-amber-400')).toBe(true)
    await press(host, triggerOf(host))
    expect(optionsOf(host).filter(item => item.props['data-state'] === 'checked')).toEqual([])
    host.unmount()
  })
})

describe('搜索框会缩列表', () => {
  it('输一半站名就只剩匹配的那些；两段文字都算匹配', async () => {
    const { host } = await mountControl()
    await press(host, triggerOf(host))
    expect(textsOf(host)).toHaveLength(3)

    const search = searchBoxOf(host)
    expect(search, '面板顶上没有搜索框').not.toBeNull()
    await type(host, search!, '大桥')

    expect(textsOf(host)).toEqual(['东大桥 第1站', '东大桥 第4站'])
    host.unmount()
  })

  it('一个都不匹配时说出空态，而不是留一张空列表', async () => {
    const { host } = await mountControl({ emptyText: '未找到匹配站点' })
    await press(host, triggerOf(host))
    await type(host, searchBoxOf(host)!, '不存在的站')

    expect(optionsOf(host)).toEqual([])
    expect(host.text()).toContain('未找到匹配站点')
    host.unmount()
  })

  it('调用方可以给一条自己的过滤规则', async () => {
    const { host } = await mountControl({
      // 只按站序（次要细节）的**整段相等**匹配：「第3站」认，「第」不认。
      matches: (option: ComboboxOption, text: string) => option.secondary === text,
    })
    await press(host, triggerOf(host))
    await type(host, searchBoxOf(host)!, '第3站')
    expect(textsOf(host)).toEqual(['团结湖 第3站'])

    await type(host, searchBoxOf(host)!, '第')
    expect(optionsOf(host)).toEqual([])
    host.unmount()
  })
})

/**
 * 键盘：按键由 reka 承担，本组件不抢。
 *
 * 2026-10 的改写把组件换成 reka-ui 的 Combobox：面板的打开是浏览器对触发器的**原生激活**
 * （Enter / Space），打开之后的上/下移动高亮、回车选中与 Escape 关闭都在面板（`role=listbox`）
 * 那一层由 reka 处理。
 *
 * 本仓的宿主只把事件交给被点/被按的那个节点**自己**的处理器，不冒泡、也不跑浏览器的默认动作，
 * 所以上面那些行为在这里量不到 —— 它们在 `tests/e2e/scenarios/platform.mjs` 的真浏览器键盘场景里钉。
 * 这一节钉的是组件自己那一半：不抢键、不把按键冒泡出去、高亮只有一个出处。
 */
describe('键盘：按键交给 reka，本组件不抢', () => {
  it('触发器上没有本组件的按键处理：打开面板走浏览器对按钮的原生激活', async () => {
    const { host } = await mountControl()
    expect(searchBoxOf(host), '没按任何键面板就开着').toBeNull()

    expect(triggerOf(host).props.onKeydown, '触发器又自己处理按键了').toBeUndefined()

    // 面板照旧开得了：这是键盘用户在真浏览器里按 Enter / Space 走的那条路。
    await press(host, triggerOf(host))
    expect(optionsOf(host)).toHaveLength(3)
    host.unmount()
  })

  it('搜索框上的三个导航键原样放行：既不改默认行为，也不挡住冒泡', async () => {
    const { host } = await mountControl()
    await press(host, triggerOf(host))

    for (const key of ['ArrowDown', 'ArrowUp', 'Escape']) {
      const handled = keydown(searchBoxOf(host)!, key)
      expect(handled.prevented, `${key} 被本组件改了默认行为`).toBe(false)
      expect(handled.stopped, `${key} 在本组件里被挡住冒泡`).toBe(false)
    }
    host.unmount()
  })

  it('其余键只挡冒泡：输入照旧，按键不漏到页面上的其它监听器', async () => {
    const { host } = await mountControl()
    await press(host, triggerOf(host))

    // Enter 也在这条规则里：实测真浏览器里搜索框回车仍能选中 —— reka 的选中路径不经过被挡住的那一段。
    for (const key of ['Enter', 'a', 'Backspace']) {
      const handled = keydown(searchBoxOf(host)!, key)
      expect(handled.prevented, `${key} 被本组件改了默认行为`).toBe(false)
      expect(handled.stopped, `${key} 的按键漏到了页面上`).toBe(true)
    }
    host.unmount()
  })

  it('高亮由 reka 的 `data-highlighted` 表达，组件里没有第二套高亮', async () => {
    const { host } = await mountControl()
    await press(host, triggerOf(host))

    const tokens = highlightTokensOf(host)
    expect(tokens).toHaveLength(3)
    for (const each of tokens) {
      expect(each.some(token => token.startsWith('data-[highlighted]:')), '选项上没有 reka 的高亮档').toBe(true)
      expect(each, '选项上又出现了本组件自己算的高亮类').not.toContain(OWN_HIGHLIGHT_TOKEN)
    }
    host.unmount()
  })
})

describe('不带搜索框的那种：`searchable: false`', () => {
  it('面板打开即列出全部选项，顶上没有搜索框——过滤与它的空态在这里都无从生效', async () => {
    const { host } = await mountControl({
      searchable: false,
      // 两者都无从生效：没有输入框，就没有「缩过的结果」，也没有「一个都没匹配上」。
      // 给一个与全部选项都不匹配的谓词，列出全量才是本用例要钉的东西。
      matches: () => false,
    })
    await press(host, triggerOf(host))

    expect(searchBoxOf(host), '不带搜索框的那种仍渲染了搜索框').toBeNull()
    expect(textsOf(host)).toEqual(['东大桥 第1站', '团结湖 第3站', '东大桥 第4站'])
    expect(host.text(), '无搜索时仍印着「未找到匹配项」').not.toContain('未找到匹配项')
    host.unmount()
  })

  it('键盘交给 reka：触发器上没有本组件的按键处理，高亮只有一个出处', async () => {
    const { host } = await mountControl({ searchable: false })

    expect(triggerOf(host).props.onKeydown, '触发器又自己处理按键了').toBeUndefined()
    await press(host, triggerOf(host))
    expect(textsOf(host)).toHaveLength(3)
    // 没有搜索框，就没有「搜索框上放行哪几个键」这件事；高亮同样只由 reka 表达。
    expect(searchBoxOf(host)).toBeNull()
    for (const each of highlightTokensOf(host)) {
      expect(each.some(token => token.startsWith('data-[highlighted]:'))).toBe(true)
      expect(each).not.toContain(OWN_HIGHLIGHT_TOKEN)
    }
    host.unmount()
  })
})

describe('不传 `searchable` 时就是带搜索框的那种（三处老调用一个字都没改）', () => {
  it('搜索框在，敲字就缩列表', async () => {
    const { host } = await mountControl()
    await press(host, triggerOf(host))

    const search = searchBoxOf(host)
    expect(search, '默认可访问的搜索框没了——三处老调用因此坏掉').not.toBeNull()
    await type(host, search!, '东大桥')
    expect(textsOf(host)).toEqual(['东大桥 第1站', '东大桥 第4站'])
    host.unmount()
  })
})

describe('可访问名由调用方给', () => {
  it('调用方给的词就是触发器的可访问名，且它不随值变', async () => {
    const { host } = await mountControl({ label: '上车站' })
    expect(triggerOf(host).props['aria-label']).toBe('上车站')

    await press(host, triggerOf(host))
    await press(host, optionOf(host, '东大桥 第1站'))
    expect(triggerOf(host).props['aria-label']).toBe('上车站')

    const { host: other } = await mountControl({ label: '下车站' })
    expect(triggerOf(other).props['aria-label']).toBe('下车站')
    host.unmount()
    other.unmount()
  })

  it('什么都没选时触发器的可见文字就是 `placeholder`', async () => {
    const { host } = await mountControl({ modelValue: null, selected: null, placeholder: '选择站台' })
    expect(host.textOf(triggerOf(host))).toBe('选择站台')
    host.unmount()
  })
})
