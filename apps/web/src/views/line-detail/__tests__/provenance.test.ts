import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ArrivalRowSchema } from '@real-time-transport/shared'
import { arrivalListProvenanceOf, arrivalRowProvenanceOf } from '../provenance'
import { provenanceLabelOf } from '../../../provenance-copy'

/**
 * 站点面板里的 F4：一个到站应答，多种类型的行。
 *
 * 面板渲染**一个**列表，而单个应答可以携带不同类型的行——载荷送来真实车辆自己的分钟，
 * 排班引擎推演的列车紧邻。`listProvenanceOf` 对这样的列表答 null，故只渲染列表级词的面板会在行旁
 * 什么都不显示，实时分钟会读起来与推算的完全一样。测试中的回退即总览卡片已在用的那个。
 *
 * 面板在本仓库只跑在浏览器（无 jsdom、无 @vue/test-utils），故规则按逻辑断言，接线按 SFC 源码断言。
 */

let nextMinute = 5
/** 一条到站行，带本用例所关心的来源。 */
function row(provenance?: string | null): ReturnType<typeof ArrivalRowSchema.parse> {
  nextMinute += 2
  return ArrivalRowSchema.parse({
    time: `14:${String(nextMinute).padStart(2, '0')}`,
    etaSeconds: nextMinute * 60,
    ...(provenance === undefined ? {} : { provenance }),
  })
}

describe('one arrivals list, two kinds of minute', () => {
  it('cannot be described by one word', () => {
    const mixed = [row('live'), row('schedule_simulation')]
    expect(arrivalListProvenanceOf(mixed)).toBeNull()
    expect(provenanceLabelOf(arrivalListProvenanceOf(mixed))).toBeNull()
  })

  it('states each row\'s own kind, so the two minutes read differently', () => {
    const mixed = [row('live'), row('schedule_simulation')]
    const lead = provenanceLabelOf(arrivalRowProvenanceOf(mixed, 0))
    const next = provenanceLabelOf(arrivalRowProvenanceOf(mixed, 1))
    expect(lead).toBe('实时')
    expect(next).toBe('排班推演')
    expect(lead).not.toBe(next)
  })
})

describe('a list whose classified rows agree is stated once', () => {
  it('lets the list speak the one word', () => {
    const uniform = [row('live'), row('live')]
    expect(arrivalListProvenanceOf(uniform)).toBe('live')
    expect(provenanceLabelOf(arrivalListProvenanceOf(uniform))).toBe('实时')
  })

  it('does not repeat that word on every row', () => {
    const uniform = [row('live'), row('live')]
    expect(arrivalRowProvenanceOf(uniform, 0)).toBeNull()
    expect(arrivalRowProvenanceOf(uniform, 1)).toBeNull()
  })
})

describe('an unstated provenance is never rounded up to 实时', () => {
  it('marks nothing for a list whose rows state nothing', () => {
    const silent = [row(null), row()]
    expect(arrivalListProvenanceOf(silent)).toBeNull()
    for (let i = 0; i < silent.length; i++) {
      expect(provenanceLabelOf(arrivalRowProvenanceOf(silent, i))).toBeNull()
    }
  })

  it('leaves the unstated row unmarked even when the rest of the list agrees', () => {
    // `listProvenanceOf` 忽略未陈述任何内容的行，故列表仍以一个词说话——
    // 而沉默的行不会被借给它一个词。
    const rows = [row('live'), row()]
    expect(arrivalListProvenanceOf(rows)).toBe('live')
    expect(arrivalRowProvenanceOf(rows, 1)).toBeNull()
  })
})

describe('the panel renders that fallback where the minutes are', () => {
  const popover = readFileSync(
    fileURLToPath(new URL('../components/station-popover.vue', import.meta.url)),
    'utf8',
  )

  function templateOf(sfc: string): string {
    const start = sfc.indexOf('<template>')
    const end = sfc.lastIndexOf('</template>')
    return start >= 0 && end > start ? sfc.slice(start, end) : ''
  }

  it('decides the list mark and every row mark from the shared rule', () => {
    expect(popover).toContain('arrivalListProvenanceOf')
    expect(popover).toContain('arrivalRowProvenanceOf')
  })

  it('words no mark itself', () => {
    // 类型在 provenance-copy.ts 变词（该决定的唯一所在处）；实时尤其不得硬编码进模板。
    const template = templateOf(popover)
    for (const word of ['实时', '排班推演', '精确时刻表']) {
      expect(template, `the popover template states ${word} itself`).not.toContain(word)
    }
  })
})
