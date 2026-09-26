import { describe, expect, it } from 'vitest'
import type { CommuteProfile } from '@real-time-transport/shared'
import { commutePurposeOf } from '@/commute-purpose'

/**
 * 「此刻是哪个通勤目的」在本仓的**唯一**判定处，按它读到的载荷守住。
 *
 * 时段由服务端对四个已存时刻与此刻时钟判定（`CommuteProfile.mode`），故本函数只翻译、不读时钟：
 * 调用方只看它一个来源，才对同一份 profile 得出同一个目的。
 *
 * `null` 是「没有可跟随的时段」这个事实，不是缺省值：三种成因（此刻在两个时段之外、从未存过时段、
 * 从未读到 profile）在载荷里是不同的事实，而三者都没有目的可跟随 —— 各自的默认由调用方给，
 * 判定处不替它们选一个。
 */

function profile(mode: CommuteProfile['mode'], windowState: CommuteProfile['windowState']): CommuteProfile {
  return { mode, description: '', windowState }
}

describe('时段蕴含的目的', () => {
  it('早通勤时段：上班', () => {
    expect(commutePurposeOf(profile('work', 'stored'))).toBe('morning')
  })

  it('晚通勤时段：下班', () => {
    expect(commutePurposeOf(profile('home', 'stored'))).toBe('evening')
  })
})

describe('没有可跟随的时段就什么都不说', () => {
  it('此刻落在两个时段之外：不说一个', () => {
    // `stored` 是「有窗口可落在其外」，而时钟不在任何一个里面 —— 这不是「没有时段」，
    // 但同样没有目的可跟随。
    expect(commutePurposeOf(profile('auto', 'stored'))).toBeNull()
  })

  it('没有存储行：不说一个', () => {
    expect(commutePurposeOf(profile('auto', 'unset'))).toBeNull()
  })

  it('行在、四个时刻从未选过：不说一个', () => {
    expect(commutePurposeOf(profile('auto', 'unchosen'))).toBeNull()
  })

  it('从未读到的 profile：不说一个', () => {
    // 读不到与「读到了、里面没有时段」不同，而两者都不是任何一种目的：没人对那一行作过断言。
    expect(commutePurposeOf(null)).toBeNull()
    expect(commutePurposeOf(undefined)).toBeNull()
  })
})
