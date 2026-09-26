import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  RouterLinkStub,
  mountComponent,
  type MountedHost,
  type Route,
} from '@/views/settings/__tests__/settings-harness'
import OverviewPage from '../index.vue'

/**
 * 首页的「行在、但通勤时段从没选过」。
 *
 * `windowState` 说得出三种事实：`stored`（有窗口）、`unset`（没有这一行）、`unchosen`
 * （行在，四个时刻是 NULL）。前两种首页已经分得开，第三种是 T2 新增的：没有任何窗口可跟随，
 * 所以它既不是「非通勤时段」（那是在说时钟落在两个已配置窗口之外），也不是任何内置时段。
 * 一个只认 `unset` 的首页会把第三种印成「非通勤」—— 它声称有一个可被落在外面的窗口。
 *
 * 页面在这里被挂载（不是断言源码），因为被钉的是页面传递下去的那个事实。
 */

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: () => {} }),
}))

/** 页面发出的读取，profile 答案由测试控制。 */
function routes(profile: unknown): Route[] {
  return [
    [/\/api\/transit\/favorites$/, () => ({ success: true, data: [] })],
    [/\/api\/transit\/cities/, () => ({ success: true, data: [{ code: '027', name: '北京市', hasMetro: true, hot: true, pinyin: 'beijing' }] })],
    [/\/api\/transit\/commute-profile/, () => profile],
    [/\/api\/transit\/runtime-flags/, () => ({ success: true, data: {} })],
    [/\/api\/transit\/lines\//, () => ({ success: true, data: null })],
  ]
}

async function mountOverview(profile: unknown): Promise<MountedHost> {
  const host = await mountComponent(OverviewPage, {
    routes: routes(profile),
    components: { RouterLink: RouterLinkStub },
  })
  await host.flush()
  return host
}

afterEach(async () => {
  await new Promise(resolve => setTimeout(resolve, 0))
  vi.unstubAllGlobals()
})

describe('首页：行在、时段没选过，不等于「非通勤时段」', () => {
  it('windowState=unchosen 时，首页说「未设置通勤时段」，不说「非通勤」', async () => {
    const host = await mountOverview({
      success: true,
      data: { mode: 'auto', description: '未设置通勤时段', windowState: 'unchosen' },
    })

    const text = host.text()
    expect(text, 'a row whose hours were never chosen was reported as a clock outside a window').not.toContain('非通勤')
    expect(text).toContain('未设置通勤时段')
    host.unmount()
  })

  it('正对照：有时段可选时，首页照旧可以说「非通勤时段」', async () => {
    const host = await mountOverview({
      success: true,
      data: { mode: 'auto', description: '非通勤时段', windowState: 'stored' },
    })

    expect(host.text()).toContain('非通勤时段')
    host.unmount()
  })

  it('没有这一行时，「未设置通勤时段」仍然是那句话', async () => {
    const host = await mountOverview({
      success: true,
      data: { mode: 'auto', description: '未设置通勤时段', windowState: 'unset' },
    })

    expect(host.text()).toContain('未设置通勤时段')
    expect(host.text()).not.toContain('非通勤')
    host.unmount()
  })
})
