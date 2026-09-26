import { describe, expect, it } from 'vitest'
import type { DataSourceType } from '@real-time-transport/shared'
import { platformRowProvenanceOf } from '../views/platform/provenance'
import { provenanceLabelOf } from '../provenance-copy'

/**
 * 站台屏上的 F4：每**行**一个标记。
 *
 * 站台屏是规格点名的混合列表情形：每关注线路/方向一行，一眼之内可同时存在不同种类的数字——
 * 真实车辆自己的行程时间、生成列车的时间、以及没人能分类的行。两条规则承重：这些行必须可区分，
 * 且生产者未陈述任何内容的行绝不可读成「实时」。
 *
 * 措辞本身归 `provenance-copy.ts` 并在那里测试；本文件测每行得到哪种**类型**。
 */

const UNKNOWN = 'some_future_source' as DataSourceType

describe('a platform row states the kind of number it carries', () => {
  it('keeps a real vehicle\'s own travel time as 实时', () => {
    for (const dataSource of ['chelaile', 'apizero'] as const) {
      expect(platformRowProvenanceOf({ dataSource, hasMinute: true })).toBe('live')
    }
  })

  it('marks a generated train 排班推演, however the minute reached the board', () => {
    // 时刻表引擎给它的每趟列车放一个行程时间，故该行到达时看起来与其他实时行无异，
    // 由车辆决定而非读取分钟的所在分支。
    expect(platformRowProvenanceOf({ dataSource: 'subway_schedule', hasMinute: true }))
      .toBe('schedule_simulation')
  })

  it('states nothing for a source this build does not know', () => {
    // 零捏造规则最锐利处：全新 feed 答 null，故该行保留分钟且不显示标记——绝不用好看的那个词。
    const unknown = platformRowProvenanceOf({ dataSource: UNKNOWN, hasMinute: true })
    expect(unknown).toBeNull()
    expect(provenanceLabelOf(unknown)).toBeNull()
    expect(provenanceLabelOf(unknown)).not.toBe('实时')
  })

  it('states nothing for a row that has no minute to classify', () => {
    // 范围内无车：该行改为陈述服务事实，没有数字可供某类型归属。请求失败同理。
    for (const dataSource of ['chelaile', 'apizero', 'subway_schedule', UNKNOWN, null, undefined] as const) {
      expect(platformRowProvenanceOf({ dataSource, hasMinute: false })).toBeNull()
    }
  })
})

describe('the rows of one board stay tellable apart', () => {
  it('gives a classified row, a modelled row and an unclassified row three different readings', () => {
    const live = provenanceLabelOf(platformRowProvenanceOf({ dataSource: 'chelaile', hasMinute: true }))
    const modelled = provenanceLabelOf(platformRowProvenanceOf({ dataSource: 'subway_schedule', hasMinute: true }))
    const silent = provenanceLabelOf(platformRowProvenanceOf({ dataSource: UNKNOWN, hasMinute: true }))
    expect(live).toBe('实时')
    expect(modelled).not.toBe(live)
    expect(silent).toBeNull()
    expect(new Set([live, modelled, silent]).size).toBe(3)
  })

  it('never rounds an unclassifiable row up to the flattering mark', () => {
    for (const dataSource of [null, undefined, UNKNOWN] as const) {
      const provenance = platformRowProvenanceOf({ dataSource, hasMinute: true })
      expect(provenance).toBeNull()
      expect(provenanceLabelOf(provenance)).not.toBe('实时')
    }
  })
})
