/**
 * The followed lines of the active city, together with each direction's own stop list.
 *
 * WHY THIS IS ONE MODULE. 设置 is an index plus four pages, and TWO of them need this same
 * read: 关注线路 offers a board stop out of a direction's stop list, and 通勤链路 offers a
 * line whose (station, order) pair can be checked against it. The requirement is that the
 * two agree — the chain editor's premise is 「this page already loads exactly that list, per
 * direction, for the pins above」 — and one source is the only thing that keeps it true.
 * Two copies of this logic would let a chain leg be offered stops the pin picker on the
 * other page considers unavailable.
 *
 * The code itself did not change when it moved here: same refs, same requests, same
 * laziness. What is `undefined` stays `undefined` (「not read yet」) and what the API
 * answered without stops stays flagged (`stationLoadFailed`), because those are three
 * different facts — reading, unavailable, and read — and the pages word them separately.
 *
 * The composable is per-page state, not app state: no page is kept alive beside another
 * (there is no `keep-alive` and no tab strip), so a page that mounts gets its own lists and
 * its own watcher, and unmounting releases both.
 */
import { computed, onMounted, shallowRef, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { resolveFavoriteLineId } from '@real-time-transport/shared/line-group'
import type { LineDetail, Station, UserFavoriteLine } from '@real-time-transport/shared'
import type { ReadState } from '@/read-state'
import { useCityStore } from '@/stores/city.store'
import { useTransitStore } from '@/stores/transit.store'
import type { ChainLineOption } from './types'

export function useLineStops() {
  const transitStore = useTransitStore()
  const cityStore = useCityStore()
  const { favoriteOrder } = storeToRefs(transitStore)

  /**
   * Whether the followed set itself has answered yet.
   *
   * This module OWNS that read, so it owes its callers the read's own state rather than an
   * array that an empty answer and a failed one leave looking alike: `fetchFavorites`
   * reports the difference, and a page that swallowed it would render 「暂无关注线路」 for a
   * list nobody read — the exact lie 设置's index row was split out to stop. `cityFavorites`
   * is the VALUE; this is whether there is one.
   */
  const favoritesRead = shallowRef<ReadState>('reading')

  /**
   * Stops per favourite direction, keyed `${favoriteId}_${direction}`. Loaded
   * lazily when the user opens a pin picker — a favourite can cover both
   * directions, each needing its own stop list from its own upstream lineId.
   */
  const stationLists = shallowRef<Record<string, Station[]>>({})
  /** Directions the API answered for but returned no detail for. */
  const stationLoadFailed = shallowRef<Record<string, boolean>>({})
  /**
   * Direction labels keyed `${favoriteId}_${direction}`, taken from each
   * direction's upstream `directionName` ("开往 X"). Stored per direction because
   * a bus route's two directions are separate upstream lines and each names its
   * own terminus; absent until that direction's stops are loaded.
   */
  const directionLabels = shallowRef<Record<string, string>>({})

  function pinKey(favoriteId: string, direction: number): string {
    return `${favoriteId}_${direction}`
  }

  /**
   * The current city's followed lines, in STORED order.
   *
   * Read from `favoriteOrder`, never from the store's own array: that array is
   * ordered the way the home screen presents it, which lifts one row ahead of
   * where it is actually stored. These pages edit the stored order, so they have to
   * show exactly that — otherwise the row the user grabs is not the row the drop
   * writes.
   */
  const cityFavorites = computed(() =>
    favoriteOrder.value.filter(f => f.cityCode === cityStore.currentCode),
  )

  /**
   * Commute direction options of a favourite, one entry per available direction.
   *
   * A bus route's two directions are two upstream lineIds, so each option carries
   * the lineId its stops must be fetched from. The label is the upstream's own
   * `directionName` ("开往 X"), which is what the vehicle's destination board
   * reads — 上行/下行 is not in the data and is not consistent between cities.
   */
  function directionOptions(fav: UserFavoriteLine): Array<{
    direction: 0 | 1
    lineId: string
    label: string | null
  }> {
    const primary = (fav.preferredDirection === 1 ? 1 : 0) as 0 | 1
    const other = (1 - primary) as 0 | 1
    const out: Array<{ direction: 0 | 1, lineId: string, label: string | null }> = []

    const push = (direction: 0 | 1) => {
      const lineId = resolveFavoriteLineId(fav, direction)
      if (!lineId) return
      out.push({ direction, lineId, label: directionLabels.value[pinKey(fav.id!, direction)] ?? null })
    }
    push(primary)
    push(other)
    return out
  }

  async function ensureStations(fav: UserFavoriteLine, direction: 0 | 1, lineId: string): Promise<void> {
    const key = pinKey(fav.id!, direction)
    if (stationLists.value[key]) return
    try {
      const qs = new URLSearchParams({
        direction: String(direction),
        cityCode: fav.cityCode || cityStore.currentCode,
      })
      const res = await fetch(`/api/transit/lines/${encodeURIComponent(lineId)}?${qs.toString()}`)
      const json = await res.json()
      if (json.success && json.data) {
        const detail = json.data as LineDetail
        stationLists.value = { ...stationLists.value, [key]: detail.stops }
        if (detail.directionName) {
          directionLabels.value = { ...directionLabels.value, [key]: detail.directionName }
        }
        return
      }
      // Reachable and empty: record it, so the panel can say the direction has no
      // stops instead of showing a picker that will never fill.
      stationLoadFailed.value = { ...stationLoadFailed.value, [key]: true }
    }
    catch {
      // Transient (offline, server down): leave unloaded so a later pass retries,
      // and do NOT claim the direction is unavailable — that would be a lie.
    }
  }

  /**
   * Load stop lists for every direction of the current city's followed lines.
   *
   * BOTH directions, not just the chosen one: the direction selector must show
   * "开往 X" for an option before the user picks it, and that label comes from the
   * direction's own detail. Driven by a watcher (not a one-shot call in
   * `onMounted`) because following a new line later in the session must load its
   * stops too — otherwise its picker stays empty until the page is reloaded.
   */
  async function ensureAllStations(): Promise<void> {
    const tasks: Array<Promise<void>> = []
    for (const fav of cityFavorites.value) {
      if (!fav.id) continue
      for (const opt of directionOptions(fav)) {
        tasks.push(ensureStations(fav, opt.direction, opt.lineId))
      }
    }
    await Promise.allSettled(tasks)
  }

  /**
   * Read the followed set, recording which of the three states it left the page in.
   *
   * The store's own answer decides: a read it completed makes the (possibly empty) list a
   * fact, and a read it did not complete leaves the state unreadable — never an empty list,
   * which is a claim about the user's stored rows that nobody obtained. Exposed so a page
   * whose list failed can offer the retry that is the only thing that can change it.
   */
  async function readFavorites(): Promise<void> {
    favoritesRead.value = 'reading'
    favoritesRead.value = (await transitStore.fetchFavorites()) ? 'read' : 'unreadable'
  }

  // The followed set itself, read here because it is this module's premise: without it
  // neither page has a line to show a stop list for, and a page that mounted before the
  // store had them would offer an empty list. The old one-page 设置 read it in its own
  // `onMounted`; the read moved with the code that needs it — and with the read moved the
  // ANSWER, so a page's 重试 re-runs it here rather than reaching into the store itself.
  onMounted(() => {
    void readFavorites()
  })

  // Followed set or active city changed -> load any stops not yet cached.
  // ensureStations skips what it already holds, so this stays a no-op on reruns.
  watch(
    () => cityFavorites.value
      .map(f => `${f.id}_${f.lineId}_${f.reverseLineId ?? ''}`)
      .join('|'),
    () => void ensureAllStations(),
    { immediate: true },
  )

  /**
   * The lines a chain leg may ride: the active city's followed routes, one entry per
   * direction.
   *
   * The followed lines are the source, and the choice is the chain editor's premise
   * rather than a convenience (see `ChainLineOption`): a chain records the lines the user
   * actually rides, those are the ones they follow, and this module already holds each
   * direction's own stop list — which is the only thing that can tell whether a
   * (station, order) pair is real. The reader pays for it honestly: a leg cannot name a
   * line that is not followed, and the editor says so where it offers the choice.
   *
   * The stop list's three states come from the same two maps the pin pickers use, so a
   * leg's choice can never be offered stops the board considers unavailable.
   */
  const chainLineOptions = computed<ChainLineOption[]>(() =>
    cityFavorites.value.flatMap((fav) => {
      if (!fav.id) return []
      return directionOptions(fav).map((option) => {
        const key = pinKey(fav.id!, option.direction)
        const stops = stationLists.value[key]
        return {
          key,
          direction: option.direction,
          lineId: option.lineId,
          lineName: fav.lineName,
          cityCode: fav.cityCode || cityStore.currentCode,
          directionLabel: option.label,
          stations: stops ?? [],
          stops: stops ? 'ready' : stationLoadFailed.value[key] ? 'unavailable' : 'loading',
        } satisfies ChainLineOption
      })
    }),
  )

  return {
    cityFavorites,
    favoritesRead,
    readFavorites,
    stationLists,
    stationLoadFailed,
    directionLabels,
    pinKey,
    directionOptions,
    chainLineOptions,
  }
}
