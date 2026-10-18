import { describe, expect, it } from 'vitest'
import {
  temporaryStationFromQuery,
  temporaryStationQueryOf,
  withoutTemporaryStation,
} from '../../../views/station-board/temporary-station-query'

describe('电子站牌临时站台参数', () => {
  it('读齐 stationId / stationName / 可选坐标', () => {
    expect(temporaryStationFromQuery({
      stationId: '010-1',
      stationName: '大稿新村',
      lat: '39.879',
      lng: '116.644',
    })).toEqual({
      stationId: '010-1',
      stationName: '大稿新村',
      lat: 39.879,
      lng: 116.644,
    })
  })

  it('缺站名或 id 时不当临时站', () => {
    expect(temporaryStationFromQuery({ stationId: '010-1' })).toBeNull()
    expect(temporaryStationFromQuery({ stationName: '大稿新村' })).toBeNull()
  })

  it('写参数时带上站台身份与坐标，移除时保留其它参数', () => {
    const query = temporaryStationQueryOf({
      id: '010-1',
      name: '大稿新村',
      lat: 39.879,
      lng: 116.644,
    })
    expect(query).toEqual({
      stationId: '010-1',
      stationName: '大稿新村',
      lat: '39.879',
      lng: '116.644',
    })
    expect(withoutTemporaryStation({ ...query, foo: 'bar' })).toEqual({ foo: 'bar' })
  })
})
