/**
 * 一次性回填：把既有的上车点转成显式的通勤方向。
 *
 * 方向现在是用户的显式选择，因此两个上车点都已设置的既有行否则会一直显示「方向未设置」，
 * 直到用户重新选择。
 *
 * 两个方向都从本地 cached_transit_lines 表读取，绝不走上游：不消耗 provider 配额且可重复
 * 执行。方向推导不出来的行（缺上车点，或该站只被一个方向服务）故意留 NULL —— 由用户来选，
 * 脚本不猜。
 *
 * 用法：
 *   pnpm --filter @real-time-transport/server exec tsx src/db/backfill-commute-directions.ts          # 试运行
 *   pnpm --filter @real-time-transport/server exec tsx src/db/backfill-commute-directions.ts --apply  # 写入
 */
import pg from 'pg'
import { deriveCommuteDirections, resolveFavoriteLineId } from '@real-time-transport/shared'
import type { LineDetail } from '@real-time-transport/shared'

const { Pool } = pg

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  console.error('DATABASE_URL not configured')
  process.exit(1)
}

const APPLY = process.argv.includes('--apply')
const pool = new Pool({ connectionString: DATABASE_URL })

interface FavRow {
  id: string
  line_name: string
  line_id: string
  reverse_line_id: string | null
  preferred_direction: number
  pinned_station_name: string | null
  reverse_pinned_station_name: string | null
}

async function cachedDetail(lineId: string, direction: number): Promise<LineDetail | null> {
  const res = await pool.query(
    'SELECT detail_json FROM cached_transit_lines WHERE line_id = $1 AND direction = $2',
    [lineId, direction],
  )
  return (res.rows[0]?.detail_json as LineDetail) ?? null
}

async function main(): Promise<void> {
  const { rows } = await pool.query<FavRow>(
    `SELECT id, line_name, line_id, reverse_line_id, preferred_direction,
            pinned_station_name, reverse_pinned_station_name
       FROM user_favorite_lines
      WHERE morning_direction IS NULL OR evening_direction IS NULL
      ORDER BY display_order, created_at`,
  )

  console.log(`mode: ${APPLY ? 'APPLY' : 'dry run'}`)
  console.log(`candidates (at least one direction unset): ${rows.length}\n`)

  let filled = 0
  let skipped = 0

  for (const row of rows) {
    const fav = {
      lineId: row.line_id,
      preferredDirection: row.preferred_direction ?? 0,
      reverseLineId: row.reverse_line_id ?? undefined,
    }
    const morningStopName = row.pinned_station_name ?? undefined
    const eveningStopName = row.reverse_pinned_station_name ?? undefined

    console.log('='.repeat(70))
    console.log(`${row.line_name}  (${row.id.slice(0, 8)})`)
    console.log(`  morning stop: ${morningStopName ?? '(none)'}`)
    console.log(`  evening stop: ${eveningStopName ?? '(none)'}`)

    if (!morningStopName || !eveningStopName) {
      console.log('  -> skip: both board stops are needed to derive a direction')
      skipped++
      continue
    }

    // 语义方向 d 拥有 lineId resolveFavoriteLineId(fav, d) 及它自己的站序编号；
    // details 也以同一个语义方向为键。
    const details: { 0?: LineDetail, 1?: LineDetail } = {}
    for (const d of [0, 1] as const) {
      const lineId = resolveFavoriteLineId(fav, d)
      if (!lineId) continue
      const detail = await cachedDetail(lineId, d)
      if (detail) details[d] = detail
    }
    if (!details[0] || !details[1]) {
      console.log(`  -> skip: missing cached stops (dir0=${!!details[0]} dir1=${!!details[1]})`)
      skipped++
      continue
    }

    const derived = deriveCommuteDirections(
      { morningStopName, eveningStopName },
      { 0: details[0], 1: details[1] },
    )
    if (!derived) {
      console.log('  -> skip: not derivable (stop absent from one direction, or geometry)')
      skipped++
      continue
    }

    for (const [purpose, dir] of [['morning', derived.morning], ['evening', derived.evening]] as const) {
      const stop = purpose === 'morning' ? morningStopName : eveningStopName
      const at = details[dir]!.stops.find(s => s.name === stop)
      const via = details[dir]!.stops[details[dir]!.stops.length - 1]?.name
      console.log(
        `  ${purpose.padEnd(7)} -> dir${dir} (开往 ${via})  ${stop} 第${at?.order}站`,
      )
    }

    if (APPLY) {
      await pool.query(
        'UPDATE user_favorite_lines SET morning_direction = $2, evening_direction = $3 WHERE id = $1',
        [row.id, derived.morning, derived.evening],
      )
      console.log('  -> written')
    }
    else {
      console.log('  -> would write (dry run)')
    }
    filled++
  }

  console.log(`\n${APPLY ? 'backfilled' : 'would backfill'}: ${filled}   skipped: ${skipped}`)
}

try {
  await main()
}
catch (err) {
  console.error('Backfill failed:', err)
  process.exitCode = 1
}
finally {
  await pool.end()
}
