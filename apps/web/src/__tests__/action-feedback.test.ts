import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ACTION_FEEDBACK,
  announceActionFeedback,
  feedbackTextOf,
  runWithFeedback,
} from '../action-feedback'
import type { FeedbackAction, FeedbackContext } from '../action-feedback'

/**
 * 用户按下的动作用一句话回答。
 *
 * 这一份守的是那一张**文案表**与它外面那一层：每个动作两种结局都说得出话、成功与被拒的色调相反、
 * 一次按下只说一次、以及「什么都没改变」的那一次什么都不说。它下面两段是同一件事的源码面：页面
 * 里没有第二处措辞，也没有第二种推送出口，且每一页的推送点数目恰好是它自己的写操作数。
 *
 * 提示库被替换掉：这里评判的是我们**推了什么**（那句话与那个色调），不是库内部的 DOM。
 */

const { pushed } = vi.hoisted(() => ({
  pushed: [] as Array<{ message: string, options: Record<string, unknown> }>,
}))

vi.mock('vue-sonner', () => ({
  toast: (message: string, options: Record<string, unknown> = {}) => {
    pushed.push({ message, options })
    return pushed.length
  },
}))

beforeEach(() => {
  pushed.length = 0
})

/** 表里全部动作。 */
const ACTIONS = Object.keys(ACTION_FEEDBACK) as FeedbackAction[]

/** 点名了对象的上下文 —— 每一个动作都说得出完整的一句。 */
const CONTEXT: FeedbackContext = { name: '52', landmark: '建国门', reason: 'denied' }

function messages(): string[] {
  return pushed.map(item => item.message)
}

function classOf(index: number): string {
  return String(pushed[index]!.options.class ?? '')
}

describe('每一个动作两种结局各有一句话', () => {
  it('表里每个动作都说得出一句成功与一句失败，且两者不同', () => {
    expect(ACTIONS.length).toBeGreaterThan(0)
    for (const action of ACTIONS) {
      const ok = feedbackTextOf(action, 'ok', CONTEXT)
      const fail = feedbackTextOf(action, 'fail', CONTEXT)
      expect(ok, `${action} has no success sentence`).not.toBe('')
      expect(fail, `${action} has no failure sentence`).not.toBe('')
      expect(fail, `${action} says the same thing either way`).not.toBe(ok)
    }
  })

  it('有对象就点名它，没有就不带 —— 而非留下一对空引号', () => {
    expect(feedbackTextOf('favorite-remove', 'ok', { name: '52' })).toBe('已取消关注 52')
    expect(feedbackTextOf('favorite-remove', 'ok')).toBe('已取消关注')
    expect(feedbackTextOf('chain-remove', 'ok', { name: '早上上班' })).toBe('已删除链路 早上上班')
  })

  it('定位的四种结局：取到、不支持、被拒、取不到或超时', () => {
    expect(feedbackTextOf('location', 'ok')).toBe('已获取位置')
    // 有地标就带上，没有就不带。
    expect(feedbackTextOf('location', 'ok', { landmark: '建国门' })).toBe('已获取位置 · 建国门')
    expect(feedbackTextOf('location', 'fail', { reason: 'unsupported' })).toBe('此浏览器不支持定位')
    expect(feedbackTextOf('location', 'fail', { reason: 'denied' })).toBe('定位权限被拒，请在系统设置里允许')
    expect(feedbackTextOf('location', 'fail', { reason: 'unavailable' })).toBe('暂时无法定位，请稍后再试')
    // 取不到与超时说的是同一件要用户做的事，故合成同一个原因。
    expect(feedbackTextOf('location', 'fail')).toBe('暂时无法定位，请稍后再试')
  })

  it('被拒的原因跟在表里那句话后面，除非它只是同一件事换个说法', async () => {
    // 服务端的契约消息很短，带上它才有可行动的内容。
    await expect(runWithFeedback('chain-save', () => Promise.reject(new Error('一条链路至少要有一段乘车段'))))
      .rejects.toThrow('一条链路至少要有一段乘车段')
    expect(messages()).toEqual(['链路保存失败 · 一条链路至少要有一段乘车段'])

    // 而 store 与界面自己的缺省消息是「同一件事换个说法」，故它不再说一遍。
    await expect(runWithFeedback('chain-save', () => Promise.reject(new Error('链路保存失败')))).rejects.toThrow()
    await expect(runWithFeedback('chain-save', () => Promise.reject(new Error('保存失败')))).rejects.toThrow()
    expect(messages().slice(1)).toEqual(['链路保存失败', '链路保存失败'])

    // 判据是整句就是那句缺省，而不是「含『失败』二字」：服务端把成因写在一句话里时，
    // 它正是最该带上的那一种。
    await expect(runWithFeedback('anchor-save', () => Promise.reject(
      new Error('家位置坐标为 (0, 0)，通常是定位失败，请重新定位'),
    ), { name: '家' })).rejects.toThrow()
    expect(messages().at(-1)).toBe('未能保存「家」的位置 · 家位置坐标为 (0, 0)，通常是定位失败，请重新定位')
  })
})

