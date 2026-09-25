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
 * The home screen's share of §4.1's own rule: a followed-lines read that FAILED is not an
 * empty followed-lines list.
 *
 * 设置's index row learned this first (its count says 「未读到」 instead of a number nobody
 * obtained), and the home screen is the surface where the same failure does the most damage:
 * `fetchFavorites` leaves an empty array behind when the read fails, the cards are built from
 * that array, and an empty card list renders 「当前城市（北京市）还没有关注线路」 with a link
 * telling the user to go and follow lines — lines they already follow. The cause and the
 * action are both wrong, and the fix belongs to the read's own state rather than to the words.
 *
 * The PAGE is mounted, not the empty-state component, because the claim being tested is the
 * page's: which state it passes down is exactly what a component-level test cannot see. That
 * mount reuses 设置's DOM-free harness (Vue's runtime-core into plain objects, no jsdom) — this
 * repo has one such harness and a second copy would drift from it.
 *
 * `useRouter` is the one piece of app plumbing the page reaches for (it navigates to a line's
 * detail), and it is mocked: nothing here navigates.
 */

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: () => {} }),
}))

/** One followed line of the active city, as the store reads them. */
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
 * What the followed-lines read answers, held in a BOX rather than passed as a value, so a
 * test can repair the endpoint mid-run and prove that the page's retry really re-reads.
 */
interface FavouritesAnswer { value: 'ok' | 'empty' | 'fail' }

/**
 * The reads the page makes on mount, with the one that decides this test under the test's
 * control. Everything else answers something harmless: this file is about the words an
 * unreadable list produces, not about the cards.
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

    // The endpoint is repaired, then the page is driven the way a user drives it.
    answer.value = 'ok'
    await press(host, retryControl(host))

    expect(host.text()).not.toContain('未读到关注线路')
    expect(host.text()).toContain('快线 1 路')
    host.unmount()
  })

  it('读到了但一条都没关注：这才是「还没有关注线路」，并指向那一页', async () => {
    const host = await mountOverview({ value: 'empty' })

    // The route answered an empty list, so the empty state is now a fact about what is
    // stored — and the link is the action for THAT fact.
    const text = host.text()
    expect(text).toContain('还没有关注线路')
    expect(text).not.toContain('未读到关注线路')
    host.unmount()
  })
})
