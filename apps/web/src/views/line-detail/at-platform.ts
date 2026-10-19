/**
 * 「车辆正在本站」唯一的措辞。
 *
 * 本页三个分支陈述同一个事实：到站答案的首行，以及该答案落地前窗口内的两个 live 回退。
 * 它是关于车在哪里的陈述，不是数字：面板对它不给标记也不给分钟——旁边的分钟会把本应用的算术
 * 扮成来源的观测。
 * 一个常量而非三处字面量，故三个分支不会为一个事实漂成三句话。
 */
export const AT_PLATFORM_ETA_TEXT = '车辆正在本站 (即将发车)'

/**
 * 终点站到站后的措辞。
 *
 * 终点站是这一程的结束，不是下一班的发车点。上游没有「回库/回厂/折返」这类调度字段，
 * 因此只陈述它能确认的事实，不替它编一个去向。
 */
export const AT_TERMINAL_ETA_TEXT = '车辆已到达终点站 (本班次结束)'
export const AT_TERMINAL_SUBWAY_ETA_TEXT = '列车已到达终点站 (本班次结束)'

export function atStationEtaText(isTerminal: boolean, isSubway: boolean): string {
  if (!isTerminal) return AT_PLATFORM_ETA_TEXT
  return isSubway ? AT_TERMINAL_SUBWAY_ETA_TEXT : AT_TERMINAL_ETA_TEXT
}

/**
 * 这一站是不是本方向终点。
 *
 * 环线的首末站是同一站，没有「到终点后这一程结束」的语义；线路图也不给环线标首末站。
 * 站序是这里唯一的身份，站名只用来识别环线。
 */
export function isTerminalStop(
  stops: readonly { name: string, order: number }[],
  order: number | undefined,
): boolean {
  if (order === undefined || stops.length < 2) return false
  const last = stops[stops.length - 1]
  if (!last || last.order !== order) return false
  return stops[0]?.name !== last.name
}
