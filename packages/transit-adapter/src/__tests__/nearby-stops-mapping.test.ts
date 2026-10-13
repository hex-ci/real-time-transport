import { describe, expect, it } from 'vitest'
import { nearbyStopsOf } from '../providers/chelaile.js'

/**
 * 附近站台载荷 → 我附近的站台（PRD F5）。
 *
 * 上游把**同一个站的不同物理站台各给一条**（同 `sId`、不同 `physicalStId` 与坐标），
 * 故这一层必须按 `sId` 去重 —— 站的身份是 id，一个站只该占一行。距离不由这一层给：
 * 它只决定「谁算附近」（上游自己的窗口约 1 公里），显示与排序用调用方那一条直线距离。
 *
 * `NN站` 是占位：本文件不出现真实站名。
 */
function payloadOf(stations: unknown[]): unknown {
  return { userLng: -1, userLat: -1, gpstype: 0, nearStations: stations }
}

function stopOf(params: {
  sId: string
  sn: string
  distance?: number
  lat?: number
  lng?: number
}): unknown {
  return {
    sId: params.sId,
    sn: params.sn,
    distance: params.distance,
    lat: params.lat,
    lng: params.lng,
    physicalStId: `phys-${params.sId}-${params.distance ?? 0}`,
    namesakeStId: 'namesake',
    sType: 0,
  }
}

describe('按站 id 去重：一个站一行', () => {
  it('同一个站的不同物理站台合成一条，保留最近的那个', () => {
    const stops = nearbyStopsOf(payloadOf([
      stopOf({ sId: '010-1', sn: 'NN站', distance: 0, lat: 39.9, lng: 116.4 }),
      stopOf({ sId: '010-1', sn: 'NN站', distance: 50, lat: 39.901, lng: 116.401 }),
      stopOf({ sId: '010-2', sn: 'NN二站', distance: 215, lat: 39.91, lng: 116.41 }),
    ]))

    expect(stops.map(stop => stop.stationId)).toEqual(['010-1', '010-2'])
    expect(stops[0]!.lat).toBe(39.9)
  })

  it('按上游给的距离升序：最近的在前', () => {
    const stops = nearbyStopsOf(payloadOf([
      stopOf({ sId: '010-3', sn: 'NN三站', distance: 700 }),
      stopOf({ sId: '010-1', sn: 'NN一站', distance: 20 }),
      stopOf({ sId: '010-2', sn: 'NN二站', distance: 300 }),
    ]))

    expect(stops.map(stop => stop.name)).toEqual(['NN一站', 'NN二站', 'NN三站'])
  })
})

describe('缺什么就不给什么', () => {
  it('没有站 id 或没有站名的条目不成行：没有身份就没有可读的站', () => {
    const stops = nearbyStopsOf(payloadOf([
      stopOf({ sId: '', sn: 'NN站', distance: 10 }),
      stopOf({ sId: '010-9', sn: '', distance: 20 }),
      stopOf({ sId: '010-1', sn: 'NN一站', distance: 30 }),
    ]))

    expect(stops.map(stop => stop.stationId)).toEqual(['010-1'])
  })

  it('坐标缺失就是 null，不拿 0 当「就在脚下」', () => {
    const stops = nearbyStopsOf(payloadOf([
      stopOf({ sId: '010-1', sn: 'NN一站', distance: 10, lat: 0, lng: 0 }),
      stopOf({ sId: '010-2', sn: 'NN二站', distance: 20 }),
    ]))

    expect(stops[0]!.lat).toBeNull()
    expect(stops[0]!.lng).toBeNull()
    expect(stops[1]!.lat).toBeNull()
  })

  it('距离缺失的条目仍然成行，但排在给了距离的之后', () => {
    const stops = nearbyStopsOf(payloadOf([
      stopOf({ sId: '010-2', sn: 'NN二站' }),
      stopOf({ sId: '010-1', sn: 'NN一站', distance: 20 }),
    ]))

    expect(stops.map(stop => stop.stationId)).toEqual(['010-1', '010-2'])
  })

  it('上游答了但没有附近站台时是空数组，不是 null（空与读不到是两件事）', () => {
    expect(nearbyStopsOf(payloadOf([]))).toEqual([])
    expect(nearbyStopsOf({ nearStations: null })).toEqual([])
    expect(nearbyStopsOf(undefined)).toEqual([])
  })
})
