import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseCongestion } from '../providers/chelaile.js'

/**
 * F12：拥挤级别读的是上游拥挤度标签自身的 `title`，按精确相等匹配。
 * 标签里别的字段都不是证据：不是键里的数字，不是 `sort`，不是 `dispatch`。
 *
 * 查表用标签而不是枚举键：键的枚举按构造就不可能完整 —— 没被采样到的
 * 键会被静默降级，即使它的 title 就写着级别。
 *
 * 否定形式是它自己的精确字符串：`不拥挤` 按自身匹配，绝不当成其中含有
 * 的「拥挤」。
 */

const crowdingTag = (imageUrlKey: string, title: string) =>
  ({ imageUrlKey, title, sort: 5, dispatch: false })

const accessibleTag = { imageUrlKey: '无障碍', title: '无障碍', sort: 1, dispatch: false }

describe('parseCongestion (chelaile busTagList): the upstream label is the level', () => {
  it('maps the three measured (key, title) pairs the live upstream served', () => {
    expect(parseCongestion([crowdingTag('拥挤度_1', '不拥挤')])).toBe('low')
    expect(parseCongestion([crowdingTag('拥挤度_3', '拥挤')])).toBe('high')
    expect(parseCongestion([crowdingTag('拥挤度_5', '拥挤')])).toBe('high')
  })

  it('maps a tag key it has never seen, on the label alone', () => {
    // 类别钉：映射必须对任何样本都没产出过的标签成立 —— 这正是
    // 读标签而不是枚举键的意义。
    expect(parseCongestion([crowdingTag('拥挤度_9', '拥挤')])).toBe('high')
    expect(parseCongestion([crowdingTag('拥挤度_9', '不拥挤')])).toBe('low')
    // 键甚至不必看起来像拥挤度键：信号在标签上。
    expect(parseCongestion([crowdingTag('车厢状态', '拥挤')])).toBe('high')
    expect(parseCongestion([crowdingTag('车厢状态', '不拥挤')])).toBe('low')
  })

  it('leaves a title nobody has measured unknown, however the key is named', () => {
    for (const title of ['适中', '严重拥堵', '舒适', '畅通', '']) {
      expect(parseCongestion([crowdingTag('拥挤度_9', title)])).toBe('unknown')
      expect(parseCongestion([crowdingTag('拥挤度_1', title)])).toBe('unknown')
      expect(parseCongestion([crowdingTag('拥挤度_5', title)])).toBe('unknown')
    }
  })

  it('reads exact titles only, so 「不拥挤」 is never read as 「拥挤」', () => {
    expect(parseCongestion([crowdingTag('拥挤度_1', '不拥挤')])).toBe('low')
    expect(parseCongestion([crowdingTag('拥挤度_5', '不拥挤')])).toBe('low')
    // 近似命中的都不是那个标题：不做子串、不做前缀、不做 trim。
    for (const title of ['不 拥挤', '很拥挤', '拥挤 ', ' 拥挤', '不拥挤啊', '擁擠']) {
      expect(parseCongestion([crowdingTag('拥挤度_5', title)])).toBe('unknown')
    }
  })

  it('never infers a level from the key number, sort or dispatch', () => {
    // 键是实测过的、但 title 说的是没测过的词，那就不是读数。
    expect(parseCongestion([crowdingTag('拥挤度_1', '畅行')])).toBe('unknown')
    expect(parseCongestion([{ imageUrlKey: '拥挤度_3', title: '畅行', sort: 5, dispatch: true }])).toBe('unknown')
    expect(parseCongestion([{ imageUrlKey: '拥挤度_9', title: '畅行', sort: 1, dispatch: false }])).toBe('unknown')
  })

  it('picks the crowding tag by its known title, not by position', () => {
    expect(parseCongestion([accessibleTag, crowdingTag('拥挤度_5', '拥挤')])).toBe('high')
    expect(parseCongestion([accessibleTag, crowdingTag('拥挤度_5', '不拥挤')])).toBe('low')
    // 没人测量过的标签，永远不遮挡它后面的已知标题。
    expect(parseCongestion([crowdingTag('拥挤度_9', '舒适'), crowdingTag('拥挤度_5', '拥挤')])).toBe('high')
    // 一辆车带两个拥挤度标签在任何样本之外：先到的那个标签胜出，
    // 两种情况都是读数。
    expect(parseCongestion([crowdingTag('拥挤度_1', '不拥挤'), crowdingTag('拥挤度_5', '拥挤')])).toBe('low')
    expect(parseCongestion([crowdingTag('拥挤度_5', '拥挤'), crowdingTag('拥挤度_1', '不拥挤')])).toBe('high')
  })

  it('reports unknown when the tag list carries no crowding reading', () => {
    expect(parseCongestion(undefined)).toBe('unknown')
    expect(parseCongestion([])).toBe('unknown')
    expect(parseCongestion([{ sort: 5 }])).toBe('unknown')
    // 完全没有 title 的标签什么都不说，哪怕键是拥挤度键。
    expect(parseCongestion([{ imageUrlKey: '拥挤度_5' }])).toBe('unknown')
    expect(parseCongestion([{ imageUrlKey: '拥挤度_5', sort: 5, dispatch: false }])).toBe('unknown')
    // 只有非拥挤那个标签：无障碍不是拥挤读数。
    expect(parseCongestion([accessibleTag])).toBe('unknown')
    expect(parseCongestion([{ imageUrlKey: '空调车', title: '空调车' }])).toBe('unknown')
  })
})

describe('the matcher is an exact-title table, never copy matching', () => {
  const SOURCE = readFileSync(
    fileURLToPath(new URL('../providers/chelaile.ts', import.meta.url)),
    'utf8',
  )
  const body = SOURCE.slice(
    SOURCE.indexOf('export function parseCongestion'),
    SOURCE.indexOf('function holdsLineRecord'),
  )

  it('contains no substring, prefix, suffix or regex match on the tag title', () => {
    expect(body.length).toBeGreaterThan(0)
    for (const loose of ['.includes(', '.startsWith(', '.endsWith(', '.match(', 'RegExp']) {
      expect(body, `the crowding matcher matches copy via ${loose}`).not.toContain(loose)
    }
  })
})
