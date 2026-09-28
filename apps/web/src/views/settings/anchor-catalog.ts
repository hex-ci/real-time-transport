/**
 * 「家 / 公司」这一对锚点的一张表：界面上怎么称呼它们，以及 PATCH 时它们的线上字段名。
 *
 * 两个锚点是**同构**的（`/settings/anchors/home` 与 `/settings/anchors/work` 共用一个页面），
 * 差别只在文案与图标，故差异全在这张表里：加第三个锚点只是这里加一行，不是复制一个页面。
 *
 * 线上字段名刻意与文案同处一行：写请求体的人就是读这张表的人，而契约改名而这张表没跟上
 * 会让 PATCH 静默写不进去（端点不收那些字段）。`anchors.ts` 的读侧用的是同一个契约的
 * 另一组名字，两者都由 `packages/shared` 的 `UserSettingsSchema` 定义。
 */
import { Building2, Home } from '@lucide/vue'
import type { AnchorId } from './anchors'

export interface AnchorCatalogEntry {
  id: AnchorId
  /** 界面上对它的称呼：家 / 公司。 */
  label: string
  icon: typeof Home
  /** 该页自己的 `<h2>`。 */
  heading: string
  /** 保存按钮上那句：动作的对象是哪一个锚点。 */
  saveLabel: string
  /** PATCH 请求体里的坐标与来源字段名。 */
  latKey: 'homeLat' | 'workLat'
  lngKey: 'homeLng' | 'workLng'
  placeNameKey: 'homePlaceName' | 'workPlaceName'
  sourceKey: 'homeAnchorSource' | 'workAnchorSource'
}

/** 两个锚点，按它们在索引页与设置索引里的次序。 */
const ENTRIES: readonly AnchorCatalogEntry[] = [
  {
    id: 'home',
    label: '家',
    icon: Home,
    heading: '设置「家」',
    saveLabel: '保存',
    latKey: 'homeLat',
    lngKey: 'homeLng',
    placeNameKey: 'homePlaceName',
    sourceKey: 'homeAnchorSource',
  },
  {
    id: 'work',
    label: '公司',
    icon: Building2,
    heading: '设置「公司」',
    saveLabel: '保存',
    latKey: 'workLat',
    lngKey: 'workLng',
    placeNameKey: 'workPlaceName',
    sourceKey: 'workAnchorSource',
  },
]

/** 两个锚点，按既定次序。 */
export const ANCHOR_ENTRIES: readonly AnchorCatalogEntry[] = ENTRIES

/** 一个锚点的全部文案与字段名。 */
export function anchorEntry(id: AnchorId): AnchorCatalogEntry {
  return ENTRIES.find(entry => entry.id === id)!
}

/**
 * 路由参数 -> 锚点，**认不出就是 null**。
 *
 * 绝不回落成 `home`：一个写错的地址（`/settings/anchors/offices`）按「家」渲染，会让用户
 * 在以为自己在设公司的时候改掉家。路由表里那条 `(home|work)` 正则让它在导航层面直接落到
 * 404 页；本函数是页面自己的那一半 —— 组件被以别的参数挂载时（例如测试，或将来有人改了
 * 路由表），它同样不发明一个默认值。
 */
export function anchorOf(param: unknown): AnchorId | null {
  return ENTRIES.find(entry => entry.id === param)?.id ?? null
}
