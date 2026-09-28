import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

/**
 * 开发模拟下的一次点按也要有回话。
 *
 * 模拟坐标在模块导入时从 `import.meta.env` 读出来，故这里必须先立起环境变量再动态导入 ——
 * 静态导入拿到的是「没有模拟」的那一份，那样测的是另一个分支。
 *
 * 提示库被替换掉，故这里读的是那句话本身。
 */
const { pushed } = vi.hoisted(() => ({ pushed: [] as string[] }))

vi.mock('vue-sonner', () => ({
  toast: (message: string) => {
    pushed.push(message)
    return pushed.length
  },
}))

vi.stubEnv('VITE_GPS_SIMULATION', 'true')
vi.stubEnv('VITE_GPS_SIM_LAT', '39.90931')
vi.stubEnv('VITE_GPS_SIM_LNG', '116.3974')

async function store() {
  const { useLocationStore } = await import('@/stores/location.store')
  return useLocationStore()
}

describe('定位在开发模拟下的回话', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    pushed.length = 0
  })

  afterEach(() => {
    pushed.length = 0
  })

  it('点按一次说一句，并说明位置来自模拟', async () => {
    (await store()).requestLocation({ userInitiated: true })
    expect(pushed).toEqual(['已获取位置 · 开发模拟'])
  })

  it('自动那一次一个字都不说：它不是一次点按', async () => {
    (await store()).requestLocation()
    expect(pushed).toEqual([])
  })
})
