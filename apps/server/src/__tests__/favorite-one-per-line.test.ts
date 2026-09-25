import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../app.js'
import { isUniqueViolation } from '../db/client.js'

/**
 * 「只允许关注一条」: a line is followed ONCE per user, and a second follow says so.
 *
 * Two directions of one route are ONE favourite — the row already carries
 * `morningDirection` / `eveningDirection` and a `reverseLineId` — so the opposite
 * direction must not become a second row. This file holds the three facts that
 * make that true, each with the case that used to break it:
 *
 *  - a direct duplicate is REFUSED (409, 「已关注」) and the row count stays 1;
 *  - the opposite direction is refused too, INCLUDING while the stored
 *    `reverseLineId` is still NULL — the real window, since that column is filled
 *    by the GET /favorites self-heal and by nothing else. The fixture line answers
 *    its own opposite direction upstream, which is the only thing the guard can
 *    read inside the window;
 *  - a genuinely different line still follows, so the refusal is not a blanket one.
 *
 * The database's own statement of the rule (migration 008's unique index) is read
 * as SQL text at the bottom: this suite has no PostgreSQL, so the index's EFFECT
 * cannot be exercised here — running the migration is the owner's step, and the
 * file says which command.
 */

const USER = 'default_user'
/** 52路's two directions, as the upstream names them: a distinct lineId each. */
const UP = '010-52-0'
const DOWN = '010-52-1'
/** A genuinely different line, for the positive control. */
const OTHER = '010-300-0'

/**
 * A Chelaile line-detail envelope.
 *
 * `otherlines` is where a `reverseLineId` comes from (the provider reads
 * `otherlines[0].lineId`), so this is the fixture that makes the opposite
 * direction RESOLVABLE — which is what the guard has to do by itself while the
 * stored column is still empty.
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
 * The only upstream this file allows: the line-detail endpoint, answering the
 * opposite direction of `primary` and nothing else.
 *
 * Every other call throws, because a test that spends real quota is not a test.
 * The returned array records what was asked, which is how the NULL-reverse window
 * below is held to be real rather than assumed.
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

/** The stored rows, as the settings screen reads them (this GET also self-heals). */
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

    // A refusal, not a success: the caller asked for a follow and this request did
    // not perform one, so nothing may read as a new card. The row still comes back
    // — it is what the screen shows as followed — under the label 「已关注」.
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

    // The window, built rather than assumed: this client states no reverse
    // direction, and the row is created by a request that had no existing row to
    // resolve — so the upstream was never asked and the stored `reverse_line_id`
    // holds nothing. (A row only ever gets one from the self-heal below.)
    await followUp(app, UP)
    expect(calls, 'the first follow resolved something: the window is not what this test claims')
      .toHaveLength(0)

    const opposite = await followUp(app, DOWN)

    expect(opposite.statusCode).toBe(409)
    const body = JSON.parse(opposite.body)
    expect(body.alreadyFollowed).toBe(true)
    expect(body.error).toBe('已关注')

    // The refusal had to resolve the route's other direction upstream: the stored
    // column said nothing, so this is the guard doing the work, not a column read.
    expect(calls.length).toBeGreaterThan(0)

    const rows = await stored(app)
    expect(rows, 'the opposite direction became a second favourite').toHaveLength(1)
    expect(rows[0]!.lineId).toBe(UP)
    // And the row now names the direction it was missing, so the next look needs
    // no resolution at all.
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
    // The unique index is on (user_id, city_code, line_id): a line read in another
    // city is a different route, and the guard must use the same key as the index
    // or the two would disagree about what a duplicate is.
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

  /**
   * The forward half of a migration, exactly as the runner reads it: the section
   * above the `-- migrate:down` marker (`stripDownSection` in db/migrate.ts).
   */
  function forward(sql: string): string {
    return (sql.split('-- migrate:down')[0] ?? '').replace(/\s+/g, ' ').trim()
  }

  const sql = readFileSync(`${MIGRATIONS}/${FILE}`, 'utf-8')

  it('它自己那一号还在文件集里，并且排在它之前的所有迁移之后', () => {
    // This test used to assert that 008 was the LAST migration, which was true when
    // it was written and is a claim about the file SET rather than about this
    // migration. 009 is newer, so what 008 still owns is its own number and its
    // place in the order (the runner applies by filename); 「最新的那一条」 now
    // belongs to the migration that is actually newest, and 009's own suite holds
    // that half.
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
    // The runner's own definition of a data-losing statement (db/migrate.ts), read
    // on the forward half: adding an index to a table with real rows must not
    // touch a single row.
    const destructive = forward(sql).match(/\b(DROP TABLE|DROP COLUMN|TRUNCATE|DELETE FROM)\b/gi)
    expect(destructive, `the forward section loses data: ${destructive?.join(', ')}`).toBeNull()
  })

  it('重复行会让它大声失败，而且是先报清楚再建索引', () => {
    const body = forward(sql)
    const raised = body.indexOf('RAISE EXCEPTION')
    const indexed = body.indexOf('CREATE UNIQUE INDEX')

    // Legible refusal instead of PostgreSQL's own 23505 message: the raise names
    // the offending (user, city, line) and the command to run afterwards, and it
    // runs BEFORE the index so that is the error a duplicate produces.
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
   * The predicate, not the branch: `addFavorite` falls back to the in-memory store
   * when the pool throws, and a REFUSED INSERT must not take that path — the
   * caller would get a row this process invented while the stored row stayed as it
   * was. Exercising the branch itself needs a PostgreSQL refusal, which this suite
   * never has (no connection string, by design — see `databaseUrlFor`).
   */
  it('认得出 pg 的 23505，且不把别的失败当成它', () => {
    expect(isUniqueViolation({ code: '23505' })).toBe(true)
    expect(isUniqueViolation({ code: '08006' })).toBe(false)
    expect(isUniqueViolation(new Error('connect ECONNREFUSED'))).toBe(false)
    expect(isUniqueViolation(undefined)).toBe(false)
    expect(isUniqueViolation('23505')).toBe(false)
  })
})
