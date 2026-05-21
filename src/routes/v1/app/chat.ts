import { Router, Request, Response } from "express";
import { authenticate, authorize } from "../../../middleware/auth";
import { asyncHandler } from "../../../middleware/asyncHandler";
import { getSupabaseSecret } from "../../../config/supabase";
import { ApiError } from "../../../lib/errors";
import { generateChatAiReply } from "../../../services/gemini.service";
import { param } from "../../../lib/params";

const router = Router();

router.get(
  "/rooms",
  authenticate,
  authorize("customer", "barber"),
  asyncHandler(async (req: Request, res: Response) => {
    const supabase = getSupabaseSecret();
    const col =
      req.user!.role === "customer" ? "customer_id" : "barber_id";

    const { data, error } = await supabase
      .from("chat_rooms")
      .select("*")
      .eq(col, req.user!.id)
      .order("created_at", { ascending: false });

    if (error) throw new ApiError(500, error.message, "DB_ERROR");
    res.json({ rooms: data ?? [] });
  })
);

router.post(
  "/rooms",
  authenticate,
  authorize("customer"),
  asyncHandler(async (req: Request, res: Response) => {
    const { barberId } = req.body ?? {};
    if (!barberId) {
      throw new ApiError(400, "barberId is required", "VALIDATION_ERROR");
    }

    const supabase = getSupabaseSecret();
    const { data, error } = await supabase
      .from("chat_rooms")
      .upsert(
        { customer_id: req.user!.id, barber_id: barberId },
        { onConflict: "customer_id,barber_id" }
      )
      .select()
      .single();

    if (error) throw new ApiError(400, error.message, "DB_ERROR");
    res.status(201).json({ room: data });
  })
);

router.get(
  "/rooms/:roomId/messages",
  authenticate,
  authorize("customer", "barber"),
  asyncHandler(async (req: Request, res: Response) => {
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

    const { data, error } = await supabase
      .from("chat_messages")
      .select("*")
      .eq("room_id", param(req, "roomId"))
      .order("created_at", { ascending: true });

    if (error) throw new ApiError(500, error.message, "DB_ERROR");
    res.json({ messages: data ?? [] });
  })
);

router.post(
  "/rooms/:roomId/messages",
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

    const { data, error } = await supabase
      .from("chat_messages")
      .insert({
        room_id: param(req, "roomId"),
        sender_id: uid,
        message: message.trim(),
        is_ai: false,
      })
      .select()
      .single();

    if (error) throw new ApiError(400, error.message, "DB_INSERT_FAILED");
    res.status(201).json({ message: data });
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

export default router;
