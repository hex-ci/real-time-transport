import { describe, expect, it } from 'vitest'
import { anchorForPurpose } from '@real-time-transport/shared'
import { anchorForPurpose as webAnchorForPurpose, emptyStateOf } from '../empty-state'
import { anchorUnsetSentenceOf } from '../refusal'

/**
 * 页面的空态：本目的没有任何记录。
 *
 * 规则是空屏只点名用户**可行动**的成因，且该成因不被另一个掩盖。这里可同时为真两个事实——目的
 * 没有链路，以及链路将要起步的锚点从未保存——两者现在都有其背后的屏幕（设置的位置锚点页与
 * 通勤链路页），故锚点的事实先说：从已保存锚点记录的链路没有步行时间，那是必须先做的修复。
 *
 * 第三种状态是本页必须小心的：**失败**的设置读取不是「锚点缺失」。不得对没人读过的行作任何断言，
 * 空态于是只说它真正知道的——链路事实，而它的屏幕对锚点不作任何方向的断言。
 */

describe('an empty purpose names the cause the user can act on', () => {
  it('sends them to 设置 when the anchor a chain would start from was never saved', () => {
    const view = emptyStateOf({ purpose: 'morning', anchorSaved: false })
    expect(view.headline).toBe('这个时段还没有换乘链')
    // F1 对同一事实的同一句话，逐字相同：两个读同一设置行的特性共用一个词。
    expect(view.detail).toBe(anchorUnsetSentenceOf('home'))
    expect(view.detail).toBe('未设置「家」位置 · 在「设置」中设置')
    expect(view.action).toBe('settings')
  })

  it('names the anchor the purpose actually starts from', () => {
    expect(emptyStateOf({ purpose: 'evening', anchorSaved: false }).detail).toContain('公司')
    expect(anchorForPurpose('morning')).toBe('home')
    expect(anchorForPurpose('evening')).toBe('work')
  })

  it('reads the one derivation the contract exports, rather than a second copy of it', () => {
    // 推导只有一处：本页导出的那个函数**就是** shared 的那一个（同一个函数对象）。
    // 复制一份实现——哪怕逐字相同——会让两侧在此分开，而运行时的行为差异要到某次改动才显形。
    expect(webAnchorForPurpose).toBe(anchorForPurpose)
    expect(webAnchorForPurpose('evening')).toBe('work')
  })

  it('states the anchor fact beside the chain fact rather than in place of it', () => {
    const view = emptyStateOf({ purpose: 'morning', anchorSaved: false })
    expect(view.headline).toContain('换乘链')
    expect(view.detail).not.toBeNull()
  })
})

describe('an anchor state nobody read is claimed neither way', () => {
  it('says nothing about the anchor when the settings read failed, and offers the screen that claims nothing about it', () => {
    const view = emptyStateOf({ purpose: 'morning', anchorSaved: null })
    expect(view.detail).not.toContain('未设置')
    // 录制页不是对锚点行的断言：它是记录链路之处，无论那行持有什么，
    // 故提供它仍对无人读过的那件事保持沉默。
    expect(view.action).toBe('chains')
    expect(view.headline).toBe('这个时段还没有换乘链')
  })

  it('never reports an unread anchor state as a missing one', () => {
    const unread = emptyStateOf({ purpose: 'evening', anchorSaved: null })

    // 否定不断定值：`not.toBe('settings')` 对 'chains'、对 null、以及对后续改动可能引入的任意
    // 无效值都成立，故 action 按其已落地行为的确切值断言。
    expect(unread.action).toBe('chains')
    // 且对锚点不作任何断言：detail 与链路构成句逐字相同，锚点自己的措辞不出现其中。
    expect(unread.detail).toBe('换乘链由使用者逐段录入：线路 + 上车站 + 下车站')
    expect(unread.detail).not.toContain('未设置')
    expect(unread.detail).not.toContain('位置')
    // 未读的行与已保存的行因此读起来一样，这是刻意的：两者都不得对本页未读的设置行作任何断言，
    // 锚点事实只在被读取**且**发现缺失时才陈述。
    expect(unread).toEqual(emptyStateOf({ purpose: 'evening', anchorSaved: true }))
  })
})

describe('with the anchor in place the empty state still guides', () => {
  it('states what a chain is made of AND names the screen that does it — the surface exists now', () => {
    const view = emptyStateOf({ purpose: 'morning', anchorSaved: true })
    expect(view.detail).toBe('换乘链由使用者逐段录入：线路 + 上车站 + 下车站')
    expect(view.action).toBe('chains')
  })
})
