import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import type { Station } from '@real-time-transport/shared'
import { mountComponent } from '../settings/settings-harness'
import StationPopover from '../../../views/line-detail/components/station-popover.vue'

const ANCHOR = { screenX: 120, screenY: 240, radius: 12, x: 12, y: 24 }
const STATION: Station = { id: 'st-1', name: '群芳', order: 1, lat: 39.87, lng: 116.64, interchanges: [] }

function hostOf() {
  return defineComponent({
    name: 'PopoverHost',
    setup() {
      return () => h(StationPopover, {
        station: STATION,
        anchor: ANCHOR,
        arrivals: { arrivals: [], nextScheduled: { time: '16:45' } },
        eta: '前序暂无在途车辆',
        etaMark: null,
        freshness: '10 秒前更新',
        isRefreshing: false,
      })
    },
  })
}

afterEach(async () => {
  await new Promise(resolve => setTimeout(resolve, 0))
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('没有在途车辆时的时刻表行', () => {
  it('列表为空时单独显示下一班时刻表，不冒充到站分钟', async () => {
    class ObserverStub {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
      takeRecords(): unknown[] { return [] }
    }
    vi.stubGlobal('ResizeObserver', ObserverStub)
    vi.stubGlobal('MutationObserver', ObserverStub)
    vi.stubGlobal('IntersectionObserver', ObserverStub)

    const host = await mountComponent(hostOf())
    const text = host.text()
    expect(text).toContain('暂无在途车辆')
    expect(text).toContain('下一班时刻表')
    expect(text).toContain('16:45')
    expect(text).not.toContain('16:45 到站')
    host.unmount()
  })
})
