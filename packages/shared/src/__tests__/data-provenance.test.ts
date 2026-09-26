import { describe, expect, it } from 'vitest'
import type { DataProvenance, DataSourceType } from '../index.js'
import {
  ArrivalRowSchema,
  DataProvenanceSchema,
  arrivalProvenanceOf,
  listProvenanceOf,
  vehicleProvenanceOf,
} from '../index.js'

/**
 * F4：用户正在看的是**哪一种**数。
 * 本组测试钉住的正是该功能存在的边界：「没有来源」与「实时」是不同的事实 ——
 * 产出方没声明的值不标记，没有任何输入能把未知抬成 实时，生成列车的报时也绝不读作 实时。
 * 词汇表只保留**有产出路径**的那几档：本应用自算的那一档没有生产者，已整个删除。
 */

/**
 * 词汇表本身，两层各钉一次。
 * 类型层：`Record<DataProvenance, true>` 少一个键就是编译错误，故成员被加回来时
 * `pnpm typecheck` 先红；运行时断言只是把同一事实说第二遍。
 */
const VOCABULARY: Record<DataProvenance, true> = {
  live: true,
  schedule_simulation: true,
  exact_timetable: true,
}

describe('the vocabulary keeps only the kinds something produces', () => {
  it('is exactly the three marks the product can produce', () => {
    expect(DataProvenanceSchema.options).toEqual(['live', 'schedule_simulation', 'exact_timetable'])
    expect(Object.keys(VOCABULARY)).toEqual([...DataProvenanceSchema.options])
  })

  it('no longer carries the kind with no producer', () => {
    expect(DataProvenanceSchema.options).not.toContain('position_estimate')
    expect(DataProvenanceSchema.safeParse('position_estimate').success).toBe(false)
  })
})

describe('vehicle provenance comes from the source the payload declared', () => {
  it('reads a real vehicle feed as 实时 and the timetable engine as 排班推演', () => {
    expect(vehicleProvenanceOf('chelaile')).toBe('live')
    expect(vehicleProvenanceOf('apizero')).toBe('live')
    expect(vehicleProvenanceOf('subway_schedule')).toBe('schedule_simulation')
  })

  it('classifies nothing when there is no reading at all', () => {
    expect(vehicleProvenanceOf(null)).toBeNull()
    expect(vehicleProvenanceOf(undefined)).toBeNull()
  })

  it('leaves a source this build does not know unclassified', () => {
    // 第三种数据源绝不能被抬成讨喜的答案：默认分支返回「没有声明」而非 实时。
    expect(vehicleProvenanceOf('some_future_source' as DataSourceType)).toBeNull()
    expect(vehicleProvenanceOf('' as DataSourceType)).toBeNull()
  })
})

describe('an arrival minute is classified by how it was produced', () => {
  it('keeps a minute the data source itself sent as 实时', () => {
    expect(arrivalProvenanceOf({ vehicle: 'live', basis: 'upstream' })).toBe('live')
  })

  it('keeps a vehicle seen at this platform as 实时', () => {
    // 位置是观测到的而非模型算的：这是实时车辆唯一会陈述 payload 本身没有的东西的情形。
    expect(arrivalProvenanceOf({ vehicle: 'live', basis: 'at_platform' })).toBe('live')
  })

  it('calls a minute this app computed 实时 as well, its own kind having been dropped', () => {
    // 词汇表不再有「本应用自算」那一档（没有产出路径），故真实车辆的每个非缺席分钟都是 实时；
    // 此钉钉的是签名不再为该 basis 分叉。
    expect(arrivalProvenanceOf({ vehicle: 'live', basis: 'our_estimate' })).toBe('live')
  })

  it('marks a simulated vehicle 排班推演 however the minute beside it was produced', () => {
    // 车辆说了算：引擎会给每趟列车带上 travelTimeSec，故生成的车也能走到「上游给了分钟」的分支。
    for (const basis of ['upstream', 'at_platform', 'our_estimate'] as const) {
      expect(arrivalProvenanceOf({ vehicle: 'schedule_simulation', basis }))
        .toBe('schedule_simulation')
    }
  })

  it('states nothing when the vehicle kind is unknown', () => {
    for (const basis of ['upstream', 'at_platform', 'our_estimate'] as const) {
      expect(arrivalProvenanceOf({ vehicle: null, basis })).toBeNull()
      expect(arrivalProvenanceOf({ vehicle: undefined, basis })).toBeNull()
    }
  })
})

describe('a list states one provenance only when its rows agree', () => {
  it('answers for a list whose rows share a source', () => {
    expect(listProvenanceOf([{ provenance: 'live' }, { provenance: 'live' }])).toBe('live')
    expect(listProvenanceOf([{ provenance: 'exact_timetable' }])).toBe('exact_timetable')
  })

  it('refuses to answer for a list that mixes sources', () => {
    // 那样一个词会对一半的行说谎；调用方改为逐行标记。
    expect(listProvenanceOf([{ provenance: 'live' }, { provenance: 'schedule_simulation' }])).toBeNull()
    expect(listProvenanceOf([{ provenance: 'exact_timetable' }, { provenance: 'live' }])).toBeNull()
  })

  it('answers nothing for an empty list or one with no stated provenance', () => {
    expect(listProvenanceOf([])).toBeNull()
    expect(listProvenanceOf([{}, { provenance: undefined }, { provenance: null }])).toBeNull()
  })

  it('ignores unclassified rows when deciding', () => {
    // 未分类的行不是第二种意见：它不得让本就一致的行失去结论。
    expect(listProvenanceOf([{ provenance: 'live' }, {}])).toBe('live')
  })
})

describe('the arrival row contract carries the value\'s own provenance', () => {
  it('parses the provenance value it was given', () => {
    const parsed = ArrivalRowSchema.parse({
      time: '09:12',
      etaSeconds: 512,
      stopsAway: 4,
      provenance: 'schedule_simulation',
    })
    // 断言解析后的输出：只断言 `safeParse(...).success` 会因为 Zod 丢弃未知键而在该字段存在前也通过。
    expect(parsed.provenance).toBe('schedule_simulation')
  })

  it('accepts an exact-timetable row and a row that states nothing', () => {
    expect(ArrivalRowSchema.parse({
      time: '08:32',
      etaSeconds: 120,
      provenance: 'exact_timetable',
    }).provenance).toBe('exact_timetable')

    const silent = ArrivalRowSchema.parse({ time: '08:32', etaSeconds: 120 })
    expect(silent.provenance).toBeUndefined()
  })

  it('rejects a provenance outside the vocabulary', () => {
    expect(ArrivalRowSchema.safeParse({
      time: '09:12',
      etaSeconds: 512,
      provenance: 'realtime-ish',
    }).success).toBe(false)
    // 被删掉的成员不再是合法值：解析必须失败，而不是被接受或被悄悄丢弃。
    expect(ArrivalRowSchema.safeParse({
      time: '09:12',
      etaSeconds: 512,
      provenance: 'position_estimate',
    }).success).toBe(false)
  })
})