describe('一次按下推一次，结局自己退场', () => {
  it('成功：一条带着表里那句话的提示，色调是「成了」，且不设固定 id', async () => {
    await runWithFeedback('favorite-remove', async () => {}, { name: '52' })

    expect(messages()).toEqual(['已取消关注 52'])
    expect(classOf(0)).toContain('text-cyan-300')
    // 不给固定 id：连着两次成功也该各说一次。时长是库自己的默认值 —— 一次回答，说完就退场。
    expect(pushed[0]!.options.id).toBeUndefined()
    expect(pushed[0]!.options.duration).toBeUndefined()
  })

  it('被拒：一句带原因的提示，色调是「没成」，且原因原样重抛', async () => {
    const refusal = new Error('该关注不存在')

    await expect(runWithFeedback('favorite-remove', () => Promise.reject(refusal), { name: '52' }))
      .rejects.toBe(refusal)

    expect(messages()).toEqual(['取消关注失败 52 · 该关注不存在'])
    expect(classOf(0)).toContain('text-rose-300')
  })

  it('什么都没改变的那一次什么都不说', async () => {
    // 运行体解析为 false 意为这一次没有改变任何东西（该线路已被关注），界面自己那一处已经陈述了它。
    await runWithFeedback('favorite-add', async () => false, { name: '52' })
    expect(pushed).toHaveLength(0)

    // 而 void 与 true 都是「做成了」。
    await runWithFeedback('favorite-add', async () => true, { name: '52' })
    await runWithFeedback('favorite-reorder', async () => {})
    expect(messages()).toEqual(['已关注 52', '顺序已更新'])
  })

  it('同一个结局连着发生两次各说一次', async () => {
    announceActionFeedback('favorite-board-stop', 'ok')
    announceActionFeedback('favorite-board-stop', 'ok')

    expect(messages()).toEqual(['已保存上车点', '已保存上车点'])
  })
})

/**
 * 源码面。
 *
 * 本仓库没有 DOM 测试台，故「哪一页推不推话」这一半在这里按源码断言：一个动作要在屏幕上出现，
 * 只有经这一处接缝，故接缝在每一页出现的**次数**就是那一页的推送点数目。
 */
const SRC = fileURLToPath(new URL('..', import.meta.url))

/** 本目录下每个 `.ts`/`.vue`，含子目录；测试不在内。 */
function sourceFiles(directory: string, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {}
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue
      Object.assign(out, sourceFiles(join(directory, entry.name), name))
      continue
    }
    if (/\.(?:ts|vue)$/.test(entry.name)) {
      out[name] = readFileSync(join(directory, entry.name), 'utf8')
    }
  }
  return out
}

const FILES = sourceFiles(SRC)

/** 每一次经接缝推话的调用。import 那一行不带括号，故不在此列。 */
function seamCalls(source: string): number {
  return (source.match(/(?:runWithFeedback|announceActionFeedback)\(/g) ?? []).length
}

describe('文案表是唯一来源', () => {
  it('只有宿主与两处接缝认得提示库', () => {
    const withLibrary = Object.entries(FILES)
      .filter(([, source]) => source.includes('vue-sonner'))
      .map(([name]) => name)
      .sort()

    expect(withLibrary).toEqual(['App.vue', 'action-feedback.ts', 'refresh-toast.ts'])
  })

  it('表里的每一句话都只出现在表里：页面与 store 不自己措辞一次', () => {
    // 带上对象与原因，使每一句都是动作专属的那一句，而不是某个页面也会印的词，也不是 store
    // 自己的缺省错误消息（那些是「……失败」，与表里那句同族）。
    const context: FeedbackContext = {
      name: '52',
      reason: 'denied',
      landmark: '建国门',
      error: '服务端说',
    }

    for (const [name, source] of Object.entries(FILES)) {
      if (name === 'action-feedback.ts') continue
      for (const action of ACTIONS) {
        for (const kind of ['ok', 'fail'] as const) {
          const sentence = feedbackTextOf(action, kind, context)
          expect(source, `${name} hardcodes 「${sentence}」`).not.toContain(sentence)
        }
      }
    }
  })

  it('每一页的推送点数目恰好是它自己的写操作数：切换与导航一个都不推', () => {
    // 数出来的就是「这一页会推几种话」。多一处就是把某个看得见的切换也推了出去，少一处就是
    // 某个写操作又沉默了。
    const expected: Record<string, number> = {
      // 关注线路列表页：关注、顺序（列表页只放列表、搜索与拖动排序）。
      'views/settings/lines.vue': 2,
      // 关注线路编辑页：取消关注、上车点、方向。破坏性动作与两处字段写入都搬到了这一页。
      'views/settings/favorite-editor.vue': 2,
      // 链路：列表页只放列表与拖动排序（顺序），编辑页放保存与删除。
      // 「列表页 + 独立编辑页」把这三处写操作分在两页上，而数目仍是三。
      'views/settings/chains.vue': 1,
      'views/settings/chain-editor.vue': 2,
      // 位置锚点（保存）与通勤时段（保存）各一个写操作。
      'views/settings/anchor-detail.vue': 1,
      'views/settings/components/commute-hours-form.vue': 1,
      // 首页的置顶状态由操作栏与列表重排自己说，线路页只推上车点。
      'views/overview/index.vue': 0,
      'views/line-detail/index.vue': 0,
      // 五个结局（取到、不支持、被拒、取不到、开发模拟下取到）都在 store 里说。
      'stores/location.store.ts': 5,
      // 而下面这些一个都不推：它们的动作在屏幕上立刻看得见。
      // 目的页签、模式按钮、城市切换、报站板上的工具、刷新控件、以及 store 自己。
      'views/commute-chain/index.vue': 0,
      'views/line-detail/components/route-board.vue': 0,
      'components/city-switcher/main.vue': 0,
      'components/refresh-control/main.vue': 0,
      'stores/transit.store.ts': 0,
      'stores/city.store.ts': 0,
    }

    for (const [name, count] of Object.entries(expected)) {
      expect(FILES[name], `${name} is missing`).toBeDefined()
      expect(seamCalls(FILES[name]!), `${name} pushes a different number of outcomes`).toBe(count)
    }
  })
})
