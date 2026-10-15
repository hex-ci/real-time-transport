/**
 * 「到目标站还有几站」在屏幕上的说法：措辞只此一份。
 *
 * 口径与车来了一致：**下一站就是本站时是 0 站**，说「即将到站」；中间还隔一站才是 1 站。
 * 三个渲染处（头条的到站分支、头条的回退分支、弹窗里的后续进站计划）都调这里 ——
 * 各写一份时同一个数字会在三处说出三种话。
 */
export function stopsTextOf(stopsAway: number | undefined): string {
  if (stopsAway === undefined) return ''
  if (stopsAway <= 0) return '即将到站'
  return `距本站 ${stopsAway} 站`
}

/** 列表里的紧凑说法：与头条同一个口径，只是去掉「距本站」那三个字。 */
export function stopsTagTextOf(stopsAway: number | undefined): string | null {
  if (stopsAway === undefined) return null
  return stopsAway <= 0 ? '即将到站' : `(${stopsAway}站)`
}
