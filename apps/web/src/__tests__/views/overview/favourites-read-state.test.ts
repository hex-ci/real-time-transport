import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  RouterLinkStub,
  mountComponent,
  press,
  type HostElement,
  type MountedHost,
  type Route,
} from '@/views/settings/__tests__/settings-harness'
import OverviewPage from '../index.vue'

/**
 * 首页在 §4.1 规则中的那一份：**失败**的关注线路读取不是空的关注线路列表。
 *
 * `设置` 的索引行最先学到这一点，而首页是同一失败为害最大的表面：读取失败时 `fetchFavorites`
 * 留下一个空数组，卡片由该数组构建，空卡片列表会渲染「当前城市（北京市）还没有关注线路」并附一个
 * 让用户去关注线路的链接——那些线路他们已经在关注。成因与动作都错，修复属于读取自身的状态而非措辞。
 *
 * 挂载的是**页面**而非空态组件，因为被测断言是页面的：它向下传递哪个状态，正是组件级测试看不到的。
 * 该挂载复用 `设置` 的无 DOM 装置（Vue 的 runtime-core 渲染为普通对象，无 jsdom）——本仓库只有
 * 这一个此类装置，第二份副本会与之漂移。
 *
 * `useRouter` 是页面触及的唯一应用管道（它导航到线路详情），被 mock：此处什么都不导航。
 */

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: () => {} }),
}))

/** 当前城市的一条关注线路，如 store 所读。 */
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

/**
 * 关注线路读取所答，保存在一个**盒子**而非作为值传入，使测试能中途修好端点并证明页面的重试真的重读。
 */
interface FavouritesAnswer { value: 'ok' | 'empty' | 'fail' }

/**
 * 页面在挂载时发出的读取，其中决定本测试的那个由测试控制。其余都答无害的内容：
 * 本文件关乎不可读列表产生的措辞，而非卡片。
 */
function routes(answer: FavouritesAnswer): Route[] {
  return [
    [/\/api\/transit\/favorites$/, () => (answer.value === 'fail'
      ? { success: false, error: '读取失败' }
      : { success: true, data: answer.value === 'empty' ? [] : [favourite()] })],
    [/\/api\/transit\/cities/, () => ({ success: true, data: [{ code: '027', name: '北京市', hasMetro: true, hot: true, pinyin: 'beijing' }] })],
    [/\/api\/transit\/commute-profile/, () => ({ success: true, data: null })],
    [/\/api\/transit\/runtime-flags/, () => ({ success: true, data: {} })],
    [/\/api\/transit\/lines\//, () => ({ success: true, data: null })],
  ]
}

async function mountOverview(answer: FavouritesAnswer): Promise<MountedHost> {
  const host = await mountComponent(OverviewPage, {
    routes: routes(answer),
    components: { RouterLink: RouterLinkStub },
  })
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

describe('首页：关注线路读不到，不等于一条都没关注', () => {
  it('读失败时说「未读到关注线路」，不给「还没有关注线路」，也不给「去搜索并关注线路」', async () => {
    const host = await mountOverview({ value: 'fail' })

    const text = host.text()
    expect(text, 'an unreadable list must not be worded as an empty one').not.toContain('还没有关注线路')
    expect(text, 'the action for a failed read is a retry, not re-following lines the user has')
      .not.toContain('去搜索并关注线路')
    expect(text).toContain('未读到关注线路')
    host.unmount()
  })

  it('读失败时的重试会重新读那一个列表，读到就把卡片显示出来', async () => {
    const answer: FavouritesAnswer = { value: 'fail' }
    const host = await mountOverview(answer)
    expect(host.text()).toContain('未读到关注线路')

    // 端点被修好，然后页面按用户驱动它的方式被驱动。
    answer.value = 'ok'
    await press(host, retryControl(host))

    expect(host.text()).not.toContain('未读到关注线路')
    expect(host.text()).toContain('快线 1 路')
    host.unmount()
  })

  it('读到了但一条都没关注：这才是「还没有关注线路」，并指向那一页', async () => {
    const host = await mountOverview({ value: 'empty' })

    // 路由答了空列表，故空态现在是一个关于**已存储内容**的事实——而该链接是那个事实的动作。
    const text = host.text()
    expect(text).toContain('还没有关注线路')
    expect(text).not.toContain('未读到关注线路')
    host.unmount()
  })
})
