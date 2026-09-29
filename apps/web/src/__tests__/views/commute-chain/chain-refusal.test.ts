import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DataSourceTypeSchema } from '@real-time-transport/shared'
import { REFUSAL_SENTENCE, anchorNameOf, anchorUnsetSentenceOf, refusalOf } from '../refusal'
import { READ_AT, OPERATING, refusal } from './chain-fixtures'

/**
 * 页面可收到的每个「不给结论」代码，以及它得到的**唯一**一句话。
 *
 * 没有句子的代码是个洞；只对某代码的部分成因成立的句子，对其余成因就是谎。故代码集不在此凭记忆抄出——
 * 它取自契约自己的 `ChainNoConclusionReason` 联合，文案表是对该联合的全量 `Record`，使上游新增的代码
 * 先是**编译**错误，再才是测试失败。
 *
 * 下方守住两个已记录的坑：
 *
 *  - `connection-unpriced` 覆盖四个在**持久性**上不同的成因——未放置的站是永久的上游数据缺口，
 *    未定价的路径是暂时的——故其句子只陈述该代码所携带的事实、不承诺重试；
 *  - 任意两个代码不得用彼此的措辞作答：「暂时没有开往这一站的车」不是「这条线停运」，我们自己的
 *    读取失败也不是服务为空。
 */

/** 契约自己的联合，从声明它的源码读出。 */
function declaredReasons(): string[] {
  const source = readFileSync(
    fileURLToPath(new URL('../../../../../../packages/shared/src/commute-chain.ts', import.meta.url)),
    'utf8',
  )
  const block = /export type ChainNoConclusionReason\s*=([\s\S]*?)\n\n/.exec(source)
  expect(block, 'the contract no longer declares ChainNoConclusionReason').not.toBeNull()
  return [...block![1].matchAll(/'([a-z-]+)'/g)].map(match => match[1]!)
}

/** 每个代码一句话，锚点是其中唯一需要参数的。 */
function sentencesOf(): Array<[string, string]> {
  return Object.entries(REFUSAL_SENTENCE).map(([reason, copy]) => [reason, copy({ anchor: 'home' })])
}

describe('every refusal code the contract declares has exactly one sentence', () => {
  it('covers the contract\'s whole set, and nothing that is not in it', () => {
    const declared = declaredReasons()
    expect(declared.length).toBeGreaterThan(0)
    expect(Object.keys(REFUSAL_SENTENCE).sort()).toEqual([...declared].sort())
  })

  it('gives each code words of its own, so no two codes read alike', () => {
    const sentences = sentencesOf().map(([, sentence]) => sentence)
    expect(new Set(sentences).size).toBe(sentences.length)
  })

  it('states the fact and stops: no sentence is a sentence about a different code', () => {
    // 「停运」是缩影式的坑：空的到站屏读数是「没有车正在开往这一站」，而一天已结束的线路由其旁的
    // 运营状态陈述——绝不可把一个变成另一个。
    for (const [reason, sentence] of sentencesOf()) {
      expect(sentence, reason).not.toMatch(/停运|停驶|取消/)
    }
  })
})

describe('an unpriced connection promises no retry it cannot keep', () => {
  it('states only that the connection has no duration', () => {
    const sentence = REFUSAL_SENTENCE['connection-unpriced']({ anchor: 'home' })
    expect(sentence).toBe('这一段接驳的时长取不到，无法判断余量')
    // 其成因中两个是永久的（站表携带却没有坐标的站，上游可能永不陈述）而一个是暂时的（路径服务恰好
    // 未定价的路径）。「稍后重试」对后者为真、对前者为假，而该行无法告诉页面是哪一个触发——故不说。
    expect(sentence).not.toMatch(/重试|稍后|再试|稍候|过一会儿/)
  })

  it('promises no code a retry', () => {
    for (const [reason, sentence] of sentencesOf()) {
      expect(sentence, reason).not.toMatch(/重试|稍后|再试|稍候|过一会儿/)
    }
  })
})

