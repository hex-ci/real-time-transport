/** 地标提示渲染的雷达距离；缺失就什么都不渲染，不补 0、也不印 NaN。 */
export function statedDistanceSuffix(meters: number | undefined): string {
  // 缺失与非有限值同义，都渲染为空；而陈述的 0 是真测量，保留。
  if (typeof meters !== 'number' || !Number.isFinite(meters)) return ''
  return `（${Math.round(meters)}m）`
}
