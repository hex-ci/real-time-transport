import { z } from 'zod'
import { LiveLineStatusSchema } from './transit.js'

export const WsClientMessageSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('subscribe'),
    lineId: z.string(),
    direction: z.number().int().min(0).max(1).default(0),
    cityCode: z.string().default('027'),
  }),
  z.object({
    action: z.literal('unsubscribe'),
    lineId: z.string(),
    /** 省略表示退订该线路的全部方向。 */
    direction: z.number().int().min(0).max(1).optional(),
  }),
  z.object({
    action: z.literal('ping'),
  }),
])
export type WsClientMessage = z.infer<typeof WsClientMessageSchema>

export const WsServerMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('line_update'),
    lineId: z.string(),
    /** 本条更新所属的方向，客户端据此过滤不匹配的更新。 */
    direction: z.number().int().min(0).max(1).default(0),
    status: LiveLineStatusSchema,
  }),
  z.object({
    type: z.literal('pong'),
  }),
  z.object({
    type: z.literal('error'),
    message: z.string(),
  }),
])
export type WsServerMessage = z.infer<typeof WsServerMessageSchema>
