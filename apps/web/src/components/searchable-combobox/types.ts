/** 一个选项的两段文字，以及它自己的身份。 */
export interface ComboboxOption {
  /**
   * 选项的身份，也是控件的值。两个选项的**主文本**相同时（线路上同名站不止一个）靠它区分：
   * 把主文本当值会让第二个静默变成第一个。
   */
  key: string
  /** 主文本：使用者在这一个选项上认的东西。 */
  primary: string
  /** 次要细节，挂在主文本旁；没有就是 null。 */
  secondary: string | null
}

/** 过滤谓词；`query` 已去空白并转小写。 */
export type OptionsMatch = (option: ComboboxOption, query: string) => boolean

/**
 * 触发器要显示的那一段值。
 *
 * 由调用方给出，而不是去 `options` 里找：值可以不在列表里——列表还没读到，或已不再持有它
 * （由**另一个**方向服务的站）。
 */
export interface SelectedText {
  primary: string
  secondary: string | null
}
