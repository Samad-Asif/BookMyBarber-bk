import { Router, Request, Response } from "express";
import { authenticate, authorize } from "../../../middleware/auth";
import { asyncHandler } from "../../../middleware/asyncHandler";
import { ApiError } from "../../../lib/errors";
import { param } from "../../../lib/params";
import { generateChatAiReply } from "../../../services/gemini.service";
import { getSupabaseSecret } from "../../../config/supabase";
import {
  createRoomBodySchema,
  startChatBodySchema,
  sendMessageBodySchema,
  listRoomsQuerySchema,
} from "../../../schemas/chat";
import {
  ensureChatRoom,
  getChatRoomMessages,
  listChatRoomSummaries,
  markChatRoomRead,
  mintChatRealtimeToken,
  sendChatMessage,
} from "../../../services/chat.service";

const router = Router();

router.get(
  "/realtime-token",
  authenticate,
  authorize("customer", "barber"),
  asyncHandler(async (req: Request, res: Response) => {
    res.json({ realtimeToken: mintChatRealtimeToken({ userId: req.user!.id }) });
  })
);

router.get(
  "/rooms",
  authenticate,
  authorize("customer", "barber"),
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = listRoomsQuerySchema.parse(req.query ?? {});
    const rooms = await listChatRoomSummaries(
      { id: req.user!.id, role: req.user!.role as "customer" | "barber" },
      { shopId: parsed.shopId }
    );
    res.json({ rooms });
  })
);

router.post(
  "/rooms",
  authenticate,
  authorize("customer", "barber"),
  asyncHandler(async (req: Request, res: Response) => {
    const body = createRoomBodySchema.parse(req.body ?? {});

    let customerId: string;
    if (req.user!.role === "customer") {
      customerId = req.user!.id;
    } else {
      if (!body.customerId) throw new ApiError(400, "customerId is required for barbers", "VALIDATION_ERROR");
      await assertBarberOwnsShop(req.user!.id, body.shopId);
      customerId = body.customerId;
    }

    await ensureChatRoom({ customerId, shopId: body.shopId });
    const rooms = await listChatRoomSummaries(
      { id: req.user!.id, role: req.user!.role as "customer" | "barber" },
      { shopId: body.shopId }
    );
    const room = rooms.find((r) => r.customerId === customerId) ?? rooms[0];
    if (!room) throw new ApiError(400, "Room could not be created", "DB_ERROR");
    res.status(201).json({ room });
  })
);

router.post(
  "/start",
  authenticate,
  authorize("customer", "barber"),
  asyncHandler(async (req: Request, res: Response) => {
    const body = startChatBodySchema.parse(req.body ?? {});

    let customerId: string;
    if (req.user!.role === "customer") {
      customerId = req.user!.id;
    } else {
      if (!body.customerId) throw new ApiError(400, "customerId is required for barbers", "VALIDATION_ERROR");
      await assertBarberOwnsShop(req.user!.id, body.shopId);
      customerId = body.customerId;
    }

    const room = await ensureChatRoom({ customerId, shopId: body.shopId });
    let message: ReturnType<typeof sendChatMessage> extends Promise<infer T> ? Awaited<T> : never;
    let sent: Awaited<ReturnType<typeof sendChatMessage>> | undefined;
    if (body.message) {
      sent = await sendChatMessage({
        roomId: room.id,
        senderId: req.user!.id,
        message: body.message,
        clientId: body.clientId,
      });
    }

    const roomRow = await listChatRoomSummaries(
      { id: req.user!.id, role: req.user!.role as "customer" | "barber" },
      { shopId: body.shopId }
    ).then((rooms) => rooms.find((r) => r.id === room.id));

    res.status(201).json({ room: roomRow, message: sent ?? null });
  })
);

router.get(
  "/rooms/:roomId/messages",
  authenticate,
  authorize("customer", "barber"),
  asyncHandler(async (req: Request, res: Response) => {
    const messages = await getChatRoomMessages({
      roomId: param(req, "roomId"),
      userId: req.user!.id,
    });
    res.json({ messages });
  })
);

router.post(
  "/rooms/:roomId/messages",
  authenticate,
  authorize("customer", "barber"),
  asyncHandler(async (req: Request, res: Response) => {
    const body = sendMessageBodySchema.parse(req.body ?? {});

    const supabase = getSupabaseSecret();
    const { data: room } = await supabase
      .from("chat_rooms")
      .select("customer_id, barber_id")
      .eq("id", param(req, "roomId"))
      .maybeSingle();
    if (!room) throw new ApiError(404, "Room not found", "NOT_FOUND");
    const uid = req.user!.id;
    if (room.customer_id !== uid && room.barber_id !== uid) {
      throw new ApiError(403, "Not a participant", "FORBIDDEN");
    }

    const message = await sendChatMessage({
      roomId: param(req, "roomId"),
      senderId: req.user!.id,
      message: body.message,
      clientId: body.clientId,
    });
    res.status(201).json({ message });
  })
);

router.patch(
  "/rooms/:roomId/read",
  authenticate,
  authorize("customer", "barber"),
  asyncHandler(async (req: Request, res: Response) => {
    await getChatRoomMessages({ roomId: param(req, "roomId"), userId: req.user!.id }); // participant gate
    await markChatRoomRead({ roomId: param(req, "roomId"), userId: req.user!.id });
    res.json({ ok: true });
  })
);

router.post(
  "/rooms/:roomId/ai",
  authenticate,
  authorize("customer", "barber"),
  asyncHandler(async (req: Request, res: Response) => {
    const { message } = req.body ?? {};
    if (!message?.trim()) {
      throw new ApiError(400, "message is required", "VALIDATION_ERROR");
    }
    const supabase = getSupabaseSecret();
    const { data: room } = await supabase
      .from("chat_rooms")
      .select("*")
      .eq("id", param(req, "roomId"))
      .single();
    if (!room) throw new ApiError(404, "Room not found", "NOT_FOUND");
    const uid = req.user!.id;
    if (room.customer_id !== uid && room.barber_id !== uid) {
      throw new ApiError(403, "Not a participant", "FORBIDDEN");
    }

    await supabase.from("chat_messages").insert({
      room_id: param(req, "roomId"),
      sender_id: uid,
      message: message.trim(),
      is_ai: false,
    });

    const reply = await generateChatAiReply(param(req, "roomId"), message.trim());
    const { data: aiMsg, error } = await supabase
      .from("chat_messages")
      .insert({
        room_id: param(req, "roomId"),
        sender_id: null,
        message: reply,
        is_ai: true,
      })
      .select()
      .single();
    if (error) throw new ApiError(500, error.message, "DB_ERROR");
    res.json({ message: aiMsg });
  })
);

async function assertBarberOwnsShop(barberId: string, shopId: string): Promise<void> {
  const supabase = getSupabaseSecret();
  const { data } = await supabase
    .from("barber_shops")
    .select("id")
    .eq("id", shopId)
    .eq("owner_id", barberId)
    .maybeSingle();
  if (!data) throw new ApiError(403, "Not your shop", "FORBIDDEN");
}

export default router;