describe('a sentence is true of every cause its code can carry', () => {
  it('states no ordering for the code whose causes include two ends that are one station', () => {
    // `leg-recorded-backwards` 有两个已记录的成因：下车站不在下游的公交段，以及两端为**同一站**的
    // 任意段。后者没有顺序可言，故点名顺序的句子对其自身集合的一部分为假——而该行无法告诉页面是哪个
    // 成因，措辞必须对两者都成立。
    const sentence = REFUSAL_SENTENCE['leg-recorded-backwards']({ anchor: 'home' })
    expect(sentence).not.toMatch(/顺序|颠倒|反向|反了|录反|先后|前后|站序|倒/)
    // ……且仍陈述两个成因共有的事实：本段走不通。
    expect(sentence).toMatch(/走不通|乘不了|不能乘车|无法乘车/)
  })

  it('states the same-station case as the ordering one, in one sentence', () => {
    // 一行所印的句子不取决于成因（该代码不带第二个字段），故对两者都为真的唯一方式是两者都不专指——
    // 这正是上述措辞覆盖整个契约的原因。
    const sentence = REFUSAL_SENTENCE['leg-recorded-backwards']({ anchor: 'home' })
    expect(sentence).toBe('这条链路有乘车段的上车站与下车站填得走不通')
  })
})

describe('no sentence names a data source or an internal mechanism', () => {
  it('keeps every vendor out of the wording', () => {
    // 来源名取自契约自己的枚举而非此处维护的列表，故新来源一经声明即被覆盖。
    for (const [reason, sentence] of sentencesOf()) {
      for (const source of DataSourceTypeSchema.options) {
        expect(sentence, `${reason} names ${source}`).not.toContain(source)
      }
    }
  })
})

describe('an empty answer about the service is governed by the service state', () => {
  const legOf = (extra: Record<string, unknown> = {}) => ({
    leg: { seq: 1, lineId: 'bus_027_1', lineName: '快线 1 路' },
    ...extra,
  })

  it('states the arrival fact, and F3\'s own service state beside it', () => {
    const view = refusalOf({
      deduction: refusal('no-vehicle', legOf({ updatedAt: READ_AT, operatingStatus: { ...OPERATING, state: 'after_last' } })),
      anchor: 'home',
    })
    expect(view.sentence).toBe('暂时没有开往这一站的车')
    // 「已过末班」是空屏不得被给成「暂无来车」的答案，它随到站事实并列而非取代它：
    // 两者是不同的事实，任一不得代表另一个。
    expect(view.serviceText).toBe('已过末班 · 末班 23:00')
  })

  it('keeps the four service states apart, in F3\'s words', () => {
    const states = [
      { ...OPERATING, state: 'before_first', firstDeparture: '05:30' },
      { ...OPERATING, state: 'operating' },
      { ...OPERATING, state: 'after_last', lastDeparture: '23:00' },
      { ...OPERATING, state: 'unknown', firstDeparture: null, lastDeparture: null },
    ] as const
    const texts = states.map(status => refusalOf({
      deduction: refusal('no-vehicle', legOf({ updatedAt: READ_AT, operatingStatus: status })),
      anchor: 'home',
    }).serviceText)
    expect(texts).toEqual([
      '未到首班 · 首班 05:30',
      '运营中 · 暂无来车',
      '已过末班 · 末班 23:00',
      '运营时间未知 · 暂无来车',
    ])
    expect(new Set(texts).size).toBe(4)
  })

  it('says nothing about the service day beside a refusal about our own reading', () => {
    // 「数据太旧」是关于读取的事实，其旁的运营状态会被读成它的成因——
    // 这正是这两种事实不得混淆之处。
    for (const reason of ['stale', 'degraded', 'provenance-unknown', 'inconsistent-live', 'no-live'] as const) {
      const view = refusalOf({
        deduction: refusal(reason, legOf({ updatedAt: READ_AT, operatingStatus: { ...OPERATING, state: 'after_last' } })),
        anchor: 'home',
      })
      expect(view.serviceText, reason).toBeNull()
    }
  })

  it('states the service state when the arrival fact is about vehicles that had already gone', () => {
    for (const reason of ['no-vehicle-after-connection', 'no-vehicle-at-departure'] as const) {
      const view = refusalOf({
        deduction: refusal(reason, legOf({ updatedAt: READ_AT, operatingStatus: OPERATING })),
        anchor: 'home',
      })
      expect(view.serviceText, reason).toBe('运营中 · 暂无来车')
    }
  })
})

