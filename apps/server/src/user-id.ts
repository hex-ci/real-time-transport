import { DEFAULT_USER_ID } from '@real-time-transport/shared'

/**
 * 一次请求所针对的那个 user id —— 所有接收或默认 user id 的路由共用同一套解析。
 *
 * 读写共用同一个函数，因此不可能对同一个用户各说各话。id 走哪个位置由调用方的形状决定
 * （读在 query string、写在 body），这里先读 query 再读 body；不接收 id 的路由解析为那唯一
 * 一个默认值（`DEFAULT_USER_ID`，该字面量的唯一副本）。
 *
 * 不是非空字符串的值不命名任何 user：空 `?userId=`、重复参数（以数组到达）、任何非字符串，
 * 一律按「没命名用户」处理并解析为默认值。不得把一个不是 id 的值（数组）当成 id 去问存储。
 */
export interface UserIdCarrier {
  query?: unknown
  body?: unknown
}

export function resolveUserId(request: UserIdCarrier = {}): string {
  return userIdIn(request.query) ?? userIdIn(request.body) ?? DEFAULT_USER_ID
}

function userIdIn(source: unknown): string | null {
  if (typeof source !== 'object' || source === null) return null
  const value = (source as { userId?: unknown }).userId
  return typeof value === 'string' && value.length > 0 ? value : null
}
