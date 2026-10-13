/**
 * 拥挤度以徽标展示。`unknown` 是它自己的状态，绝不是「不拥挤」的同义词：
 * 多数车辆没有拥挤度，把两者合并会把未观测到的车报成空车。
 *
 * 措辞用服务端对各自等级给出的原词——不得为没人采样过的等级合成程度词，
 * 未被上报过的等级保持「未知」。
 */

/** 徽标文字。每个判决用服务端自己给出的措辞。 */
export function congestionLabel(level: string): string {
  switch (level) {
    case 'low':
      return '不拥挤'
    case 'high':
      return '拥挤'
    default:
      return '未知'
  }
}

/** 徽标配色。`unknown` 保持中性灰——颜色不得暗示判决。 */
export function congestionClass(level: string): string {
  switch (level) {
    case 'low':
      return 'bg-emerald-500/20 text-emerald-300'
    case 'high':
      return 'bg-rose-500/20 text-rose-300'
    default:
      return 'bg-slate-800 text-slate-400'
  }
}

/**
 * 一行站台行的拥挤度芯片配色，只由判决决定。
 *
 * 同一行可以同时有真实判决与无到站分钟，故以分钟为输入会在判决已知时把芯片置灰，
 * 让颜色与印在它上面的词争吵。等级是本函数唯一的输入，分钟无法重新进入决策；
 * 中性默认使未知等级不被读成「不拥挤」。
 */
export function congestionChipClass(level: string): string {
  return congestionClass(level)
}