describe('the cause the user can act on is the anchor, and nothing may take its place', () => {
  it('sends an unsaved anchor to the screen that owns it, in F1\'s own words', () => {
    const view = refusalOf({
      deduction: refusal('anchor-unset', { leg: { seq: 0, lineId: 'bus_027_1', lineName: '快线 1 路' } }),
      anchor: 'home',
    })
    expect(view.sentence).toBe('未设置「家」位置 · 在「设置」中设置')
    expect(view.sentence).toBe(anchorUnsetSentenceOf('home'))
    expect(view.action).toBe('settings')
  })

  it('names the chain\'s own anchor, not a fixed one', () => {
    const view = refusalOf({ deduction: refusal('anchor-unset'), anchor: 'work' })
    expect(view.sentence).toContain('公司')
    expect(view.sentence).not.toContain('家」')
  })

  it('keeps the anchor\'s affordance when the leg was never read', () => {
    // 引擎在读取某段的线路、定位站点**之前**就定下锚点，故这就是线路读不出的链路到达的状态：
    // 用户被告知他们能修复的成因，而非修不了的。页面不得把它弱化成线路问题，其动作也不得取决于任何其他字段。
    const unread = refusalOf({
      deduction: refusal('anchor-unset', { leg: { seq: 0, lineId: 'bus_027_1', lineName: '快线 1 路' } }),
      anchor: 'home',
    })
    expect(unread.serviceText).toBeNull()
    expect(unread.action).toBe('settings')
    // ……而没有段时，句子与其动作不变。
    const noLeg = refusalOf({ deduction: refusal('anchor-unset'), anchor: 'home' })
    expect(noLeg.legText).toBeNull()
    expect(noLeg.sentence).toBe(unread.sentence)
    expect(noLeg.action).toBe('settings')
  })

  it('never lets the other connection code offer the anchor\'s action', () => {
    const generic = refusalOf({
      deduction: refusal('connection-unpriced', { leg: { seq: 1, lineId: 'bus_027_1', lineName: '快线 1 路' } }),
      anchor: 'home',
    })
    expect(generic.action).toBeNull()
    expect(generic.sentence).not.toBe(REFUSAL_SENTENCE['anchor-unset']({ anchor: 'home' }))
  })

  it('offers no action for a cause that leaves the user none', () => {
    for (const reason of declaredReasons()) {
      const view = refusalOf({ deduction: refusal(reason as never, {}), anchor: 'home' })
      expect(view.action, reason).toBe(reason === 'anchor-unset' ? 'settings' : null)
    }
  })
})

describe('a refusal states which transfer refused', () => {
  it('names the leg by its position and its line', () => {
    const view = refusalOf({
      deduction: refusal('no-vehicle', {
        leg: { seq: 1, lineId: 'bus_027_1', lineName: '快线 1 路' },
        updatedAt: READ_AT,
        operatingStatus: OPERATING,
      }),
      anchor: 'home',
    })
    expect(view.legText).toBe('第 2 段 · 快线 1 路')
  })

  it('has no leg to name when the chain carries none', () => {
    const view = refusalOf({ deduction: refusal('no-legs'), anchor: 'home' })
    expect(view.legText).toBeNull()
  })

  it('carries no field the card never renders (a shape guard: a dead field is not left behind)', () => {
    // 取得读取的时刻**不在**这里：卡片从它为两类答案都渲染的读取行印它，而同一时刻的第二份副本是
    // 没有视图读的字段。`reason` 是引擎的代码本身——页面绝不改写它。
    const view = refusalOf({
      deduction: refusal('no-vehicle', {
        leg: { seq: 1, lineId: 'bus_027_1', lineName: '快线 1 路' },
        updatedAt: READ_AT,
        operatingStatus: OPERATING,
      }),
      anchor: 'home',
    })
    expect(Object.keys(view).sort()).toEqual(['action', 'legText', 'reason', 'sentence', 'serviceText'])
  })
})

describe('a code this build does not know is stated as no conclusion, never as a guess', () => {
  it('invents no cause and no action for it', () => {
    const view = refusalOf({ deduction: refusal('a-code-from-a-newer-server' as never), anchor: 'home' })
    expect(view.sentence).toBe('这条链路无法给出结论')
    expect(view.action).toBeNull()
    expect(view.serviceText).toBeNull()
  })
})

describe('the anchor vocabulary is F1\'s', () => {
  it('names the two stored anchors the way the reference line does', () => {
    expect(anchorNameOf('home')).toBe('家')
    expect(anchorNameOf('work')).toBe('公司')
  })
})
