import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../app.js'
import { isUniqueViolation } from '../db/client.js'

/**
 * 「只允许关注一条」：一条线路每个用户只关注一次，第二次关注会说清这件事。
 *
 * 一条线路的两个方向是一个关注 —— 行里已经有 `morningDirection` / `eveningDirection` 与
 * `reverseLineId` —— 所以反方向不许变成第二行。本文件钉住让它成立的三件事：
 *
 *  - 直接的重复被拒绝（409，「已关注」），行数保持 1；
 *  - 反方向也被拒绝，包括存下的 `reverseLineId` 还是 NULL 的那段窗口 —— 那一列只由
 *    GET /favorites 的自愈写入，别的都不写，所以这个窗口是真的；夹具线路自己会答出它的
 *    反方向，那是守卫在这段窗口里唯一能读到的东西；
 *  - 真正不同的线路仍然能关注，所以这个拒绝不是一刀切。
 *
 * 数据库自己对这条规则的陈述（008 的唯一索引）在文件末尾按 SQL 文本读：本套件没有
 * PostgreSQL，索引的效果在这里验不了 —— 跑迁移是应用者的那一步，文件里写了该跑哪条命令。
 */

const USER = 'default_user'
/** 52路 的两个方向，按上游的命名：各是一个独立的 lineId。 */
const UP = '010-52-0'
const DOWN = '010-52-1'
/** 一条真正不同的线路，用作正对照。 */
const OTHER = '010-300-0'

/**
 * 一个 Chelaile 线路详情外壳。
 *
 * `otherlines` 是 `reverseLineId` 的来源（provider 读 `otherlines[0].lineId`），所以这个
 * 夹具让反方向可解析 —— 那正是存下的列还空着时守卫必须自己做到的事。
 */
function lineDetailEnvelope(otherDirectionLineId?: string) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      jsonr: {
        data: {
          line: { name: '52路', direction: 0, firstTime: '05:00', lastTime: '23:00' },
          stations: [
            { sId: 's1', sn: '甲站', order: 1, lat: 39.900000, lng: 116.400000 },
            { sId: 's2', sn: '乙站', order: 2, lat: 39.910000, lng: 116.410000 },
          ],
          otherlines: otherDirectionLineId ? [{ lineId: otherDirectionLineId }] : [],
        },
      },
    }),
  }
}

/**
 * 本文件唯一允许的上游：线路详情端点，只答 `primary` 的反方向。
 *
 * 其他任何调用都会抛错，因为花掉真实配额的测试不算测试。返回的数组记录被问过什么，所以
 * 下面那段 NULL-reverse 窗口是真的，而不是假设的。
 */
function stubUpstream(primary: string, otherDirectionLineId: string): string[] {
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    const href = String(url)
    calls.push(href)
    if (!href.includes('/bus/line!encryptedLineDetail.action')) {
      throw new Error(`unexpected upstream call: ${href}`)
    }
    return lineDetailEnvelope(new URL(href).searchParams.get('lineId') === primary
      ? otherDirectionLineId
      : undefined)
  }))
  return calls
}

afterEach(() => {
  vi.unstubAllGlobals()
})

