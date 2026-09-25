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
 * The platform board's share of §4.1's own rule: a followed-lines read that FAILED is not an
 * empty followed-lines list.
 *
 * The board is where the two look most alike. Its station options come from the followed
 * lines, so a read that failed leaves it with no station to show — and it announced
 * 「该站台暂无已关注线路途经，请在「设置」中关注经过此站的线路」, which is a claim about what
 * the user follows and sends them to re-follow lines they already follow. The truth is
 * 「没读到」, and the only action that can change it is another read.
 *
 * The PAGE is mounted, not the board alone, because which state the page hands down is half of
 * the claim. This repo has one DOM-free mount harness (设置's), and a second copy would drift
 * from it. The station header is replaced with an inert stub because it drives a native
 * `<select>`, which runtime-dom's `v-model` writes through `options.length` — a DOM API this
 * harness deliberately does not model. Nothing here is about the header.
 */

vi.mock('../components/platform-header.vue', () => ({
  default: {
    name: 'PlatformHeaderStub',
    props: ['modelValue', 'stationOptions', 'landmarkHint', 'detecting'],
    emits: ['update:modelValue', 'detect', 'change'],
    render: () => null,
  },
}))

/** One followed line of the active city. */
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

/** What the followed-lines read answers, in a box so a test can repair it mid-run. */
interface FavouritesAnswer { value: 'ok' | 'empty' | 'fail' }

/**
 * The reads the page makes on mount. `/lines/` answers nothing on purpose: this file is about
 * the words an unreadable followed-lines list produces, not about the departures.
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

/** The failed read's retry control, or a thrown error naming what was missing. */
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
