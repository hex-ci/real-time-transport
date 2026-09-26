/**
 * 一张附近卡片在没有站台可报时说的话 —— 按它为什么没有来选。
 *
 * 位置事实以显式输入到达卡片，用的就是位置 store 真的能分开的那几个状态。本模块把状态变成
 * 措辞；卡片自己一个词都不说。
 */

/**
 * 应用位置的状态，按 store 报告它们的方式。
 *
 * `unsupported` 是没有定位 API 的浏览器 —— 用户没有任何东西可以打开。权限被拒与从未询问
 * 留在 `absent` 之下，因为两者的下一步相同：授予权限。`absent` 的句子说的正是这一步，所以
 * 把拒绝单独拆出来只会多一个措辞与 `absent` 相同的状态。只有浏览器欠缺的能力会改变用户能做
 * 的事，所以只有它挣得自己的一句话。
 */
export type NearbyLocationState = 'absent' | 'locating' | 'fix' | 'unsupported'

/**
 * store 对「是否有定位」的回答，变成这些状态。
 *
 * 由 store「自己」的那几项读取组合，而不是在这里另造一个标志：`userCoords` 是定位，
 * `isLocating` 是请求在途，`locationError` 是请求以失败作答，`isSupported` 是这个浏览器
 * 到底能不能定位。失败是 `absent`，绝不是 `locating` —— 一个已经被拒绝的请求不是还在来的
 * 请求，在它上面说「正在获取定位…」会承诺一个不会到来的定位。
 *
 * 读取顺序就是答案的顺序：手上已有定位先读，因为报了位置就是有位置，不管能力那一项说什么；
 * 接着读能力，因为一个没有 API 的浏览器不是「失败了没答」的请求，不能按那个措辞。
 */
export function nearbyLocationStateOf(input: {
  hasFix: boolean
  requesting: boolean
  failed: boolean
  supported: boolean
}): NearbyLocationState {
  if (input.hasFix) return 'fix'
  if (!input.supported) return 'unsupported'
  return input.requesting && !input.failed ? 'locating' : 'absent'
}

/** 一张没有站台可报的卡片说的一句，按它为什么没有来分。 */
export function nearbyEmptyNoticeOf(state: NearbyLocationState): string {
  // 四种成因，四句话：其中两种只能由位置状态分开，而「已经有位置」的用户绝不能被送去开启
  // 定位。只有 `absent` 有给用户的动作；另三种陈述事实后停下 —— 而 `unsupported` 点出唯一
  // 能改变结果的东西：一个能定位的浏览器。
  const notices: Record<NearbyLocationState, string> = {
    absent: '开启定位后显示离你最近的站点车辆',
    locating: '正在获取定位…',
    fix: '已定位，但附近没有该线路的站台',
    unsupported: '当前浏览器不支持定位，请换用其他浏览器',
  }
  return notices[state]
}
