/**
 * One-off backfill: turn pre-existing board stops into explicit commute directions.
 *
 * Before 005, the commute direction was inferred from the two board stops' order
 * in each direction's stop list. It is now an explicit user choice, so existing
 * rows that have both stops set would otherwise show "direction not set" until
 * the user re-picks.
 *
 * Reads BOTH directions from the local cached_transit_lines table — never from
 * upstream — so it costs no provider quota and is deterministic. Rows whose
 * direction cannot be derived (missing stops, or a stop served by only one
 * direction) are left NULL on purpose: the user picks, the script does not guess.
 *
 * Usage:
 *   pnpm --filter @real-time-transport/server exec tsx src/db/backfill-commute-directions.ts          # dry run
 *   pnpm --filter @real-time-transport/server exec tsx src/db/backfill-commute-directions.ts --apply  # write
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

/** Load a direction's stop list from the local cache; null when not cached. */
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

    // Semantic direction d owns lineId resolveFavoriteLineId(fav, d) and its own
    // stop numbering; key the details by that same semantic direction.
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
