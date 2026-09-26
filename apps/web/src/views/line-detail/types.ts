/**
 * 报站板上站点标记的屏幕坐标锚点。
 *
 * 由 RouteBoard 发出，使弹窗无需伸手进画布即可贴着标记定位：screenX/screenY 是视口像素，
 * x/y 是报站板自己的坐标空间。
 */
export interface StationAnchor {
  screenX: number
  screenY: number
  radius: number
  x: number
  y: number
}

/** 线路两个行驶方向之一，作为方向切换器的一个页签。 */
export interface DirectionOption {
  direction: number
  lineId: string
  label: string
}
