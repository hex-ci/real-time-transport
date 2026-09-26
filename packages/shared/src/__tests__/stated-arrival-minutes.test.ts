import { describe, expect, it } from 'vitest'
import { arrivalMinutes, statedArrivalMinutes } from '../departure.js'
import { ArrivalRowSchema } from '../schemas/transit.js'
import type { ArrivalRow } from '../schemas/transit.js'

/**
 * 一行要么声明了分钟，要么声明了「没有分钟」—— 只在一处判定。
 * `ArrivalRowSchema` 使 `etaSeconds` 可选：某车的定向读数未发布时间，该行就没有分钟。
 * 故每个展示到站列表的表面每行都有三态（在站台 / 有分钟 / 无分钟），各自必须照实渲染。
 * 两种出错方式都会上屏：把没人声明的分钟画在「分」旁边（与被删除的推算值是同一个谎），
 * 以及 `null分` / `NaN分` —— 该是诚实缺省的地方出现了一个坏数字。
 */

describe('a row states a minute or it does not', () => {
  it('answers the rounded minute for a row that carries one, by the app-wide rule', () => {
    expect(statedArrivalMinutes({ etaSeconds: 420 })).toBe(7)
    expect(statedArrivalMinutes({ etaSeconds: 417 })).toBe(7)
    expect(statedArrivalMinutes({ etaSeconds: 30 })).toBe(1)
    expect(statedArrivalMinutes({ etaSeconds: 420 })).toBe(arrivalMinutes(420))
  })

  it('answers 0 for the at-platform row, which is an arrival and not a missing value', () => {
    // 服务端用 `etaSeconds: 0` 计价该状态（上游自己声明车已在此）；此处答 `null` 会把停在站台上的车藏起来。
    expect(statedArrivalMinutes({ etaSeconds: 0, isAtStation: true })).toBe(0)
    // 该状态就是观测本身，故产出方省略了配套的 0 也照样成立。
    expect(statedArrivalMinutes({ isAtStation: true })).toBe(0)
  })

  it('answers null for a row that states no minute', () => {
    // 定向读数未发布时间时，服务端给出的行形状。
    const row: ArrivalRow = { stopsAway: 2, busId: 'b1' }
    expect(statedArrivalMinutes(row)).toBeNull()
    // 契约的另一半：非有限或负的时长不是时长，不得变成「NaN分」或「-1分」。
    expect(statedArrivalMinutes({ etaSeconds: Number.NaN })).toBeNull()
    expect(statedArrivalMinutes({ etaSeconds: Number.POSITIVE_INFINITY })).toBeNull()
    // 字面 `null` 会到达浏览器：web 在该边界不按 schema 校验就读到站 payload 的 JSON。
    expect(statedArrivalMinutes({ etaSeconds: null })).toBeNull()
    expect(statedArrivalMinutes({ etaSeconds: undefined })).toBeNull()
  })

  it('reads the row the wire actually serves, minute or no minute', () => {
    // 两种形状都过一遍它们实际出行的契约，使该助手与 schema 不会漂移。
    const withMinute = ArrivalRowSchema.parse({ time: '14:07', etaSeconds: 420, stopsAway: 2, provenance: 'live' })
    expect(statedArrivalMinutes(withMinute)).toBe(7)

    const withoutMinute = ArrivalRowSchema.parse({ stopsAway: 2, busId: 'b1' })
    expect(statedArrivalMinutes(withoutMinute)).toBeNull()
  })
})
