import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../app.js'

/**
 * 关注线路的上车点：写入与读回都是 (站名, 站序) 一对。
 *
 * 判据与 007（链路乘车段）同一把秤：**站名与站序同生同灭**。给站名就必须给站序，清空就
 * 两列一起清；只给站名的写请求被拒绝（400），因为收下它正是丢站序的那一步。
 *
 * 与「必传但可为 null」的区别：这四个字段走 `Database.setBoardStops`，拼的是
 * `column = $n` —— **缺席 = 保持不动，`null` = 清空**，而 `""` 是一个名字为空的站（不是
 * 清空，也不是 400）。`COALESCE` 那条规则属于 `updateFavorite`，在本路由上只服务
 * `displayOrder`。
 */

const DUP = '和平东桥'

type App = Awaited<ReturnType<typeof buildApp>>

afterEach(() => {
  vi.unstubAllGlobals()
})

const json = (res: { body: string }) => JSON.parse(res.body)

/** 拒绝的上游：本文件里任何调用都不许触网。 */
function refuseUpstream(): void {
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => ({
    ok: false,
    status: 503,
    text: async () => `unexpected upstream call: ${String(url)}`,
  })))
}

async function follow(app: App, payload: Record<string, unknown>): Promise<any> {
  const created = await app.inject({ method: 'POST', url: '/api/transit/favorites', payload })
  expect(created.statusCode, created.body).toBe(200)
  return json(created).data
}

const patch = (app: App, id: string, payload: Record<string, unknown>, query = '') =>
  app.inject({ method: 'PATCH', url: `/api/transit/favorites/${id}${query}`, payload })

const readRow = async (app: App, id: string, query = ''): Promise<any> =>
  json(await app.inject({ method: 'GET', url: `/api/transit/favorites${query}` }))
    .data.find((row: any) => row.id === id)

/** 重名夹具：环线的第一站与最后一站同名。 */
const LOOP = {
  cityCode: '027',
  lineId: '010-300-0',
  lineName: '300内',
  preferredDirection: 0,
  reverseLineId: '010-300-1',
}

describe('(a) 记录第 36 站：写下去的是这一对，读回来的也是这一对', () => {
  it('PATCH 带站名与站序 → 行里两列都在，同一个响应里就看得见', async () => {
    const app = await buildApp({})
    try {
      const fav = await follow(app, LOOP)

      const saved = await patch(app, fav.id, {
        morningStopName: DUP,
        morningStopOrder: 36,
        morningDirection: 0,
      })
      expect(saved.statusCode, saved.body).toBe(200)
      expect(json(saved).data.morningStopName).toBe(DUP)
      // RED-first 钉 (a)：站名与站序必须一起落进行里。
      expect(json(saved).data.morningStopOrder).toBe(36)
      expect(json(saved).data.morningDirection).toBe(0)

      // 「每个显示它的界面」的读侧同一条：列表读回同一个 pair。
      const listed = await readRow(app, fav.id)
      expect(listed.morningStopName).toBe(DUP)
      expect(listed.morningStopOrder).toBe(36)
    }
    finally {
      await app.close()
    }
  })

  it('两个用途各自一对，互不串门', async () => {
    const app = await buildApp({})
    try {
      const fav = await follow(app, LOOP)
      await patch(app, fav.id, { morningStopName: DUP, morningStopOrder: 36, morningDirection: 0 })
      await patch(app, fav.id, { eveningStopName: '安贞桥东', eveningStopOrder: 7, eveningDirection: 1 })

      const row = await readRow(app, fav.id)
      expect(row.morningStopName).toBe(DUP)
      expect(row.morningStopOrder).toBe(36)
      expect(row.eveningStopName).toBe('安贞桥东')
      expect(row.eveningStopOrder).toBe(7)
    }
    finally {
      await app.close()
    }
  })

  it('只给站名、不给站序的写请求被拒绝：收下它正是丢掉「哪一站」的那一步', async () => {
    const app = await buildApp({})
    try {
      const fav = await follow(app, LOOP)

      const half = await patch(app, fav.id, { morningStopName: DUP })
      expect(half.statusCode, 'a name without its order was accepted, so which stop it is is lost').toBe(400)

      // 另一半也一样：站序没有站名就定位不到任何东西。
      expect((await patch(app, fav.id, { morningStopOrder: 36 })).statusCode).toBe(400)
      // 而清空是「两列一起清」，是允许的。
      expect((await patch(app, fav.id, { morningStopName: null, morningStopOrder: null })).statusCode).toBe(200)
    }
    finally {
      await app.close()
    }
  })

  it('空串不是清空：它会被拒绝，而不是存成一个名字为空的站', async () => {
    const app = await buildApp({})
    try {
      const fav = await follow(app, LOOP)
      const empty = await patch(app, fav.id, { morningStopName: '', morningStopOrder: 1 })
      expect(empty.statusCode, 'an empty stop name was stored as a stop').toBe(400)
    }
    finally {
      await app.close()
    }
  })

  it('清空写 null/null：两列一起消失，不留半个站', async () => {
    const app = await buildApp({})
    try {
      const fav = await follow(app, LOOP)
      await patch(app, fav.id, { morningStopName: DUP, morningStopOrder: 36 })

      const cleared = await patch(app, fav.id, { morningStopName: null, morningStopOrder: null })
      expect(cleared.statusCode, cleared.body).toBe(200)
      const row = json(cleared).data
      expect(row.morningStopName).toBeUndefined()
      expect(row.morningStopOrder).toBeUndefined()

      const listed = await readRow(app, fav.id)
      expect(listed.morningStopName).toBeUndefined()
      expect(listed.morningStopOrder).toBeUndefined()
      // 方向是另一件事：清站不动方向。它读作 null（= 未选），不是缺键 —— 两个领域的
      // 「没选」用两种写法，各自都不是对方的事实。
      expect(listed.morningDirection).toBeNull()
    }
    finally {
      await app.close()
    }
  })

  it('POST 带的一对也入行：同一个契约里被接下的字段就必须被存下来', async () => {
    // 契约收下的字段必须落库（POST 的这对也一样）；
    // 站序与站名同生同灭，所以一并补上。
    refuseUpstream()
    const app = await buildApp({})
    try {
      const fav = await follow(app, {
        ...LOOP,
        morningStopName: DUP,
        morningStopOrder: 36,
        morningDirection: 0,
      })
      expect(fav.morningStopName).toBe(DUP)
      expect(fav.morningStopOrder).toBe(36)
      expect(fav.morningDirection).toBe(0)

      const listed = await readRow(app, fav.id)
      expect(listed.morningStopName).toBe(DUP)
      expect(listed.morningStopOrder).toBe(36)
      expect(listed.morningDirection).toBe(0)
    }
    finally {
      await app.close()
    }
  })
})

