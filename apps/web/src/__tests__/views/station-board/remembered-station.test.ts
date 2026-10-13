import { afterEach, describe, expect, it, vi } from 'vitest'
import { rememberedStationId, rememberStationId } from '../../../views/station-board/remembered-station'

/**
 * 「上次看的站台」这份本地记忆：读回来的必须真是用户选过的那个，读不出来时必须**没有**。
 *
 * 它按城市分开记，且对坏值一律当没有 —— 这一页在加载时拿它决定选哪一个，故一个坏值不该让页面
 * 崩掉，也不该让别的城市的记忆被顺手抹掉。
 */

const KEY = 'rt-transit-station-board-station'
const BEIJING = '027'
const TIANJIN = '022'

function memoryStorage(entries: Record<string, string> = {}): Storage {
  const store = new Map(Object.entries(entries))
  return {
    get length() { return store.size },
    clear: () => store.clear(),
    getItem: (key: string) => store.get(key) ?? null,
    key: (index: number) => [...store.keys()][index] ?? null,
    removeItem: (key: string) => { store.delete(key) },
    setItem: (key: string, value: string) => { store.set(key, String(value)) },
  } as Storage
}

/** 直接读原始条目：断言写下的形状，而不只是经函数读回来的结果。 */
function raw(): string | null {
  return globalThis.localStorage.getItem(KEY)
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('记住每个城市最后看的站台', () => {
  it('记下来就能读回去', () => {
    vi.stubGlobal('localStorage', memoryStorage())

    rememberStationId(BEIJING, '010-8896')

    expect(rememberedStationId(BEIJING)).toBe('010-8896')
  })

  it('按城市分开记：换到别的城市再换回来，还是原来那个', () => {
    vi.stubGlobal('localStorage', memoryStorage())

    rememberStationId(BEIJING, '010-8896')
    rememberStationId(TIANJIN, '022-1234')

    expect(rememberedStationId(BEIJING)).toBe('010-8896')
    expect(rememberedStationId(TIANJIN)).toBe('022-1234')
  })

  it('记下一个城市不会顺手抹掉另一个城市', () => {
    vi.stubGlobal('localStorage', memoryStorage())

    rememberStationId(BEIJING, '010-8896')
    rememberStationId(TIANJIN, '022-1234')
    rememberStationId(BEIJING, '010-17938')

    expect(rememberedStationId(TIANJIN)).toBe('022-1234')
    expect(rememberedStationId(BEIJING)).toBe('010-17938')
  })

  it('没记过、或城市码为空：就是没有，不编一个', () => {
    vi.stubGlobal('localStorage', memoryStorage())

    expect(rememberedStationId(BEIJING)).toBe('')
    expect(rememberedStationId('')).toBe('')
  })

  it('传空串即忘掉这个城市的那一条', () => {
    vi.stubGlobal('localStorage', memoryStorage())
    rememberStationId(BEIJING, '010-8896')

    rememberStationId(BEIJING, '')

    expect(rememberedStationId(BEIJING)).toBe('')
    // 忘掉的是这一条，不是整张表。
    expect(raw()).toBe('{}')
  })

  it('坏值一律当没有：不是 JSON、是数组、值不是字符串', () => {
    for (const broken of ['{', '[]', 'null', '"010-8896"', '{"027":7}', '{"027":{"id":"010-8896"}}']) {
      vi.stubGlobal('localStorage', memoryStorage({ [KEY]: broken }))
      expect(rememberedStationId(BEIJING), broken).toBe('')
    }
  })

  it('坏值里的好值仍然可用：一条写坏不影响另一条', () => {
    vi.stubGlobal('localStorage', memoryStorage({ [KEY]: '{"027":"010-8896","022":5}' }))

    expect(rememberedStationId(BEIJING)).toBe('010-8896')
    expect(rememberedStationId(TIANJIN)).toBe('')
  })

  it('读布:没有 localStorage 时不抛，就是没有', () => {
    vi.stubGlobal('localStorage', undefined)

    expect(rememberedStationId(BEIJING)).toBe('')
    expect(() => rememberStationId(BEIJING, '010-8896')).not.toThrow()
  })

  it('存储拒写时不抛：这是个便利，不该让换站台失败', () => {
    vi.stubGlobal('localStorage', {
      ...memoryStorage(),
      getItem: () => null,
      setItem: () => { throw new Error('quota exceeded') },
    } as Storage)

    expect(() => rememberStationId(BEIJING, '010-8896')).not.toThrow()
    expect(rememberedStationId(BEIJING)).toBe('')
  })
})
