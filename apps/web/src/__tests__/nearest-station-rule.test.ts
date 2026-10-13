import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { haversineMeters, wgs84ToGcj02 } from '@real-time-transport/shared/geo'
import type { Station } from '@real-time-transport/shared'

/**
 * 线路距用户定位最近的站点，以及决定哪些站可以被测量的规则。
 *
 * 只有载荷真正陈述了坐标的站才是候选。任一轴为零即本应用 GCJ-02 基准下**没有**坐标
 * （没有已放置的站会落在 0），从它测量会把步行算到大西洋上的一点，让未放置的站台成为离用户
 * 最近的东西。该规则只存在一处（`statedCoordinate`），本文件钉住使用它的两半：store 通过它读
 * 坐标，由此得到的答案是诚实的——有已放置的站就给出最近站，否则**没有**，而不是退回列表第一站。
 *
 * 量距离的基准面是 `GCJ-02`：开发覆写注入的是设备定位（`WGS-84`），store 把它换算一次，站表
 * 坐标本身就在这个面上。期望值因此从换算后的点算起 —— 按原始定位算会得到另一个数（北京差约
 * 555 米），而那个数正是这次修掉的东西。
 */

/** 测试所在的位置（设备定位），经由 store 自己的开发覆写注入。 */
const FIX = { lat: 39.9, lng: 116.4 }

/** `FIX` 进入 store 后被换算成的那个点：本文件所有距离的起点。 */
const GCJ_FIX = (() => {
  const [lng, lat] = wgs84ToGcj02(FIX.lng, FIX.lat)
  return { lat, lng }
})()

/** 从「我」到某站的距离，与 store 量的是同一段。 */
function metresTo(lat: number, lng: number): number {
  return haversineMeters(GCJ_FIX.lat, GCJ_FIX.lng, lat, lng)
}

/** 屏幕上线路的一个站，未给定则完全没有位置。 */
function stop(id: string, name: string, lat?: number, lng?: number): Station {
  const s: Station = { id, name, order: 1, interchanges: [] }
  if (lat !== undefined) s.lat = lat
  if (lng !== undefined) s.lng = lng
  return s
}

/**
 * 在固定 GPS 覆写环境下加载 store。
 *
 * `VITE_GPS_SIMULATION` 是 store 自己对设备定位的替代，使最近站计算可在无浏览器下演练；
 * 模块在 import 时读取该标志，故需要固定环境与全新的模块注册表。
 */
async function freshStore(env: Record<string, string> = {}) {
  vi.stubEnv('VITE_GPS_SIMULATION', 'false')
  vi.stubEnv('VITE_GPS_SIM_LAT', '')
  vi.stubEnv('VITE_GPS_SIM_LNG', '')
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value)
  vi.resetModules()
  const { useLocationStore } = await import('../stores/location.store')
  return useLocationStore()
}

