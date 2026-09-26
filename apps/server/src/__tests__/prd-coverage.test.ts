import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * PRD 的功能点清单与覆盖矩阵必须一一对上。
 *
 * `docs/PRD.md` 用 `### F<n> · 标题` 声明功能点；`tests/prd-coverage.md` 是覆盖矩阵。
 * PRD 加了一个功能点而矩阵忘了更新，这里要变红 —— 否则矩阵会慢慢腐烂成一份好看的旧账。
 *
 * 解析与断言都做成纯函数，钉子拿假输入直接调它们：解析器坏掉时，「矩阵真的漏了」与
 * 「什么都没解析到」必须是两种不同的结果，不能都是安静地绿。
 */

const REPO_ROOT = new URL('../../../../', import.meta.url)
const PRD_PATH = fileURLToPath(new URL('docs/PRD.md', REPO_ROOT))
const MATRIX_PATH = fileURLToPath(new URL('tests/prd-coverage.md', REPO_ROOT))

/** PRD 里声明的功能点编号：`### F5 · 站台聚合大屏` → `F5`。 */
export function prdFeatureIds(markdown: string): string[] {
  const ids: string[] = []
  for (const line of markdown.split('\n')) {
    const matched = /^### (F\d+)\b/.exec(line)
    if (matched) ids.push(matched[1]!)
  }
  return ids
}

/**
 * 矩阵里点过名的编号。写成 `F8` 就算点名 —— 矩阵写「F5 未覆盖」也是一种覆盖声明，
 * 本守卫问的是「有没有被认领」，不是「有没有被证明」。
 */
export function matrixFeatureIds(markdown: string): Set<string> {
  const ids = new Set<string>()
  for (const matched of markdown.matchAll(/\bF(\d+)\b/g)) ids.add(`F${matched[1]}`)
  return ids
}

/** PRD 有、矩阵却一个字没提的编号。 */
export function uncoveredFeatureIds(prd: string, matrix: string): string[] {
  const mentioned = matrixFeatureIds(matrix)
  return prdFeatureIds(prd).filter(id => !mentioned.has(id))
}

/** 读文件；读不到时报出是哪一个，不把它变成「解析到 0 个编号」。 */
function read(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  }
  catch (err) {
    throw new Error(`守卫读不到 ${path}：${(err as Error).message}`, { cause: err })
  }
}

describe('PRD 的 F 清单都在覆盖矩阵里', () => {
  it('PRD 的每一个 F 编号都在 tests/prd-coverage.md 里点过名', () => {
    const missing = uncoveredFeatureIds(read(PRD_PATH), read(MATRIX_PATH))
    expect(missing, `这些功能点还没进覆盖矩阵：${missing.join(', ') || '（无）'}`).toEqual([])
  })

  it('守卫不是空跑：PRD 真的解析出了编号，且没有重号', () => {
    const ids = prdFeatureIds(read(PRD_PATH))
    expect(ids, '一个 F 都没解析到，守卫自己失效了').toBeInstanceOf(Array)
    expect(ids.length, '一个 F 都没解析到，守卫自己失效了').toBeGreaterThanOrEqual(13)
    expect(new Set(ids).size, `PRD 里有重号的功能点：${ids.join(', ')}`).toBe(ids.length)
  })

  it('钉子：矩阵漏掉一个 F 时必须点名它（否则守卫是个摆设）', () => {
    const prd = ['### F1 · 甲', '### F2 · 乙', '### F3 · 丙', ''].join('\n')
    // 漏了 F3 —— 守卫必须指出是 F3，不能只说「有漏」。
    expect(uncoveredFeatureIds(prd, 'F1 与 F2 都写进矩阵了')).toEqual(['F3'])
    // 正对照：三个都点名时为空 —— 钉子本身不是「永远报错」。
    expect(uncoveredFeatureIds(prd, 'F1、F2、F3 全覆盖')).toEqual([])
    // 非 `### ` 开头的引用不算声明：正文里的 `F9` 不产生功能点编号。
    expect(prdFeatureIds('正文提到 F9，但没有 `### ` 开头的行\n')).toEqual([])
  })
})
