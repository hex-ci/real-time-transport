/**
 * Multi-city support layer.
 * CITY_DICTIONARY (497 cities) is auto-generated from the chelaile realtime city list.
 * HOT_CITY_META enriches the most common cities with amap adcode for GIS features.
 */

export interface TransitCity {
  /** chelaile cityId, e.g. '027' for Beijing */
  code: string
  name: string
  pinyin: string
  /** whether chelaile reports realtime subway support for this city */
  hasMetro: boolean
  /** curated hot city (shown at top of picker) */
  hot: boolean
}

export { CITY_DICTIONARY } from './cities.generated.js'

/** Extra metadata for amap GIS calls (adcode) on curated hot cities. */
export interface CityGisMeta {
  code: string
  name: string
  /** amap adcode, used for v3/bus/linename & v3/place/around city scoping */
  adcode: string
}

export const HOT_CITY_META: CityGisMeta[] = [
  // Tier-1 first
  { code: '027', name: '北京', adcode: '110000' },
  { code: '034', name: '上海', adcode: '310000' },
  { code: 'amap_440100', name: '广州', adcode: '440100' },
  { code: 'amap_440300', name: '深圳', adcode: '440300' },
  // Major metro cities covered by chelaile realtime
  { code: '004', name: '杭州', adcode: '330100' },
  { code: '018', name: '南京', adcode: '320100' },
  { code: '007', name: '成都', adcode: '510100' },
  { code: '000', name: '武汉', adcode: '420100' },
  { code: '003', name: '重庆', adcode: '500000' },
  { code: '076', name: '西安', adcode: '610100' },
  { code: '011', name: '苏州', adcode: '320500' },
  { code: '010', name: '郑州', adcode: '410100' },
  { code: '066', name: '长沙', adcode: '430100' },
  { code: '009', name: '青岛', adcode: '370200' },
  { code: '035', name: '沈阳', adcode: '210100' },
  { code: '061', name: '长春', adcode: '220100' },
  { code: '096', name: '哈尔滨', adcode: '230100' },
  { code: '005', name: '合肥', adcode: '340100' },
  { code: '081', name: '昆明', adcode: '530100' },
  { code: '083', name: '贵阳', adcode: '520100' },
  { code: '047', name: '福州', adcode: '350100' },
  { code: '022', name: '南昌', adcode: '360100' },
  { code: '041', name: '济南', adcode: '370100' },
  { code: '053', name: '石家庄', adcode: '130100' },
  { code: '020', name: '太原', adcode: '140100' },
  { code: '001', name: '乌鲁木齐', adcode: '650100' },
  { code: '046', name: '南宁', adcode: '450100' },
  // Metro cities not in chelaile realtime list (subway sim still works via amap)
  { code: 'amap_120000', name: '天津', adcode: '120000' },
  { code: 'amap_350200', name: '厦门', adcode: '350200' },
  { code: 'amap_620100', name: '兰州', adcode: '620100' },
]

const AD_CODE_MAP: Record<string, string> = Object.fromEntries(
  HOT_CITY_META.map(c => [c.code, c.adcode]),
)

const CODE_NAME_MAP: Record<string, string> = Object.fromEntries(
  HOT_CITY_META.map(c => [c.code, c.name]),
)

/** Amap adcode for a city code. Falls back to the code itself for unknown cities. */
export function getCityAdcode(cityCode: string): string {
  return AD_CODE_MAP[cityCode] || cityCode
}

/** Curated display name for a city code (undefined for non-curated cities). */
export function getCuratedCityName(cityCode: string): string | undefined {
  return CODE_NAME_MAP[cityCode]
}

export const DEFAULT_CITY_CODE = '027'
