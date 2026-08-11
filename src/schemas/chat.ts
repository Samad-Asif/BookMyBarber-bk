import { z } from "zod";

const messageText = z.string().trim().min(1).max(2000);
const optionalUuid = z.string().uuid().optional();
const integerClientId = z.string().max(80).optional();

export const createRoomBodySchema = z.object({
  shopId: z.string().uuid(),
  customerId: optionalUuid,
});

export const startChatBodySchema = z.object({
  shopId: z.string().uuid(),
  customerId: optionalUuid,
  message: messageText.optional(),
  clientId: integerClientId,
});

export const sendMessageBodySchema = z.object({
  message: messageText,
  clientId: integerClientId,
});

export const listRoomsQuerySchema = z.object({
  shopId: z.string().uuid().optional(),
});

export type CreateRoomBody = z.infer<typeof createRoomBodySchema>;
export type StartChatBody = z.infer<typeof startChatBodySchema>;
export type SendMessageBody = z.infer<typeof sendMessageBodySchema>;
export type ListRoomsQuery = z.infer<typeof listRoomsQuerySchema>;