/**
 * 电子站牌记住「最后看的是哪个站台」，使刷新或重新进入时回到那一个，而不是列表的第一个。
 *
 * 按城市各记一个：城市切换本身是持久的，换到别的城市再换回来，该是原来那个站台。记的是站
 * **id** —— 站名、坐标与距离由列表重新给出，故上游改过名字、或人挪了位置之后，这里都不会留下
 * 一份过期的读数，也让「距离」永远只说当前这一刻的量。
 *
 * 读侧对坏值一律当「没有」：这个记忆是便利，不是凭据。它读不出来时页面该退回列表第一个，
 * 而不该在这一步出错。
 */
const STORAGE_KEY = 'rt-transit-station-board-station'

type Remembered = Record<string, string>

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  }
  catch {
    // 隐私模式下光访问 `localStorage` 就会抛。
    return null
  }
}

/** 整张表；读不到、不是 JSON、或不是对象时都当空表。 */
function readAll(): Remembered {
  try {
    const raw = storage()?.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const entries = Object.entries(parsed as Record<string, unknown>)
    return Object.fromEntries(entries.filter(([, value]) => typeof value === 'string')) as Remembered
  }
  catch {
    return {}
  }
}

/** 这个城市最后看过的站台 id；没记过、读不到或值不合法时是空串。 */
export function rememberedStationId(cityCode: string): string {
  if (!cityCode) return ''
  return readAll()[cityCode] ?? ''
}

/**
 * 记下这个城市最后看的站台。传空串即忘掉它 —— 免得下一次进入时把它当成用户的选择。
 */
export function rememberStationId(cityCode: string, stationId: string): void {
  if (!cityCode) return
  const all = readAll()
  if (stationId) all[cityCode] = stationId
  else delete all[cityCode]
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(all))
  }
  catch {
    // 写不进去就当这次没记：这是个便利，不该让换站台这件事失败。
  }
}