/** 跟踪固定开发位置的 store。 */
function storeAtFix(over: Record<string, string> = {}) {
  return freshStore({
    VITE_GPS_SIMULATION: 'true',
    VITE_GPS_SIM_LAT: String(FIX.lat),
    VITE_GPS_SIM_LNG: String(FIX.lng),
    ...over,
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('the nearest stop is chosen from the stops that state a position', () => {
  it('picks the placed stop nearest the fix, in metres', async () => {
    const store = await storeAtFix()
    const near = stop('s2', '乙站', FIX.lat, 116.41)
    store.updateNearestStation([stop('s1', '甲站', FIX.lat, 116.5), near])

    expect(store.nearestStation?.id).toBe('s2')
    // 距离的定义取自应用自身，并加一个由几何推出的界，使该数被检查而非仅被重算。
    expect(store.nearestDistanceM).toBe(Math.round(metresTo(near.lat!, near.lng!)))
    // 乙站与换算后的我相差约 0.0038 经度、0.0014 纬度：约 357 米。
    expect(store.nearestDistanceM).toBeGreaterThan(340)
    expect(store.nearestDistanceM).toBeLessThan(375)
  })

  it('reports NO nearest stop when no stop of the line states a position', async () => {
    const store = await storeAtFix()
    // 两个站都不能被测量：第一个没有坐标，第二个坐标为零——本基准下同一种缺失。
    // 测量其中一个的 store 会给出看起来更近的那个，把未放置的站台呈现为离用户最近的东西。
    store.updateNearestStation([stop('s1', '甲站'), stop('s2', '乙站', 0, 0)])

    expect(store.nearestStation).toBeNull()
    expect(store.nearestDistanceM).toBeNull()
  })

  it('reports nothing at all before a fix exists, whatever the pool holds', async () => {
    // 没有定位就无可测量，答案是「无」，而不是对着虚空量出的某站。
    const store = await freshStore()
    store.updateNearestStation([stop('s1', '甲站', FIX.lat, 116.41)])

    expect(store.nearestStation).toBeNull()
    expect(store.nearestDistanceM).toBeNull()
  })
})

describe('the coordinate rule is READ here, not spelled again', () => {
  /** 去掉注释的源码：本文件的叙述可以陈述该规则。 */
  function source(file: string): string {
    return readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
  }

  it('routes the store\'s stop reads through the shared helper', () => {
    const store = source('stores/location.store.ts')
    // `!st.lat || !st.lng` 是手写重述的规则：第二份副本会与 `statedCoordinate` 漂移，
    // 而本应用其他每一处上游坐标读取都以它为准。
    expect(store, 'the store spells the zero-is-not-a-position rule itself')
      .not.toMatch(/!st\.(lat|lng)/)
    expect(store, 'the store does not read a stop coordinate through the shared rule')
      .toContain('statedCoordinate(')
  })
})

describe('换算在浏览器侧只此一处，且只作用于设备定位', () => {
  /** 浏览器源码（去掉测试与注释），键是相对 `src/` 的路径。 */
  function browserSources(): Record<string, string> {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const strip = (text: string) => text
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')

    const found: Record<string, string> = {}
    const walk = (dir: string, prefix: string) => {
      for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
        const path = `${prefix}${entry.name}`
        if (entry.isDirectory()) {
          if (entry.name === '__tests__') continue
          walk(join(dir, entry.name), `${path}/`)
        }
        else if (/\.(ts|vue)$/.test(entry.name)) {
          found[path] = strip(readFileSync(join(root, dir, entry.name), 'utf8'))
        }
      }
    }
    walk('.', '')
    return found
  }

  it('只有定位 store 换算，且只换一次', () => {
    const converters = Object.entries(browserSources())
      .filter(([, text]) => text.includes('wgs84ToGcj02('))
      .map(([path]) => path)

    // 多一处换算就多一条会漂移的路径：定位到了别的地方仍在用旧值，或者同一个点被换两次。
    expect(converters).toEqual(['stores/location.store.ts'])
  })

  it('反向换算在浏览器里根本不存在', () => {
    // 浏览器拿到的一切坐标都已在 GCJ-02 基准面上；需要反算说明有东西把面搞混了。
    const reverse = Object.entries(browserSources())
      .filter(([, text]) => text.includes('gcj02ToWgs84'))
      .map(([path]) => path)

    expect(reverse).toEqual([])
  })

  it('上报给服务端的定位一律是设备原样的那一份', () => {
    // 这三个地方把定位送出浏览器：送换算过的那份会被服务端再换算一次，点位偏走几百米，
    // 而界面上的距离看起来照样合理。
    const senders = [
      'stores/location.store.ts',
      'views/station-board/index.vue',
      'views/line-detail/index.vue',
    ]
    const sources = browserSources()
    for (const file of senders) {
      expect(sources[file], `${file} is missing`).toContain('deviceFix')
    }
  })
})

describe('nearness has a radius: beyond it there is NO nearest stop', () => {
  it('reports null when the closest stop is beyond NEARBY_RADIUS_M', async () => {
    const store = await storeAtFix()
    // 约 3.7km 外（0.0438 经度 ≈ 3.7km）：够不着的「最近」不是最近。
    // 距离要从换算后的定位量起 —— 按原始定位量，这一站看着只有 2.9km，会落进半径里。
    store.updateNearestStation([stop('s1', '甲站', FIX.lat, 116.45)])

    expect(store.nearestStation).toBeNull()
    expect(store.nearestDistanceM).toBeNull()
  })

  it('still reports the stop when it is inside the radius', async () => {
    const store = await storeAtFix()
    // 约 357m 外：在半径内，照常报出。
    store.updateNearestStation([stop('s1', '甲站', FIX.lat, 116.41)])

    expect(store.nearestStation?.id).toBe('s1')
    expect(store.nearestDistanceM).not.toBeNull()
  })
})
