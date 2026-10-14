/**
 * 一条线路的详情页地址：**线路 id + 方向 + 城市**三件事定一个地址，规则只此一份。
 *
 * 首页卡片与电子站牌的行都要指向详情页，各写一份字面量就会漂移（少一个方向参数，点进去看到
 * 的是另一个方向）。
 */
export function detailHrefOf(lineId: string, direction: 0 | 1, cityCode: string): string {
  const qs = new URLSearchParams({
    direction: String(direction),
    cityCode,
  })
  return `/line/${encodeURIComponent(lineId)}?${qs.toString()}`
}
