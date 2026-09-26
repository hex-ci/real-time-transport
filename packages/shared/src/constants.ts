/** 未指名用户的请求所归属的 id —— 全项目唯一副本，别处不得再写同一字面量。 */
export const DEFAULT_USER_ID = 'default_user'

export const DEFAULT_COMMUTE_HOURS = {
  morningStart: '06:30',
  morningEnd: '11:30',
  eveningStart: '17:00',
  eveningEnd: '22:00',
} as const

/** 用户尚未选择城市时的兜底城市 chelaile cityId。 */
export const DEFAULT_CITY_CODE = '027'
