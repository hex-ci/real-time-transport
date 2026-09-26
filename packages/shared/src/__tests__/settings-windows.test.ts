import { describe, expect, it } from 'vitest'
import {
  CommuteChainSchema,
  CommuteProfileSchema,
  DEFAULT_USER_ID,
  RefreshLiveRequestSchema,
  UpdateSettingsSchema,
  UserFavoriteLineSchema,
  UserSettingsSchema,
} from '../index.js'

/**
 * T2's contract at the schema layer: 「一个时段」 是一个值，两端同生同灭；四个时刻
 * 可以是 NULL —— 那是「用户从未选择」，不是内置的 06:30–11:30。
 *
 * 一个时段的两端分开提交时，存下来的是半个窗口：它既不是一个窗口（没有终点就圈不出
 * 任何时刻），也不是「从未选择」（有一个端点已经写进库里）。这正是 007 的上/下车站
 * 「站名与站序同生同灭」拒绝过的那种半个值 —— 读侧对它没有任何诚实的话可说，所以它
 * 必须在边界上被拒掉，而不是存进去之后再由读侧解释成第三种状态。
 *
 * NULL 则相反，是一个可表达、可报告的合法状态：行在（锚点可能已存），四个时刻用户
 * 从没选过。`UserSettingsSchema` 必须接受它，`windowState` 必须说得出它。
 *
 * 默认用户 id 同样只在这里有一个字面量：契约层的三个写侧默认值与服务端、前端的解析
 * 都取自 `DEFAULT_USER_ID`，任何一处硬写 'default_user' 都是同一个事实的第二份副本。
 */

describe('一个时段的两端同生同灭', () => {
  it('两端一起给出时成立', () => {
    const parsed = UpdateSettingsSchema.safeParse({ morningStart: '07:15', morningEnd: '09:45' })
    expect(parsed.success, parsed.success ? '' : parsed.error.issues[0]?.message).toBe(true)
  })

  it('只给早高峰的一端是半个时段，边界上就拒绝', () => {
    const lone = UpdateSettingsSchema.safeParse({ morningStart: '07:15' })
    expect(lone.success, 'a lone window end was accepted and would be stored as half a window').toBe(false)
    expect(lone.success ? '' : lone.error.issues[0]?.message).toBe('早高峰的起点与终点必须同时给出或同时留空')
  })

  it('只给晚高峰的一端同样拒绝，理由里点名是晚高峰', () => {
    const lone = UpdateSettingsSchema.safeParse({ eveningEnd: '21:00' })
    expect(lone.success, 'a lone window end was accepted and would be stored as half a window').toBe(false)
    expect(lone.success ? '' : lone.error.issues[0]?.message).toBe('晚高峰的起点与终点必须同时给出或同时留空')
  })

  it('两端一起写成 null 是清空这个时段，不是非法请求', () => {
    // 清空是一个真实操作（用户不想再按某个时段判断），和锚点用显式 null 清空同一条规则：
    // null 是清空，undefined 是不碰。
    const cleared = UpdateSettingsSchema.safeParse({ morningStart: null, morningEnd: null })
    expect(cleared.success, cleared.success ? '' : cleared.error.issues[0]?.message).toBe(true)
    expect(cleared.success ? cleared.data.morningStart : undefined).toBeNull()
  })

  it('一个字段都不带仍然是合法的 PATCH —— 什么都不改', () => {
    const anchorsOnly = UpdateSettingsSchema.safeParse({ homeLat: 39.9, homeLng: 116.4 })
    expect(anchorsOnly.success, 'an anchors-only PATCH stopped being a valid request').toBe(true)
    expect(UpdateSettingsSchema.safeParse({}).success).toBe(true)
  })

  it('起点不早于终点仍然被拒绝，规则没被两端同生同灭顶掉', () => {
    expect(UpdateSettingsSchema.safeParse({ morningStart: '09:00', morningEnd: '09:00' }).success).toBe(false)
    expect(UpdateSettingsSchema.safeParse({ eveningStart: '22:00', eveningEnd: '17:00' }).success).toBe(false)
  })
})

describe('四个时刻可以是「从未选择」的 NULL', () => {
  it('读侧契约接受四个 null，并且原样保留', () => {
    const row = {
      morningStart: null,
      morningEnd: null,
      eveningStart: null,
      eveningEnd: null,
      homeLat: null,
      homeLng: null,
      workLat: null,
      workLng: null,
    }
    const parsed = UserSettingsSchema.safeParse(row)
    expect(parsed.success, parsed.success ? '' : parsed.error.issues[0]?.message).toBe(true)
    expect(parsed.success ? parsed.data.morningStart : 'not parsed').toBeNull()
    expect(parsed.success ? parsed.data.eveningEnd : 'not parsed').toBeNull()
  })

  it('已选的时刻照旧是 HH:MM，其他写法仍然被拒', () => {
    const row = (morningStart: unknown) => ({
      morningStart,
      morningEnd: '11:30',
      eveningStart: null,
      eveningEnd: null,
    })
    expect(UserSettingsSchema.safeParse(row('07:15')).success).toBe(true)
    for (const bad of ['25:00', '7:15', '0715', '', '07:60']) {
      expect(UserSettingsSchema.safeParse(row(bad)).success, `row morningStart=${String(bad)}`).toBe(false)
    }
  })
})

describe('windowState 说得出「行在、时段没设过」', () => {
  it('unchosen 是合法的 windowState', () => {
    const parsed = CommuteProfileSchema.safeParse({
      mode: 'auto',
      description: '未设置通勤时段',
      windowState: 'unchosen',
    })
    expect(parsed.success, parsed.success ? '' : parsed.error.issues[0]?.message).toBe(true)
    expect(parsed.success ? parsed.data.windowState : 'not parsed').toBe('unchosen')
  })

  it('它仍然是封闭集合，第四个值照旧被拒', () => {
    expect(CommuteProfileSchema.safeParse({ mode: 'auto', description: 'x', windowState: 'default' }).success).toBe(false)
    expect(CommuteProfileSchema.safeParse({ mode: 'auto', description: 'x', windowState: 'unchosen' }).success).toBe(true)
  })
})

describe('默认用户 id 在契约层只有一个字面量', () => {
  it('DEFAULT_USER_ID 就是那个默认', () => {
    expect(DEFAULT_USER_ID).toBe('default_user')
  })

  it('三个写侧 schema 的默认值都取自它', () => {
    const favourite = UserFavoriteLineSchema.parse({ lineId: '010-1-0', lineName: '1', cityCode: '027' })
    expect(favourite.userId).toBe(DEFAULT_USER_ID)

    const chain = CommuteChainSchema.parse({
      name: '上班链路',
      purpose: 'morning',
      legs: [{
        lineId: '010-2-0',
        lineName: '2路',
        boardStationName: null,
        boardStationOrder: null,
        alightStationName: null,
        alightStationOrder: null,
        transferExtraMinutes: null,
        connectionMode: null,
      }],
    })
    expect(chain.userId).toBe(DEFAULT_USER_ID)

    const refresh = RefreshLiveRequestSchema.parse({ lines: [{ lineId: '010-1-0' }] })
    expect(refresh.userId).toBe(DEFAULT_USER_ID)
  })
})
