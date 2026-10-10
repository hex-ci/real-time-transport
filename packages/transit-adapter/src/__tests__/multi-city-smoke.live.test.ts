/**
 * 多城市搜索冒烟测试（live，默认跳过，不进 CI）。
 *
 * 背景（2026-10-10 城市码审计）：
 * 1. 天津/广州/深圳/厦门/兰州在城市字典里被写成 `amap_` 占位码，
 *    searchLines 把无效 cityId 透传给车来了上游，静默返回空；
 * 2. getCityAdcode 对非热门城市回落透传车来了码（如东莞 '008'），
 *    该值被当作高德 adcode 传给地点搜索接口，高德不认。
 * 两处 bug 长期未被发现，根因都是"之前只有北京被测试过"。
 *
 * 手动跑（约 1 分钟，打车来了上游的真实搜索接口）：
 *   LIVE_SMOKE=1 pnpm --filter @real-time-transport/transit-adapter exec vitest run multi-city-smoke
 */
import { describe, expect, it } from 'vitest'
import { ChelaileProvider } from '../providers/chelaile.js'
import { HOT_CITY_META, getCityAdcode } from '@real-time-transport/shared'

const maybeDescribe = process.env.LIVE_SMOKE ? describe : describe.skip

maybeDescribe('multi-city search smoke (live upstream)', () => {
  const provider = new ChelaileProvider()

  it('先行检查：北京基线 + 上游可达性', async () => {
    const lines = await provider.searchLines('1路', '027')
    console.log(`[北京 027] ${lines.length} 条`)
    if (lines.length === 0) {
      throw new Error(
        '车来了上游搜索接口不可达（北京基线也返回空）——检查网络或上游状态后再跑冒烟测试，'
        + '不要把这当成 cityId 回归。',
      )
    }
  }, 60_000)

  it('审计修复的 5 城：搜"1路"都返回真实本地线路', async () => {
    const cases: Array<[code: string, expectFirst: string]> = [
      ['006', '天津'], // 天津
      ['040', '广州'], // 广州
      ['014', '深圳'], // 深圳
      ['036', '厦门'], // 厦门
      ['017', '兰州'], // 兰州
    ]
    for (const [code, city] of cases) {
      const lines = await provider.searchLines('1路', code)
      console.log(`[${city} ${code}] ${lines.length} 条，首条：${lines[0]?.lineName ?? '(空)'}`)
      expect(lines.length, `${city}(${code}) 搜"1路"返回为空，疑似 cityId 失效（对齐车来了 App 能力）`)
        .toBeGreaterThan(0)
    }
  }, 60_000)

  it('热门城市基线：北京/上海/杭州/成都/武汉搜"1路"正常', async () => {
    const codes = ['027', '034', '004', '007', '000']
    for (const code of codes) {
      const name = HOT_CITY_META.find(c => c.code === code)?.name ?? code
      const lines = await provider.searchLines('1路', code)
      console.log(`[${name} ${code}] ${lines.length} 条`)
      expect(lines.length, `${name}(${code}) 基线失败`).toBeGreaterThan(0)
    }
  }, 60_000)

  it('历史占位码 amap_* 不再透传上游，直接返回空', async () => {
    const lines = await provider.searchLines('1路', 'amap_120000')
    expect(lines).toEqual([])
  })

  it('getCityAdcode 不再把车来了码透传给高德', () => {
    expect(getCityAdcode('008')).toBe('东莞') // 非热门城市回落城市名，高德认中文名
    expect(getCityAdcode('027')).toBe('110000') // 热门城市仍用精确 adcode
    expect(getCityAdcode('amap_120000')).toBe('120000') // 占位码归一化后走 adcode
    expect(getCityAdcode('999')).toBe('999') // 完全未知码保持原样，不编造
  })
})
