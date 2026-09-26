import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * 站台屏上的 F3/F4：请求失败的行把该失败只说**一次**。
 *
 * 失败曾以一个展示用词为键。视图设 `statusText: '离线'`，数字列按 `item.statusText === '离线'`
 * 分支印「无法获取 / 数据暂不可用」，而拥挤度芯片渲染同一字段——于是**同一**行在一列说「无法获取」、
 * 在另一列说「离线」：一个事实两个词，并在芯片字段下次复用时等着第三个词。失败现在是该行携带的具名
 * 状态，芯片的标签来自拥挤等级，故数字列拥有失败，芯片陈述另一个事实。
 *
 * 报告板是只跑浏览器的 SFC，本仓库没有 DOM 装置，故接线按源码断言——与 congestion.test.ts 检查其绑定的方式相同。
 *
 * 行的字段现在在 `departure-row.ts` 中决定，故事实取自那里；视图仍欠的是：它交给构造器一个失败状态而非一条消息。
 */

const board = readFileSync(
  fileURLToPath(new URL('../components/departure-board.vue', import.meta.url)),
  'utf8',
)
const view = readFileSync(
  fileURLToPath(new URL('../index.vue', import.meta.url)),
  'utf8',
)
const rows = readFileSync(
  fileURLToPath(new URL('../departure-row.ts', import.meta.url)),
  'utf8',
)

describe('the failed-request row states its failure once', () => {
  it('keys the failure off a named state, never off a word meant for a human', () => {
    // 数字列按该行携带的状态分支……
    expect(board).toContain('item.unavailable')
    // ……而它曾据以分支的哨兵值无处留存。
    expect(board).not.toContain('离线')
    expect(view).not.toContain('离线')
    expect(rows).not.toContain('离线')
    // 携带渲染用词的那个字段也随之消失，故任何分支若再以字符串为键，都必须在此声明。
    expect(board).not.toContain('statusText')
    expect(view).not.toContain('statusText')
    expect(rows).not.toContain('statusText')
  })

  it('states the failure in the numbers column, in one wording', () => {
    expect(board.match(/无法获取/g)?.length, 'the failure word is stated more than once')
      .toBe(1)
    expect(board.match(/数据暂不可用/g)?.length).toBe(1)
  })

  it('does not echo the failure on the chip — the chip is the crowding verdict', () => {
    expect(board).toContain('congestionLabel(item.congestion)')
  })

  it('marks exactly the failed row as unavailable', () => {
    // 一个状态，设在行构造器里一次。有车的行与有运营事实的行都有答案；
    // 只有请求失败的那行不可用。
    expect(rows.match(/unavailable:\s*true/g)?.length).toBe(1)
    expect(rows.match(/unavailable:\s*false/g)?.length).toBe(2)
  })
})