const follow = (app: Awaited<ReturnType<typeof buildApp>>, payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/api/transit/favorites', payload })

const followUp = (app: Awaited<ReturnType<typeof buildApp>>, lineId: string) =>
  follow(app, { userId: USER, cityCode: '027', lineId, lineName: '52路' })

/** 存下来的行，按设置页读到的样子（这个 GET 也会自愈）。 */
async function stored(app: Awaited<ReturnType<typeof buildApp>>): Promise<any[]> {
  const res = await app.inject({ method: 'GET', url: `/api/transit/favorites?userId=${USER}` })
  return JSON.parse(res.body).data
}

describe('一条线路只允许关注一次：重复关注被拒绝，且如实说「已关注」', () => {
  it('同一条线路再关注一次：409，行数仍为 1，返回的那一行就是已存在的那一行', async () => {
    stubUpstream(UP, DOWN)
    const app = await buildApp()

    const first = await followUp(app, UP)
    expect(first.statusCode).toBe(200)
    expect(JSON.parse(first.body).success).toBe(true)
    const created = JSON.parse(first.body).data

    const again = await followUp(app, UP)

    // 这是拒绝，不是成功：调用方要求一次关注，而这个请求并没有做到，
    // 所以什么都不能读成一张新卡片。那一行照旧返回 ——
    // 屏幕就是把它显示为已关注 —— 标签是「已关注」。
    expect(again.statusCode).toBe(409)
    const body = JSON.parse(again.body)
    expect(body.success).toBe(false)
    expect(body.alreadyFollowed).toBe(true)
    expect(body.error).toBe('已关注')
    expect(body.data.id).toBe(created.id)

    expect(await stored(app)).toHaveLength(1)

    await app.close()
  })

  it('反方向：存储的 reverseLineId 仍是 NULL 时也拒绝，行数仍为 1', async () => {
    const calls = stubUpstream(UP, DOWN)
    const app = await buildApp()

    // 这段窗口是造出来的，不是假设的：这个客户端没有声明反方向，
    // 而这一行由一次当时没有既存行可解析的请求创建 ——
    // 所以上游从未被问过，存下的 `reverse_line_id` 里什么都没有。
    // （一行只能靠下面的自愈拿到它。）
    await followUp(app, UP)
    expect(calls, 'the first follow resolved something: the window is not what this test claims')
      .toHaveLength(0)

    const opposite = await followUp(app, DOWN)

    expect(opposite.statusCode).toBe(409)
    const body = JSON.parse(opposite.body)
    expect(body.alreadyFollowed).toBe(true)
    expect(body.error).toBe('已关注')

    // 这次拒绝必须去上游解析该线路的另一方向：存下的
    // 列为空，所以是守卫在做这件事，而不是读列。
    expect(calls.length).toBeGreaterThan(0)

    const rows = await stored(app)
    expect(rows, 'the opposite direction became a second favourite').toHaveLength(1)
    expect(rows[0]!.lineId).toBe(UP)
    // 而这一行现在点名了它缺的那个方向，所以下一次查看
    // 完全不需要解析。
    expect(rows[0]!.reverseLineId).toBe(DOWN)

    await app.close()
  })

  it('客户端同时给出两个方向的 lineId 时，也按同一条线路拒绝', async () => {
    stubUpstream(UP, DOWN)
    const app = await buildApp()

    await followUp(app, UP)
    const opposite = await follow(app, {
      userId: USER,
      cityCode: '027',
      lineId: DOWN,
      lineName: '52路',
      reverseLineId: UP,
    })

    expect(opposite.statusCode).toBe(409)
    expect(JSON.parse(opposite.body).alreadyFollowed).toBe(true)
    expect(await stored(app)).toHaveLength(1)

    await app.close()
  })

  it('另一条线路照常关注成功，行数加一（反向断言：拒绝不是一刀切）', async () => {
    stubUpstream(UP, DOWN)
    const app = await buildApp()

    await followUp(app, UP)
    const other = await follow(app, {
      userId: USER,
      cityCode: '027',
      lineId: OTHER,
      lineName: '300路',
    })

    expect(other.statusCode).toBe(200)
    const body = JSON.parse(other.body)
    expect(body.success).toBe(true)
    expect(body.alreadyFollowed).toBeUndefined()
    expect(await stored(app)).toHaveLength(2)

    await app.close()
  })

  it('同一条 lineId 落在另一个城市时是另一条线路，索引的三列说了算', async () => {
    stubUpstream(UP, DOWN)
    const app = await buildApp()

    await followUp(app, UP)
    // 唯一索引在 (user_id, city_code, line_id) 上：在另一座城市里读到的
    // 线路是另一条路由，而守卫必须与索引用同一个键，
    // 否则两者对「什么是重复」的看法会不一致。
    const elsewhere = await follow(app, {
      userId: USER,
      cityCode: '028',
      lineId: UP,
      lineName: '52路',
    })

    expect(elsewhere.statusCode).toBe(200)
    expect(JSON.parse(elsewhere.body).success).toBe(true)
    expect(await stored(app)).toHaveLength(2)

    await app.close()
  })
})

describe('迁移 008：数据库自己的那份规则', () => {
  const MIGRATIONS = fileURLToPath(new URL('../../../../migrations', import.meta.url))
  const FILE = '008_unique-favorite-per-line.sql'

  function forward(sql: string): string {
    return (sql.split('-- migrate:down')[0] ?? '').replace(/\s+/g, ' ').trim()
  }

  const sql = readFileSync(`${MIGRATIONS}/${FILE}`, 'utf-8')

  it('它自己那一号还在文件集里，并且排在它之前的所有迁移之后', () => {
    const files = readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()
    expect(files).toContain(FILE)
    expect(files.indexOf(FILE)).toBeGreaterThan(files.indexOf('007_commute_chains.sql'))
  })

  it('建立 (user_id, city_code, line_id) 上的唯一索引，且是幂等写法', () => {
    expect(forward(sql)).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS uniq_favorite_per_user_city_line ON user_favorite_lines (user_id, city_code, line_id)',
    )
  })

  it('只增不删：正向段里没有任何破坏性语句', () => {
    // 运行器自己对「丢数据的语句」的定义（db/migrate.ts），
    // 读在前向段上：给有真实行的表加索引
    // 不许碰任何一行。
    const destructive = forward(sql).match(/\b(DROP TABLE|DROP COLUMN|TRUNCATE|DELETE FROM)\b/gi)
    expect(destructive, `the forward section loses data: ${destructive?.join(', ')}`).toBeNull()
  })

  it('重复行会让它大声失败，而且是先报清楚再建索引', () => {
    const body = forward(sql)
    const raised = body.indexOf('RAISE EXCEPTION')
    const indexed = body.indexOf('CREATE UNIQUE INDEX')

    // 给出可读的拒绝，而不是 PostgreSQL 自己的 23505 消息：raise 点名
    // 冒犯的 (user, city, line) 与之后该跑的命令，并且它
    // 跑在索引之前，所以重复产生的就是那个错误。
    expect(raised).toBeGreaterThan(-1)
    expect(raised).toBeLessThan(indexed)
    expect(body).toContain('HAVING count(*) > 1')
    expect(body).toContain('one line may be followed only once per user')
    expect(body).toContain('pnpm migrate:up')
  })

  it('回滚段只撤掉这条索引', () => {
    const down = sql.slice(sql.indexOf('-- migrate:down'))
    expect(down.replace(/\s+/g, ' ')).toContain('DROP INDEX IF EXISTS uniq_favorite_per_user_city_line')
    expect(down).not.toMatch(/\b(DROP TABLE|DROP COLUMN|TRUNCATE|DELETE FROM)\b/i)
  })
})

describe('兜底：唯一索引的拒绝不会被读成「数据库不可用」', () => {
  /**
   * 钉的是判定，不是那个分支：池抛错时 `addFavorite` 会退回内存存储，而被拒绝的 INSERT
   * 绝不能走那条路 —— 否则调用方会拿到本进程凭空造出来的一行，而存下的那行还是原样。真正
   * 跑那个分支需要一次 PostgreSQL 的拒绝，本套件永远没有（按设计没有连接串，见
   * `databaseUrlFor`）。
   */
  it('认得出 pg 的 23505，且不把别的失败当成它', () => {
    expect(isUniqueViolation({ code: '23505' })).toBe(true)
    expect(isUniqueViolation({ code: '08006' })).toBe(false)
    expect(isUniqueViolation(new Error('connect ECONNREFUSED'))).toBe(false)
    expect(isUniqueViolation(undefined)).toBe(false)
    expect(isUniqueViolation('23505')).toBe(false)
  })
})
