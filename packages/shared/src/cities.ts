/**
 * 多城市支持层。
 * HOT_CITY_META 为热门城市人工维护 GIS 元数据；城市全表由上游城市列表生成，禁止手改。
 */

export interface TransitCity {
  /** chelaile cityId，如北京的 '027'。 */
  code: string
  name: string
  pinyin: string
  /** 上游是否报告该城市支持地铁实时。 */
  hasMetro: boolean
  /** 人工维护的热门城市（选择器置顶）。 */
  hot: boolean
}

export { CITY_DICTIONARY } from './cities.generated.js'

/** 热门城市用于 amap GIS 调用的额外元数据。 */
export interface CityGisMeta {
  code: string
  name: string
  /** amap adcode，用于 GIS 接口的城市限定。 */
  adcode: string
  pinyin?: string
}

export const HOT_CITY_META: CityGisMeta[] = [
  // 一线城市与直辖市
  { code: '027', name: '北京', adcode: '110000', pinyin: 'beijing' },
  { code: 'amap_120000', name: '天津', adcode: '120000', pinyin: 'tianjin' },
  { code: '034', name: '上海', adcode: '310000', pinyin: 'shanghai' },
  { code: 'amap_440100', name: '广州', adcode: '440100', pinyin: 'guangzhou' },
  { code: 'amap_440300', name: '深圳', adcode: '440300', pinyin: 'shenzhen' },
  // 主要区域中心城市
  { code: '004', name: '杭州', adcode: '330100', pinyin: 'hangzhou' },
  { code: '007', name: '成都', adcode: '510100', pinyin: 'chengdu' },
  { code: '000', name: '武汉', adcode: '420100', pinyin: 'wuhan' },
  { code: '003', name: '重庆', adcode: '500000', pinyin: 'chongqing' },
  { code: '076', name: '西安', adcode: '610100', pinyin: 'xian' },
  { code: '018', name: '南京', adcode: '320100', pinyin: 'nanjing' },
  { code: '011', name: '苏州', adcode: '320500', pinyin: 'suzhou' },
  { code: '010', name: '郑州', adcode: '410100', pinyin: 'zhengzhou' },
  { code: '066', name: '长沙', adcode: '430100', pinyin: 'changsha' },
  { code: '009', name: '青岛', adcode: '370200', pinyin: 'qingdao' },
  { code: '035', name: '沈阳', adcode: '210100', pinyin: 'shenyang' },
  { code: '061', name: '长春', adcode: '220100', pinyin: 'changchun' },
  { code: '096', name: '哈尔滨', adcode: '230100', pinyin: 'haerbin' },
  { code: '005', name: '合肥', adcode: '340100', pinyin: 'hefei' },
  { code: '081', name: '昆明', adcode: '530100', pinyin: 'kunming' },
  { code: '083', name: '贵阳', adcode: '520100', pinyin: 'guiyang' },
  { code: '047', name: '福州', adcode: '350100', pinyin: 'fuzhou' },
  { code: '022', name: '南昌', adcode: '360100', pinyin: 'nanchang' },
  { code: '041', name: '济南', adcode: '370100', pinyin: 'jinan' },
  { code: '053', name: '石家庄', adcode: '130100', pinyin: 'shijiazhuang' },
  { code: '020', name: '太原', adcode: '140100', pinyin: 'taiyuan' },
  { code: '001', name: '乌鲁木齐', adcode: '650100', pinyin: 'wulumuqi' },
  { code: '046', name: '南宁', adcode: '450100', pinyin: 'nanning' },
  { code: 'amap_350200', name: '厦门', adcode: '350200', pinyin: 'xiamen' },
  { code: 'amap_620100', name: '兰州', adcode: '620100', pinyin: 'lanzhou' },
]

const AD_CODE_MAP: Record<string, string> = Object.fromEntries(
  HOT_CITY_META.map(c => [c.code, c.adcode]),
)

const CODE_NAME_MAP: Record<string, string> = Object.fromEntries(
  HOT_CITY_META.map(c => [c.code, c.name]),
)

/** 城市码对应的 amap adcode；未知城市回落到城市码本身。 */
export function getCityAdcode(cityCode: string): string {
  return AD_CODE_MAP[cityCode] || cityCode
}

/** 城市码的人工维护显示名；非热门城市为 undefined。 */
export function getCuratedCityName(cityCode: string): string | undefined {
  return CODE_NAME_MAP[cityCode]
}
