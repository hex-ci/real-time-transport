import type { CommuteChainPurpose, CommuteProfile } from '@real-time-transport/shared'

/**
 * 通勤时段蕴含的通勤目的：早通勤上班、晚通勤下班。
 *
 * 时段是**唯一**的依据，且它不由本文件判定 —— 服务端已按四个已存时刻与此刻时钟给出档位
 * （`CommuteProfile.mode`），故此处只翻译，不读时钟、不重排时刻：同一次读取在首页与链路页
 * 得出的是同一个目的（两页都调这里，不各留一份）。
 *
 * `mode: 'auto'` 同时是「此刻在两个已存时段之外」与「没有时段可跟随」—— `windowState` 分辨这两件事，
 * 而两者都没有目的可跟随，故都答 `null`。从未读到的 profile 同样答 `null`：
 * 没有人对那一行作过断言，而不存在的事实不能蕴含目的。
 *
 * `null` 是「没有可跟随的时段」这个事实，不是缺省值：界面各自的默认由调用方给
 * （首页进附近视图、链路页保持上班），故「说不出来」不会在这里长成第三个默认。
 */
export function commutePurposeOf(
  profile: CommuteProfile | null | undefined,
): CommuteChainPurpose | null {
  if (profile?.mode === 'work') return 'morning'
  if (profile?.mode === 'home') return 'evening'
  return null
}
