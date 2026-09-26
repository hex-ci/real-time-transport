/**
 * 当前城市已关注线路，以及每个方向自己的站点列表。
 *
 * 设置是索引加四个页面，其中**两**个需要这同一次读取：关注线路要从方向的站点列表里
 * 提供一个报站站点，通勤链路要提供一个其 (站名, 站序) 可被核对的线路。要求是两者一致，
 * 而单一来源是唯一能保住这一点的方法：两份逻辑会让链路的一段拿到另一个页面上的
 * 站点选择器认为不可用的站点。
 *
 * composable 是逐页面状态而非应用状态：没有页面会与另一个并存，故挂载的页面拿到
 * 自己的列表与自己的侦听器，卸载时两者一起释放。
 */
import { computed, onMounted, shallowRef, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { resolveFavoriteLineId } from '@real-time-transport/shared/line-group'
import type { LineDetail, Station, UserFavoriteLine } from '@real-time-transport/shared'
import type { ReadState, ReadValue } from '@/read-state'
import { useCityStore } from '@/stores/city.store'
import { useTransitStore } from '@/stores/transit.store'
import type { ChainLineOption } from './types'

export function useLineStops() {
  const transitStore = useTransitStore()
  const cityStore = useCityStore()
  const { favoriteOrder } = storeToRefs(transitStore)

  /**
   * 关注集合本身是否已经作答。
   *
   * 本模块**拥有**那次读取，故它欠调用方读取自己的状态，而不是一个「空答案」与
   * 「失败」看起来一模一样的数组。`cityFavorites` 是**值**，这个是有没有值。
   */
  const favoritesRead = shallowRef<ReadState>('reading')

  /**
   * 每个已关注方向的站点，键为 `${favoriteId}_${direction}`，连同产出它们的读取。
   *
   * 用户打开站点选择器时才按需加载——一个关注项可以覆盖两个方向，各自需要从自己
   * 那个 lineId 获取的站点列表。
   *
   * 每个方向**一条**记录，持有**读取自己的**状态（`ReadValue`）：没有记录 = 还没作答，
   * `'unreadable'` = 没答上来，`'read'` 携带 API 答的一切——**空列表也包括**。
   * 空列表是一次读取的**答案**（该方向确实没有站点：有线路名、没有站表的记录是可达的），
   * 故不能与仍在途的读取混同。
   */
  const stationReads = shallowRef<Record<string, ReadValue<Station[]>>>({})
  /**
   * 方向标签，键为 `${favoriteId}_${direction}`，取自各方向数据源的 `directionName`
   * （「开往 X」）。按方向存储：公交线路的两个方向是不同的线路源，各自命名自己的终点站；
   * 在该方向的站点加载前不存在。
   */
  const directionLabels = shallowRef<Record<string, string>>({})

  function pinKey(favoriteId: string, direction: number): string {
    return `${favoriteId}_${direction}`
  }

  /**
   * 当前城市已关注的线路，按**存储**顺序。
   *
   * 读自 `favoriteOrder`，绝不读 store 自己的数组：那个数组的排序是首页呈现它用的顺序，
   * 会把某一行提到它实际存储位置之前。这些页面编辑的是存储顺序，故必须原样展示——
   * 否则用户抓住的那一行，不是落下时写入的那一行。
   */
  const cityFavorites = computed(() =>
    favoriteOrder.value.filter(f => f.cityCode === cityStore.currentCode),
  )

  /**
   * 一个关注项的通勤方向选项，每个可用方向一条。
   *
   * 公交线路的两个方向是两个 lineId，故每个选项携带其站点必须从此获取的 lineId。
   * 标签是数据源自己的 `directionName`（「开往 X」），也就是车辆终点站牌上的读法——
   * 上行/下行不在数据里，各城市之间也不一致。
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
    // 已作答的读取是定论，不再重复获取。**没有**作答的读取由下一趟重试：
    // 它被记录下来并被措辞（面板说 未读到），
    // 但后面的某一趟仍可能取到列表。
    if (stationReads.value[key]?.state === 'read') return
    try {
      const qs = new URLSearchParams({
        direction: String(direction),
        cityCode: fav.cityCode || cityStore.currentCode,
      })
      const res = await fetch(`/api/transit/lines/${encodeURIComponent(lineId)}?${qs.toString()}`)
      const json = await res.json()
      if (json.success && json.data) {
        const detail = json.data as LineDetail
        // 答了就是答了，哪怕它一条站也没有：一个只有线路名、没有站表的上游记录是真实存在的情况
        // （`holdsLineRecord` 就认这种 payload），空表因此是「这个方向没有站点数据」这个事实，
        // 与「还没读到」不是同一句话。
        stationReads.value = { ...stationReads.value, [key]: { state: 'read', value: detail.stops } }
        if (detail.directionName) {
          directionLabels.value = { ...directionLabels.value, [key]: detail.directionName }
        }
        return
      }
      // 没有拿到这条线路的详情（404，或应答里没有 data）：这一次读取没有回答本方向的站点，
      // 记下来让界面说「未读到」，而不是说这个方向没有数据 —— 后者是关于上游数据的主张。
      stationReads.value = { ...stationReads.value, [key]: { state: 'unreadable' } }
    }
    catch {
      // 瞬时故障（离线、服务端挂了）：与上面的未命中同一种措辞——关于这个方向
      // 什么都没读到——而后面的某一趟会重试。
      stationReads.value = { ...stationReads.value, [key]: { state: 'unreadable' } }
    }
  }

  /**
   * 一个方向的站点列表读取，按读取自己的三种状态。
   *
   * 没有记录的方向是 `'reading'`——还没有任何东西为它作答，任何界面都不得把这个措辞成
   * 关于该方向的事实。`'unreadable'` 是没作答的读取（重试仍可改变它），`'read'` 是**答案**，
   * 其值可能是空列表。
   */
  function stopsRead(fav: UserFavoriteLine, direction: 0 | 1): ReadValue<Station[]> {
    if (!fav.id) return { state: 'reading' }
    return stationReads.value[pinKey(fav.id, direction)] ?? { state: 'reading' }
  }

  /**
   * 一个方向的读取**作答**出的站点；尚未作答时为 `null`。
   *
   * 这里的 `null` 意思是「还没有这个事实」——不是空列表，
   * 空列表是没有站点数据的方向给出的答案。
   */
  function stopsOf(fav: UserFavoriteLine, direction: 0 | 1): Station[] | null {
    const read = stopsRead(fav, direction)
    return read.state === 'read' ? read.value : null
  }

  /**
   * 为当前城市已关注线路的每个方向加载站点列表。
   *
   * **两个**方向，而不只是所选的那一个：方向选择器必须在用户选定之前，就为一个选项显示
   * 「开往 X」，而该标签来自方向自己的详情。由侦听器驱动（而不是 `onMounted` 里的
   * 一次性调用），因为会话中后来关注的新线路也必须加载它的站点——否则它的选择器会一直
   * 空着，直到重载页面。
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
   * 读取关注集合，记录它把页面留在三种状态中的哪一种。
   *
   * 由 store 自己的答案决定：它完成的读取使（可能为空的）列表成为事实，它没完成的读取
   * 使状态为读不到——绝不是空列表，那是对用户已存记录一个无人取得过的主张。
   * 暴露出来，好让列表失败的页面给出唯一能改变它的重试。
   */
  async function readFavorites(): Promise<void> {
    favoritesRead.value = 'reading'
    favoritesRead.value = (await transitStore.fetchFavorites()) ? 'read' : 'unreadable'
  }

  // 关注集合本身在这里读取，因为它是本模块的前提：没有它，两个页面都没有线路
  // 可以展示站点列表，而一个在 store 拿到它之前挂载的页面只会给出空列表。
  // 读取随需要它的代码一起移动——**答案**也随之，
  // 故页面的重试在这里重跑它，而不是去够 store 内部。
  onMounted(() => {
    void readFavorites()
  })

  // 关注集合或当前城市变化 -> 加载尚未缓存的站点。
  // ensureStations 会跳过已持有的，故重跑时这里是空操作。
  watch(
    () => cityFavorites.value
      .map(f => `${f.id}_${f.lineId}_${f.reverseLineId ?? ''}`)
      .join('|'),
    () => void ensureAllStations(),
    { immediate: true },
  )

  /**
   * 链路的一段可以乘坐的线路：当前城市已关注线路，每个方向一条。
   *
   * 关注线路是来源，而这个选择是链路编辑器的前提而非便利（见 `ChainLineOption`）：
   * 链路记录的是用户真正乘坐的线路，那些正是他关注的线路，而本模块已经持有每个方向
   * 自己的站点列表——这是唯一能判断一对 (站名, 站序) 是否真实的东西。读者为此诚实地
   * 付代价：一段无法命名一条未被关注的线路，编辑器在提供选择之处就这么说。
   *
   * 站点列表的三种状态来自站点选择器用的同两个 map，
   * 故一段的选择绝不会被提供报告板认为不可用的站点。
   */
  const chainLineOptions = computed<ChainLineOption[]>(() =>
    cityFavorites.value.flatMap((fav) => {
      if (!fav.id) return []
      return directionOptions(fav).map((option) => {
        const key = pinKey(fav.id!, option.direction)
        const read = stopsRead(fav, option.direction)
        return {
          key,
          direction: option.direction,
          lineId: option.lineId,
          lineName: fav.lineName,
          cityCode: fav.cityCode || cityStore.currentCode,
          directionLabel: option.label,
          stations: read.state === 'read' ? read.value : [],
          // 三种读取状态映射成链路编辑器自己的话：答了就是 ready（空表由编辑器的
          // `stopsStateSentence` 说成「暂无站点数据」），没答上来与还在读都只能是 loading ——
          // 这两种状态下确实还没有一份列表可以核对那一对 (站名, 站序)。
          stops: read.state === 'read' ? 'ready' : 'loading',
        } satisfies ChainLineOption
      })
    }),
  )

  return {
    cityFavorites,
    favoritesRead,
    readFavorites,
    stopsRead,
    stopsOf,
    directionLabels,
    pinKey,
    directionOptions,
    chainLineOptions,
  }
}
