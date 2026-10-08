import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

describe('Vue TransitionGroup 接线', () => {
  function gridSource(): string {
    return readFileSync(
      fileURLToPath(new URL('../../../views/overview/components/card-grid.vue', import.meta.url)),
      'utf-8',
    )
  }

  it('使用带稳定关注 id key 的 TransitionGroup，让 Vue 接管列表 move', () => {
    const grid = gridSource()
    expect(grid).toMatch(/<TransitionGroup[\s\S]*?name="favorite-reorder"/)
    expect(grid).toMatch(/:key="line\.favoriteId \?\? line\.detailHref"/)
    expect(grid).toMatch(/<div[\s\S]*?:data-favorite-id="line\.favoriteId"[\s\S]*?class="min-w-0"/)
    expect(grid).toContain('</TransitionGroup>')
  })

  it('不再保留手动 FLIP：没有更新前量矩形、没有 WAAPI、没有额外的 transform 接线', () => {
    const grid = gridSource()
    expect(grid).not.toMatch(/onBeforeUpdate|onUpdated|captureCards|playReorder|motionTargetId|\.animate\(/)
    const page = readFileSync(
      fileURLToPath(new URL('../../../views/overview/index.vue', import.meta.url)),
      'utf-8',
    )
    expect(page).not.toContain('pinMotionTargetId')
  })

  it('move 样式只过渡 transform，且尊重减少动画', () => {
    const grid = gridSource()
    // 只许过渡 transform 这一个属性；时长与缓动是取值细节，别把字面量钉死。
    expect(grid).toMatch(/:deep\(\.favorite-reorder-move\)\s*\{\s*transition: transform \S+ cubic-bezier\(0\.22, 0\.61, 0\.36, 1\);/)
    expect(grid).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?:deep\(\.favorite-reorder-move\)[\s\S]*?transition: none/)
  })
})

describe('接线：每张卡保有稳定的关注 id', () => {
  it('网格给每张卡片带上关注 id，供交互与端到端验收按身份读取', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../../views/overview/components/card-grid.vue', import.meta.url)),
      'utf-8',
    )
    expect(source).toContain(':data-favorite-id="line.favoriteId"')
  })
})
