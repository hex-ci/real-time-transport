/**
 * 线路页的两种「没有」，各自一句。
 *
 * 线路号不存在与一次读取失败是两个事实。HTTP 状态是唯一能分辨它们的东西：404 是详情路由
 * 自己的「没有这条线路」，其余（5xx、200 但详情为空、请求没到达）都是可能再试成功的一次
 * 加载失败。所以两种状态各自说自己的原因与动作，只有后者能给出重试。
 *
 * 文案放这里而不是组件里，是为了能被断言成文本（这个应用没有 DOM 测试台），组件渲染它返回
 * 的东西。两句都是中文且都不含拉丁字母：服务端的 `error` 串绝不能进标题。
 */

export type LineLoadState = 'not-found' | 'unavailable'

/**
 * 这个 HTTP 状态对应哪一种。
 *
 * 404 是详情路由自己的拒绝：它请求的 id 产生不出详情。其余任何状态都是「这次读取没送到」，
 * 那是重试可能改变的状态。
 */
export function lineLoadStateOf(status: number): LineLoadState {
  return status === 404 ? 'not-found' : 'unavailable'
}

/**
 * 两种状态各自的标题与它下面那句话。
 *
 * 两句都是中文且都不含拉丁字母：应用没有 i18n，服务端的 `error` 串不能进标题。
 */
export function lineLoadNoticeOf(state: LineLoadState): { title: string, detail: string } {
  if (state === 'not-found') {
    return {
      title: '线路不存在',
      // 地址指的是一个不存在的线路号，等多久都不会变：动作是重新选线路，不是重试。
      detail: '没有找到这个线路号，请返回总览重新选择线路',
    }
  }
  return {
    title: '线路数据加载失败',
    detail: '未能加载该线路数据，请稍后重试',
  }
}
