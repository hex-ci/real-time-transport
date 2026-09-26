/**
 * 一次读取有三种状态，不是两种：还在读、读失败、读到了。
 *
 * 读到失败与读到空都给出空数组，把空数组渲染成「还没有关注线路」就是替一次没答上来的读取
 * 作主张。状态模型与失败时的事实子句放这里一次，后果由各界面自行表述。
 */

export type ReadState = 'reading' | 'unreadable' | 'read'

export type ReadValue<T>
  = | { state: 'reading' }
    | { state: 'unreadable' }
    | { state: 'read', value: T }

/**
 * 关注线路读取失败时的事实子句，`consequence` 是界面因这次失败说不出的话。
 *
 * 「未读到」是「读取没有回答」的说法，不是「没有」——后者是关于存了什么的主张。
 */
export function followedLinesUnreadableText(consequence: string): string {
  return unreadText('关注线路', consequence)
}

/**
 * 与 `ReadState` 的 `'unreadable'` 配套：只有那一个状态可以用这句话。
 */
export function unreadText(subject: string, consequence: string): string {
  return `未读到${subject}，${consequence}`
}

/**
 * 与 `'reading'` 配套：读还没回来时，任何关于被读对象的断言都还没有人得到过。
 */
export function readingText(subject: string): string {
  return `正在读取${subject}…`
}