describe('(f) 改方向不动站：存下来的那一对原样保留', () => {
  it('只写方向的 PATCH 不碰站名与站序两列', async () => {
    const app = await buildApp({})
    try {
      const fav = await follow(app, LOOP)
      await patch(app, fav.id, { morningStopName: DUP, morningStopOrder: 36, morningDirection: 0 })

      const moved = await patch(app, fav.id, { morningDirection: 1 })
      expect(moved.statusCode, moved.body).toBe(200)
      expect(json(moved).data.morningDirection).toBe(1)
      // RED-first 钉 (f)：使用者选的那一站不会在方向变化时被悄悄丢掉（也不会被重新编号）
      // —— 站名所属的那个方向是另一个字段，而这一行保留这一对，
      // 让使用者看得见自己原来选的是什么。
      expect(json(moved).data.morningStopName).toBe(DUP)
      expect(json(moved).data.morningStopOrder).toBe(36)

      const listed = await readRow(app, fav.id)
      expect(listed.morningStopName).toBe(DUP)
      expect(listed.morningStopOrder).toBe(36)
      expect(listed.morningDirection).toBe(1)
    }
    finally {
      await app.close()
    }
  })
})

describe('(同族) 数据层：两个站序列在写入与读回的清单里都占位', () => {
  // 本套件跑的是内存分支（测试进程没有 DATABASE_URL，见 db-connection-guard.test.ts），
  // 所以「SQL 那条 UPDATE / INSERT 里有没有这两列」在这里跑不出来 —— 删掉一列，上面的行为
  // 断言照样全绿。这一条钉的是那段文本本身：它做什么、列了什么，而不是它跑起来的效果。
  // 运行期的对证在 `references/db-migrations.md` 的验证配方里（真库上跑 up、看列、再读接口）。
  const client = readFileSync(
    fileURLToPath(new URL('../db/client.ts', import.meta.url)),
    'utf8',
  )

  it('setBoardStops 把两个站序列都写进 SET 列表', () => {
    expect(client).toMatch(/push\('pinned_station_order', stops\.morningStopOrder\)/)
    expect(client).toMatch(/push\('reverse_pinned_station_order', stops\.eveningStopOrder\)/)
  })

  it('两个读分支都把两个站序列映射出来（SQL 与内存不允许各说各话）', () => {
    for (const mapping of [
      'morningStopOrder: row.pinned_station_order ?? undefined',
      'eveningStopOrder: row.reverse_pinned_station_order ?? undefined',
      'morningStopOrder: f.morningStopOrder ?? undefined',
      'eveningStopOrder: f.eveningStopOrder ?? undefined',
    ]) {
      expect(client, `${mapping} is missing, so one of the two branches drops the stop's order`)
        .toContain(mapping)
    }
  })

  it('INSERT 也列上这两列与两个方向列：契约收下的字段必须落库', () => {
    expect(client).toMatch(/INSERT INTO user_favorite_lines \([^)]*pinned_station_order[^)]*reverse_pinned_station_order[^)]*\)/)
    expect(client).toMatch(/INSERT INTO user_favorite_lines \([^)]*morning_direction[^)]*evening_direction[^)]*\)/)
  })
})

describe('(同族) 站与方向的写请求也认调用方的 user id', () => {
  it('自己的 id 写自己的行：那个 id 读得到', async () => {
    refuseUpstream()
    const app = await buildApp({})
    try {
      const mine = await follow(app, { ...LOOP, userId: 'pair_writer' })
      const saved = await patch(app, mine.id, { morningStopName: DUP, morningStopOrder: 36 }, '?userId=pair_writer')
      expect(saved.statusCode, saved.body).toBe(200)

      const listed = await readRow(app, mine.id, '?userId=pair_writer')
      expect(listed.morningStopName).toBe(DUP)
      expect(listed.morningStopOrder).toBe(36)
    }
    finally {
      await app.close()
    }
  })

  it('别人的行改不动：默认用户看到的是 404，而不是一次跨用户的写入', async () => {
    refuseUpstream()
    const app = await buildApp({})
    try {
      const mine = await follow(app, { ...LOOP, userId: 'pair_writer' })

      const theirs = await patch(app, mine.id, { morningStopName: DUP, morningStopOrder: 36 })
      expect(theirs.statusCode, 'another user wrote to a row this request did not name').toBe(404)

      const listed = await readRow(app, mine.id, '?userId=pair_writer')
      expect(listed.morningStopName).toBeUndefined()
    }
    finally {
      await app.close()
    }
  })
})
