import { describe, expect, it } from 'vitest'
import {
  assertTestDatabaseUrl,
  createApiHarness,
  resolveTestDatabaseUrl,
} from './support/api-harness.js'

/**
 * 硬闸的钉子：形状像开发库的 URL 必须被拒。
 *
 * 没有这条钉子，闸可能只是一段没人调用的装饰 —— 而它守的是开发库那 12 条迁移与里面的数据：
 * 一次 TRUNCATE CASCADE 就没了。因此这里钉两处：函数本身拒绝，以及套件真的走这个函数
 * （`createApiHarness` 拿开发库 URL 调它也必须起不来）。
 */

/** 形状与开发库一模一样（同一容器、同一个库名）。凭据是占位值 —— 闸只看库名。 */
const DEV_SHAPED_URL = 'postgres://transit:stub-not-a-real-secret@localhost:15432/transit'

describe('测试库硬闸：库名必须以 _test 结尾', () => {
  it('拒绝开发库那一条', () => {
    expect(() => assertTestDatabaseUrl(DEV_SHAPED_URL)).toThrow(/_test/)
  })

  it('拒绝只是「名字里含 _test」的库', () => {
    expect(() => assertTestDatabaseUrl('postgres://transit:stub@localhost:15432/transit_test_dev')).toThrow(/_test/)
  })

  it('接受 _test 结尾的库', () => {
    expect(assertTestDatabaseUrl('postgres://transit:stub@localhost:15432/transit_test'))
      .toBe('postgres://transit:stub@localhost:15432/transit_test')
  })

  it('从开发库 URL 派生出来的那条也以 _test 结尾', () => {
    const derived = new URL(resolveTestDatabaseUrl({ DATABASE_URL: DEV_SHAPED_URL } as NodeJS.ProcessEnv))
    expect(derived.pathname.endsWith('_test')).toBe(true)
    expect(derived.host).toBe('localhost:15432')
  })

  it('显式给的 TEST_DATABASE_URL 同样过闸', () => {
    expect(() => resolveTestDatabaseUrl({
      DATABASE_URL: DEV_SHAPED_URL,
      TEST_DATABASE_URL: DEV_SHAPED_URL,
    } as NodeJS.ProcessEnv)).toThrow(/_test/)
  })

  it('套件真的走这个闸：拿开发库 URL 建 harness 必须起不来', async () => {
    await expect(createApiHarness({ databaseUrl: DEV_SHAPED_URL })).rejects.toThrow(/_test/)
  })
})
