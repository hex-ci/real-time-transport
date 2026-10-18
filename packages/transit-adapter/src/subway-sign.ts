import crypto from 'node:crypto'

/**
 * 车来了 H5/APK 接口的 `sign`：时间戳的 3DES/ECB/PKCS5 再 Base64。
 *
 * 客户端每次请求现算，服务端不校验时间窗（实测 2020 年的抓包与 2026 年的
 * 当前毫秒都能通过），所以这里也只按「官方算法」算，不伪造设备指纹。
 */
const DEFAULT_SUBWAY_SIGN_KEY = 'woqunimalegebi1234567890'

/**
 * 默认用内置的正式 key；需要换 key 时用 `CHELAILE_SUBWAY_SIGN_KEY` 覆盖。
 * 长度不对时直接失败，避免带着一把无效 key 去请求。
 */
export function getSubwaySignKey(): string {
  const key = process.env.CHELAILE_SUBWAY_SIGN_KEY?.trim() || DEFAULT_SUBWAY_SIGN_KEY
  if (Buffer.byteLength(key, 'utf8') !== 24) {
    throw new Error('CHELAILE_SUBWAY_SIGN_KEY must be 24 bytes')
  }
  return key
}

export function signSubwayTimestamp(ms: number, key: string = getSubwaySignKey()): string {
  const cipher = crypto.createCipheriv('des-ede3', Buffer.from(key, 'utf8'), null)
  return Buffer.concat([cipher.update(String(ms), 'utf8'), cipher.final()]).toString('base64')
}
