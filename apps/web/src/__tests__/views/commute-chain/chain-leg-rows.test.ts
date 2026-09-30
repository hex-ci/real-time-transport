import { afterEach, describe, expect, it, vi } from 'vitest'
import { chainView, conclusion, leg } from './chain-fixtures'
import { mountChainPage } from './chain-page-harness'

/**
 * 一条链路的段数不是读取侧被隐含限制的维度：**一段一行**，几段就几行。
 *
 * 录入屏有自己的上限（`MAX_CHAIN_LEGS`），而读取侧照收到的走。这一条钉住后半句 ——
 * 哪天有人把渲染写成「首段 + 换乘段」两块，或者把某一段吃掉，这里就会红。
 * 上界那一边由 `packages/shared` 的推演用例覆盖（六段照样得出结论、最紧的那次可以落在第三段）。
 */

afterEach(() => {
  vi.unstubAllGlobals()
})

/** 段行：`transfer-row.vue` 的那一个 `li`。 */
const isLegRow = (node: any) => node.tag === 'li'
  && String(node.props.class ?? '').includes('bg-slate-950/60')

async function pageWithLegs(legs: ReturnType<typeof leg>[]) {
  const page = await mountChainPage({
    routes: [/commute-chains\/deductions/, () => ({ success: true, data: { purpose: 'morning', chains: [chainView(conclusion(legs))] } })],
  })
  return page
}

describe('链路页按段渲染', () => {
  it('三段就是三行，且最紧的那次可以落在最后一段', async () => {
    const page = await pageWithLegs([
      leg({ seq: 0, lineName: '快线 1 路', marginMinutes: 9 }),
      leg({ seq: 1, lineName: '地铁 88 号线', marginMinutes: 5 }),
      leg({ seq: 2, lineName: '快线 9 路', marginMinutes: 2 }),
    ])

    const rows = page.nodes(isLegRow)
    expect(rows).toHaveLength(3)
    expect(rows.map(row => page.textOf(row))).toEqual([
      expect.stringContaining('快线 1 路'),
      expect.stringContaining('地铁 88 号线'),
      expect.stringContaining('快线 9 路'),
    ])
    // 最紧的是第三段：结论那一句必须说到它，而不是停在第二段。
    expect(page.text()).toContain('最紧的是第 3 段')

    page.unmount()
  })

  it('六段也是六行 —— 读取侧的段数没有上限', async () => {
    const names = ['快线 1 路', '地铁 88 号线', '快线 9 路', '地铁 7 号线', '快线 3 路', '地铁 2 号线']
    const page = await pageWithLegs(names.map((lineName, seq) => leg({ seq, lineName, marginMinutes: 4 })))

    const rows = page.nodes(isLegRow)
    expect(rows).toHaveLength(6)
    for (const [index, name] of names.entries()) {
      expect(page.textOf(rows[index]!), `第 ${index + 1} 行`).toContain(name)
    }

    page.unmount()
  })
})
