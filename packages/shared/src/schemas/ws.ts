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
    /** Optional: omit to drop every direction of the line. */
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
    /** Direction this update belongs to, so the client can filter mismatches. */
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
