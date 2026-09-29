import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  mountComponent,
  press,
  type HostElement,
  type MountedHost,
  type Route,
} from '@/views/settings/__tests__/settings-harness'
import PlatformPage from '../index.vue'

/**
 * 站台屏在 §4.1 规则中的那一份：**失败**的关注线路读取不是空的关注线路列表。
 *
 * 站台屏是两者最相像之处。它的站点选项来自关注线路，故失败的读取让它没有站点可显示——而它曾宣布
 * 「该站台暂无已关注线路途经，请在「设置」中关注经过此站的线路」，这是对用户关注了什么的断言，
 * 并把用户送去重新关注他们已关注的线路。真相是「没读到」，唯一能改变它的动作是再读一次。
 *
 * 挂载的是**页面**而非仅报告板，因为页面向下传递哪个状态是断言的一半。本仓库只有一个无 DOM 挂载
 * 装置（`设置` 的），第二份副本会与之漂移。站点头部被换成惰性桩件，因为它驱动原生 `<select>`，
 * 而 runtime-dom 的 `v-model` 通过 `options.length` 写入——本装置刻意不建模的 DOM API。此处无关头部。
 */

vi.mock('../components/platform-header.vue', () => ({
  default: {
    name: 'PlatformHeaderStub',
    props: ['modelValue', 'stationOptions', 'landmarkHint', 'detecting'],
    emits: ['update:modelValue', 'detect', 'change'],
    render: () => null,
  },
}))

/** 当前城市的一条关注线路。 */
function favourite(): Record<string, unknown> {
  return {
    id: 'fav-1',
    userId: 'default_user',
    cityCode: '027',
    lineId: 'bus_027_1',
    lineName: '快线 1 路',
    preferredDirection: 0,
    displayOrder: 0,
  }
}

/** 关注线路读取所答，放在盒子里以便测试中途修好它。 */
interface FavouritesAnswer { value: 'ok' | 'empty' | 'fail' }

/**
 * 页面在挂载时发出的读取。`/lines/` 刻意什么都不答：本文件关乎不可读的关注线路列表产生的措辞，
 * 而非发车。
 */
function routes(answer: FavouritesAnswer): Route[] {
  return [
    [/\/api\/transit\/favorites$/, () => (answer.value === 'fail'
      ? { success: false, error: '读取失败' }
      : { success: true, data: answer.value === 'empty' ? [] : [favourite()] })],
    [/\/api\/transit\/cities/, () => ({ success: true, data: [{ code: '027', name: '北京市', hasMetro: true, hot: true, pinyin: 'beijing' }] })],
    [/\/api\/transit\/lines\//, () => ({ success: true, data: null })],
    [/\/api\/transit\/runtime-flags/, () => ({ success: true, data: {} })],
  ]
}

async function mountPlatform(answer: FavouritesAnswer): Promise<MountedHost> {
  const host = await mountComponent(PlatformPage, { routes: routes(answer) })
  await host.flush()
  return host
}

/** 失败读取的重试控件，或一个点名缺失之物的抛错。 */
function retryControl(host: MountedHost): HostElement {
  const found = host.nodes((item: HostElement) => item.tag === 'button' && host.textOf(item).trim() === '重试')[0]
  if (!found) throw new Error('the failed read offered no retry')
  return found
}

afterEach(async () => {
  await new Promise(resolve => setTimeout(resolve, 0))
  vi.unstubAllGlobals()
})

describe('站台页：关注线路读不到，不等于没有关注线路', () => {
  it('读失败时说「未读到关注线路」，不给「暂无已关注线路途经」', async () => {
    const host = await mountPlatform({ value: 'fail' })

    const text = host.text()
    expect(text, 'an unreadable list must not be worded as an empty one').not.toContain('暂无已关注线路途经')
    expect(text).toContain('未读到关注线路')
    expect(retryControl(host)).toBeDefined()
    host.unmount()
  })

  it('读失败时的重试会重新读那一个列表', async () => {
    const answer: FavouritesAnswer = { value: 'fail' }
    const host = await mountPlatform(answer)
    expect(host.text()).toContain('未读到关注线路')

    answer.value = 'ok'
    await press(host, retryControl(host))

    expect(host.text()).not.toContain('未读到关注线路')
    host.unmount()
  })

  it('读到了但一条都没关注：这才是「该站台暂无已关注线路途经」', async () => {
    const host = await mountPlatform({ value: 'empty' })

    const text = host.text()
    expect(text).toContain('暂无已关注线路途经')
    expect(text).not.toContain('未读到关注线路')
    host.unmount()
  })
})
