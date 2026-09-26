import type { OperatingStatus } from '@real-time-transport/shared'

/**
 * 运营状态，作为牌子上那行字。
 *
 * 没有车可显示的牌子只有四句话可说，且互不通用：未到首班、已过末班、运营中但没有车在范围
 * 内、运营时间未知。服务端决定是哪一个；这个模块把状态变成使用者读到的话，所以这句文案是
 * 可断言的事实，而不是只有浏览器能检查的模板。
 *
 * 只陈述事实，不指任何数据源，不告诉使用者该做什么。
 */

/**
 * 只有状态，给紧凑控件用的短词 —— 不带它所指的时间。同样的四个状态、同样一字一状态，所以
 * 角标与整行永远不可能对同一个状态各说一套。
 */
export function operatingLabelOf(status: OperatingStatus | null | undefined): string {
  if (!status) return '暂无来车'
  if (status.state === 'before_first') return '未到首班'
  if (status.state === 'after_last') return '已过末班'
  if (status.state === 'operating') return '运营中'
  return '运营时间未知'
}

/**
 * 实时页的角标：真正在线上跑的车可以压过排班，但只能是真实的车。
 *
 * `hasRealVehicle` 是 payload 自己声明的来源经 `vehicleProvenanceOf` 分类的结果，绝不是
 * 车辆的条数 —— 条数分不出这个区别，生成的数据也绝不能压过一个已知的未知。没有真实车辆时
 * 角标就是状态本身，一字不改。
 */
export function operatingBadgeOf(
  hasRealVehicle: boolean,
  status: OperatingStatus | null | undefined,
): string {
  return hasRealVehicle ? '有车在途' : operatingLabelOf(status)
}

/** 事实本身，时间已知时带上它所指的时间。 */
export function operatingTextOf(status: OperatingStatus | null | undefined): string {
  if (!status) return '暂无来车'

  if (status.state === 'before_first') {
    return status.firstDeparture ? `未到首班 · 首班 ${status.firstDeparture}` : '未到首班'
  }
  if (status.state === 'after_last') {
    return status.lastDeparture ? `已过末班 · 末班 ${status.lastDeparture}` : '已过末班'
  }
  if (status.state === 'operating') {
    // 运营中但没有车在范围内：两截都是事实。
    return '运营中 · 暂无来车'
  }
  return '运营时间未知 · 暂无来车'
}
