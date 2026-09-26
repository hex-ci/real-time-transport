import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { DepartureAdvice, DepartureReference } from '@real-time-transport/shared/departure'
import { conclusionOf, referenceLineOf } from '../views/overview/reference-line'

/**
 * 首页卡片上 F1 的参考行。
 *
 * 措辞是纯逻辑，故在此测试；仍属浏览器侧的是 375 px 下的像素结果。末尾的源码守卫钉住
 * 否则只能靠渲染检查约束的两条：该行是**次要**的，且是**附加**的——绝不隐藏或压缩
 * 它存在所要支撑的到站分钟。
 */

function comfortable(leaveInMinutes: number): DepartureAdvice {
  return { state: 'comfortable', walkMinutes: 6, nextArrivalMinutes: 12, leaveInMinutes, missCostMinutes: null }
}

function hurry(): DepartureAdvice {
  return { state: 'hurry', walkMinutes: 6, nextArrivalMinutes: 8, leaveInMinutes: 0, missCostMinutes: null }
}

function missed(missCostMinutes: number | null): DepartureAdvice {
  return { state: 'missed', walkMinutes: 6, nextArrivalMinutes: 4, leaveInMinutes: null, missCostMinutes }
}

function adviceReference(advice: DepartureAdvice): DepartureReference {
  return { status: 'advice', anchor: 'home', advice }
}

describe('the reference line states the verdict in the user\'s own terms', () => {
  it('names the real walking time from the anchor', () => {
    expect(referenceLineOf(adviceReference(comfortable(3)))?.walk).toBe('步行 6 分')
  })

  it('gives a departure time when there is slack to spare', () => {
    expect(referenceLineOf(adviceReference(comfortable(3)))?.conclusion).toBe('3 分钟后出门')
    expect(conclusionOf(comfortable(1))).toBe('1 分钟后出门')
  })

  it('says leaving now still works, without instructing the user', () => {
    expect(referenceLineOf(adviceReference(hurry()))?.conclusion).toBe('现在走还来得及')
  })

  it('says the bus is gone when the walk outlasts it', () => {
    expect(referenceLineOf(adviceReference(missed(null)))?.conclusion).toBe('赶不上这班')
  })

  it('names what missing it costs, from eta2 - eta1', () => {
    expect(conclusionOf(missed(12))).toBe('赶不上这班 · 下一班多等 12 分')
  })

  it('states each verdict differently, so no two states read alike', () => {
    const lines = [
      conclusionOf(comfortable(3)),
      conclusionOf(hurry()),
      conclusionOf(missed(null)),
      conclusionOf(missed(12)),
    ]
    expect(new Set(lines).size).toBe(lines.length)
  })
})

describe('the reference line names an unsaved anchor instead of pricing a walk', () => {
  it('points at the settings screen for the morning leg', () => {
    const line = referenceLineOf({ status: 'anchor-unset', anchor: 'home' })
    expect(line?.conclusion).toBe('未设置「家」位置 · 在「设置」中设置')
    // 不显示步行：此处的距离会是捏造的起点。
    expect(line?.walk).toBeNull()
  })

  it('names 公司 for the evening leg', () => {
    const line = referenceLineOf({ status: 'anchor-unset', anchor: 'work' })
    expect(line?.conclusion).toContain('公司')
    expect(line?.conclusion).toContain('设置')
  })
})

describe('no conclusion means no row, which is not the same as a comfortable one', () => {
  it('renders nothing when the server withheld the conclusion', () => {
    expect(referenceLineOf(null)).toBeNull()
    expect(referenceLineOf(undefined)).toBeNull()
  })

  it('never lets a missing value read as an answer', () => {
    // 「暂无数据」与「不用着急」是不同状态：一是沉默，一是已陈述的判决，该行不得混淆。
    expect(referenceLineOf(null)).not.toEqual(referenceLineOf(adviceReference(comfortable(3))))
  })
})

describe('the card keeps the reference row secondary and additive', () => {
  const card = readFileSync(
    fileURLToPath(new URL('../views/overview/components/line-mini-card.vue', import.meta.url)),
    'utf8',
  )

  it('renders the reference row once, and only when a conclusion exists', () => {
    expect(card.match(/v-if="referenceLine"/g)).toHaveLength(1)
  })

  it('places it after the arrivals it refers to, never in front of them', () => {
    const reference = card.indexOf('v-if="referenceLine"')
    const followUp = card.indexOf('v-if="primarySubsequent.length > 0"')
    expect(reference).toBeGreaterThan(followUp)
  })

  it('keeps it a step smaller than the headline minutes, with no truncation', () => {
    // 该行 12 px（text-xs）对 24 px 头条（text-2xl），且换行而非截断：次要不得等于不可读。
    const block = card.slice(card.indexOf('v-if="referenceLine"'), card.indexOf('v-if="referenceLine"') + 500)
    expect(block).toMatch(/text-xs/)
    expect(block).toMatch(/flex-wrap/)
    expect(block).not.toMatch(/text-2xl|font-black|truncate|line-clamp/)
  })

  it('gives the arrival minutes nothing to do with the reference row', () => {
    // 分钟由它们自己的块渲染：参考行不含分钟渲染、也不对其设门，故无法隐藏或压缩它所参考的列表。
    const block = card.slice(card.indexOf('v-if="referenceLine"'), card.indexOf('v-if="referenceLine"') + 500)
    expect(block).not.toContain('minutesOf')
    expect(block).not.toContain('primarySubsequent')
    // ……而头条 ETA 仍是卡片上最醒目的东西。
    expect(card).toMatch(/font-mono text-2xl font-black/)
  })
})
