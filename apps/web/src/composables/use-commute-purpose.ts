import { computed, onMounted, onUnmounted, shallowRef } from 'vue'
import { DEFAULT_COMMUTE_HOURS } from '@real-time-transport/shared'

export type CommutePurpose = 'morning' | 'evening'

interface CommuteHours {
  morningStart: string | null
  morningEnd: string | null
  eveningStart: string | null
  eveningEnd: string | null
}

function toMinutes(hhmm: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm)
  if (!m) return null
  return Number(m[1]) * 60 + Number(m[2])
}

function inWindow(nowMin: number, start: string | null, end: string | null): boolean {
  const s = start ? toMinutes(start) : null
  const e = end ? toMinutes(end) : null
  if (s === null || e === null) return false
  // 跨午夜的窗口（极少）：按两段算。
  if (e <= s) return nowMin >= s || nowMin < e
  return nowMin >= s && nowMin < e
}

/**
 * 纯函数：给定四个时刻与"现在是几点几分"，回答处于哪个通勤时段。
 * 抽出来是为了可测试；界面层用 `useCommutePurpose`。
 */
export function purposeForMinutes(hours: CommuteHours | null, nowMin: number): CommutePurpose | null {
  const h = hours ?? DEFAULT_COMMUTE_HOURS
  if (inWindow(nowMin, h.morningStart, h.morningEnd)) return 'morning'
  if (inWindow(nowMin, h.eveningStart, h.eveningEnd)) return 'evening'
  return null
}

/**
 * 当前处于哪个通勤时段。
 *
 * 读 `/api/transit/settings` 的四个时刻；从未设置过时按 DEFAULT_COMMUTE_HOURS
 * 启发式判断 —— 这只决定镜头往哪看（行为），不在界面上把默认值说成用户的选择。
 * 每 60 秒重算一次，页面开着跨过时段边界时也能跟上。
 */
export function useCommutePurpose() {
  const hours = shallowRef<CommuteHours | null>(null)
  const tick = shallowRef(0)
  let timer: ReturnType<typeof setInterval> | null = null

  const currentPurpose = computed<CommutePurpose | null>(() => {
    // 读一下 tick，让每分钟的重算能触发。
    void tick.value
    const now = new Date()
    return purposeForMinutes(hours.value, now.getHours() * 60 + now.getMinutes())
  })

  onMounted(async () => {
    try {
      const res = await fetch('/api/transit/settings')
      const json = await res.json()
      const d = json?.data
      if (d && typeof d === 'object') {
        hours.value = {
          morningStart: typeof d.morningStart === 'string' ? d.morningStart : null,
          morningEnd: typeof d.morningEnd === 'string' ? d.morningEnd : null,
          eveningStart: typeof d.eveningStart === 'string' ? d.eveningStart : null,
          eveningEnd: typeof d.eveningEnd === 'string' ? d.eveningEnd : null,
        }
      }
    }
    catch {
      // 读不到就用默认窗口启发式：下面 computed 的回退会接住。
    }
    timer = setInterval(() => {
      tick.value++
    }, 60_000)
  })

  onUnmounted(() => {
    if (timer) clearInterval(timer)
  })

  return { currentPurpose }
}
