import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * 本包的类型检查范围，对着定义它的配置守住。
 *
 * `tsconfig.app.json` 排除本包的测试文件——`src/` 下每个 `__tests__` 目录——故 `vue-tsc --build`
 * 从不类型检查它们。该排除是刻意的并保持：测试由 Vitest 按其运行器给出的类型转换与运行，不由应用构建。
 * 可能无声丢失的是**理由**——不带理由的排除读起来像疏漏，下一位读者会重新纳入测试、弄红一个没人改过的构建、
 * 再把排除拿掉。故配置必须在原处说明，且作为常驻约束而非历史陈述。
 *
 * 这些是结构性检查——对一行配置的存在性与措辞检查，对一个没有运行时会读取的设置所能说的全部。
 * 它们刻意放松于措辞、严格于事实：测试仍被排除，文件声明这是刻意的，它说明代价（那些文件不被检查），
 * 且它不把自己描述成临时状态或待办。
 *
 * 本文件位于 `src/` 之外，理由与 `installability.test.ts` 相同：它验证包配置表面而非模块。
 */

const tsconfig = readFileSync(
  fileURLToPath(new URL('../tsconfig.app.json', import.meta.url)),
  'utf8',
)

/** 配置里每一行 `//` 注释，拼接起来——该文件所携带的叙述。 */
function statedReason(source: string): string {
  return source
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('//'))
    .join(' ')
}

describe('test files stay out of the app type check, and the config says so', () => {
  it('still excludes this package\'s test files', () => {
    // 被测决定关乎一次刻意的排除，故排除本身也被钉住：有正确注释却没有 exclude 键的文件会通过
    // 纯叙述检查，却类型检查了没人想检查的东西。
    expect(tsconfig).toContain('src/**/__tests__/*')
  })

  it('states the exclusion is deliberate, where the exclusion is', () => {
    const stated = statedReason(tsconfig)
    expect(stated.length, 'the exclusion of test files is stated nowhere in the config')
      .toBeGreaterThan(0)
    expect(stated, 'the config does not say the test exclusion is deliberate')
      .toMatch(/deliberate|intentional|standing/i)
    expect(stated, 'the config does not name what it applies to')
      .toMatch(/test/i)
  })

  it('does not describe the exclusion as history or as an unfinished job', () => {
    const stated = statedReason(tsconfig)
    // 待办或「暂时」正好会招来这条注释存在所要防止的重新纳入，故该文件不得读起来像两者中的任何一个。
    expect(stated, 'the config words the exclusion as temporary')
      .not.toMatch(/temporar|for now|for the moment/i)
    expect(stated, 'the config words the exclusion as an unfinished job')
      .not.toMatch(/TODO|FIXME/i)
  })

  it('says the excluded tests are not type-checked, so nobody assumes they are', () => {
    // 第二个事实，同一处：被排除意味着类型检查器从不读它们。措辞自由，但这个断言不自由——
    // 说反话或让读者默认反话的注释，正是本钉所存在的要抓住的误解。
    expect(statedReason(tsconfig), 'the config does not say the excluded tests go unchecked')
      .toMatch(/(never|not|isn't|aren't)\s*(type-?check|checked)/i)
  })
})
