import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, shallowRef, type ShallowRef } from 'vue'
import type { ArrivalRow, Station } from '@real-time-transport/shared'
import { mountComponent } from '../settings/settings-harness'
import StationPopover from '../../../views/line-detail/components/station-popover.vue'

/**
 * 同一个分钟里的两班车不是同一辆车。
 *
 * 到站条的行身份曾按 `a.time` 取：两班车预计同一分钟到站时（前车被追上、一前一后挨着
 * 进站是常态）两行拿到同一个 key，刷新那一拍 Vue 报 Duplicate keys，DOM 复用也失去
 * 依据。行的身份是车辆（busId）；没有身份的读数退到位置。
 */

const ANCHOR = { screenX: 120, screenY: 240, radius: 12, x: 12, y: 24 }
const STATION: Station = { id: 'st-1', name: '大稿新村', order: 11, lat: 39.87914, lng: 116.64467, interchanges: [] }

function hostOf(rows: ShallowRef<ArrivalRow[]>) {
  return defineComponent({
    name: 'PopoverHost',
    setup() {
      return () => h(StationPopover, {
        station: STATION,
        anchor: ANCHOR,
        arrivals: { arrivals: rows.value },
        eta: '还有 7 分钟',
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

describe('到站条的行身份', () => {
  it('两班车落在同一分钟时，刷新不产生重复 key 警告', async () => {
    // reka-ui 弹层的尺寸观察器：装置不替它们做全局桩件，页面用例自己布。
    class ObserverStub {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
      takeRecords(): unknown[] { return [] }
    }
    vi.stubGlobal('ResizeObserver', ObserverStub)
    vi.stubGlobal('MutationObserver', ObserverStub)
    vi.stubGlobal('IntersectionObserver', ObserverStub)

    const rows = shallowRef<ArrivalRow[]>([
      { time: '18:19', etaSeconds: 420, stopsAway: 5, busId: '1800156306' },
      { time: '18:19', etaSeconds: 430, stopsAway: 6, busId: '6377608570' },
    ])
    const host = await mountComponent(hostOf(rows))
    // 挂载那一拍不做 keyed diff —— 刷新才是报告里的那一拍。
    const warnings: string[] = []
    const spy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(String(args[0]))
    })
    rows.value = [
      { time: '18:20', etaSeconds: 410, stopsAway: 5, busId: '1800156306' },
      { time: '18:20', etaSeconds: 415, stopsAway: 6, busId: '6377608570' },
    ]
    await host.flush()
    expect(warnings.filter(item => item.includes('Duplicate keys'))).toEqual([])
    // 两行都在屏上（安静不是靠丢一行换来的）。
    const shown = host.text()
    expect(shown).toContain('18:20')
    expect(shown).toContain('5站')
    expect(shown).toContain('6站')
    spy.mockRestore()
    host.unmount()
  })
})
