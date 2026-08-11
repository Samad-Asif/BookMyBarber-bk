import jwt from "jsonwebtoken";
import { getSupabaseSecret } from "../config/supabase";
import { ApiError } from "../lib/errors";

type ChatMessageDbo = {
  id: string;
  room_id: string;
  sender_id: string | null;
  message: string;
  is_ai: boolean;
  client_id: string;
  created_at: string;
  received_at: string | null;
  read_at: string | null;
};

export type ChatMessageRow = {
  id: string;
  clientId: string;
  roomId: string;
  senderId: string | null;
  message: string;
  isAi: boolean;
  createdAt: string;
  receivedAt: string | null;
  readAt: string | null;
};

export type ChatRoomSummary = {
  id: string;
  shopId: string;
  shopName: string;
  shopLogoUrl: string | null;
  customerId: string;
  customerName: string;
  customerAvatarUrl: string | null;
  barberId: string;
  barberName: string;
  barberAvatarUrl: string | null;
  lastMessage: string | null;
  lastMessageAt: string | null;
  lastSenderId: string | null;
  unreadCount: number;
};

export function mapChatMessage(row: ChatMessageDbo): ChatMessageRow {
  return {
    id: row.id,
    clientId: row.client_id,
    roomId: row.room_id,
    senderId: row.sender_id,
    message: row.message,
    isAi: row.is_ai,
    createdAt: row.created_at,
    receivedAt: row.received_at,
    readAt: row.read_at,
  };
}

export async function ensureChatRoom(opts: {
  customerId: string;
  shopId: string;
}): Promise<{ id: string; barberId: string }> {
  const supabase = getSupabaseSecret();

  const { data: shop } = await supabase
    .from("barber_shops")
    .select("id, owner_id")
    .eq("id", opts.shopId)
    .maybeSingle();

  if (!shop?.owner_id) {
    throw new ApiError(400, "Shop has no owner", "INVALID_STATE");
  }

  const { data, error } = await supabase
    .from("chat_rooms")
    .upsert(
      {
        customer_id: opts.customerId,
        barber_id: shop.owner_id,
        shop_id: opts.shopId,
      },
      { onConflict: "customer_id,shop_id", ignoreDuplicates: false }
    )
    .select("id, barber_id")
    .single();

  if (error || !data) {
    throw new ApiError(400, error?.message ?? "Room upsert failed", "DB_ERROR");
  }
  return { id: data.id as string, barberId: data.barber_id as string };
}

export async function listChatRoomSummaries(
  user: { id: string; role: "customer" | "barber" },
  opts: { shopId?: string } = {}
): Promise<ChatRoomSummary[]> {
  const supabase = getSupabaseSecret();
  const myCol = user.role === "customer" ? "customer_id" : "barber_id";

  let q = supabase.from("chat_rooms").select("*").eq(myCol, user.id);
  if (opts.shopId) q = q.eq("shop_id", opts.shopId);
  const { data: rooms, error } = await q.order("created_at", {
    ascending: false,
  });

  if (error) throw new ApiError(500, error.message, "DB_ERROR");
  const roomRows = (rooms ?? []) as {
    id: string;
    shop_id: string;
    customer_id: string;
    barber_id: string;
  }[];

  if (roomRows.length === 0) return [];

  const roomIds = roomRows.map((r) => r.id);
  const shopIds = [...new Set(roomRows.map((r) => r.shop_id))];
  const customerIds = [...new Set(roomRows.map((r) => r.customer_id))];
  const barberIds = [...new Set(roomRows.map((r) => r.barber_id))];

  const [{ data: shops }, { data: customers }, { data: barbers }, { data: msgs }, { data: unread }] =
    await Promise.all([
      shopIds.length
        ? supabase.from("barber_shops").select("id, name, logo_url").in("id", shopIds)
        : Promise.resolve({ data: [] as unknown[] }),
      customerIds.length
        ? supabase.from("profiles").select("id, name, avatar_url").in("id", customerIds)
        : Promise.resolve({ data: [] as unknown[] }),
      barberIds.length
        ? supabase.from("profiles").select("id, name, avatar_url").in("id", barberIds)
        : Promise.resolve({ data: [] as unknown[] }),
      roomIds.length
        ? supabase
            .from("chat_messages")
            .select("room_id, sender_id, message, created_at")
            .in("room_id", roomIds)
            .order("created_at", { ascending: false })
            .limit(roomIds.length * 3)
        : Promise.resolve({ data: [] as unknown[] }),
      roomIds.length
        ? supabase
            .from("chat_messages")
            .select("room_id")
            .in("room_id", roomIds)
            .is("read_at", null)
            .neq("sender_id", user.id)
        : Promise.resolve({ data: [] as unknown[] }),
    ]);

  const shopMap = new Map((shops ?? [] as any[]).map((s) => [s.id as string, s]));
  const customerMap = new Map((customers ?? [] as any[]).map((p) => [p.id as string, p]));
  const barberMap = new Map((barbers ?? [] as any[]).map((p) => [p.id as string, p]));

  // Last message per room (msgs already sorted desc).
  const lastByRoom = new Map<string, { sender_id: string | null; message: string; created_at: string }>();
  for (const m of msgs ?? [] as any[]) {
    if (!lastByRoom.has(m.room_id as string)) {
      lastByRoom.set(m.room_id as string, {
        sender_id: m.sender_id as string | null,
        message: m.message as string,
        created_at: m.created_at as string,
      });
    }
  }

  // Unread per room.
  const unreadByRoom = new Map<string, number>();
  for (const u of unread ?? [] as any[]) {
    const roomId = u.room_id as string;
    unreadByRoom.set(roomId, (unreadByRoom.get(roomId) ?? 0) + 1);
  }

  const summaries: ChatRoomSummary[] = roomRows
    .map((r) => {
      const shop = shopMap.get(r.shop_id) as { name?: string; logo_url?: string | null } | undefined;
      const customer = customerMap.get(r.customer_id) as { name?: string; avatar_url?: string | null } | undefined;
      const barber = barberMap.get(r.barber_id) as { name?: string; avatar_url?: string | null } | undefined;
      const last = lastByRoom.get(r.id);
      return {
        id: r.id,
        shopId: r.shop_id,
        shopName: shop?.name ?? "Shop",
        shopLogoUrl: shop?.logo_url ?? null,
        customerId: r.customer_id,
        customerName: customer?.name ?? "Customer",
        customerAvatarUrl: customer?.avatar_url ?? null,
        barberId: r.barber_id,
        barberName: barber?.name ?? "Barber",
        barberAvatarUrl: barber?.avatar_url ?? null,
        lastMessage: last?.message ?? null,
        lastMessageAt: last?.created_at ?? null,
        lastSenderId: last?.sender_id ?? null,
        unreadCount: unreadByRoom.get(r.id) ?? 0,
      };
    })
    .sort((a, b) => {
      const ta = a.lastMessageAt ?? a.id;
      const tb = b.lastMessageAt ?? b.id;
      return tb < ta ? -1 : tb > ta ? 1 : 0;
    });

  return summaries;
}

export async function getChatRoomMessages(opts: {
  roomId: string;
  userId: string;
}): Promise<ChatMessageRow[]> {
  const supabase = getSupabaseSecret();
  const { data: room } = await supabase
    .from("chat_rooms")
    .select("customer_id, barber_id")
    .eq("id", opts.roomId)
    .maybeSingle();

  if (!room) throw new ApiError(404, "Room not found", "NOT_FOUND");
  if (room.customer_id !== opts.userId && room.barber_id !== opts.userId) {
    throw new ApiError(403, "Not a participant", "FORBIDDEN");
  }

  const { data, error } = await supabase
    .from("chat_messages")
    .select("*")
    .eq("room_id", opts.roomId)
    .order("created_at", { ascending: true });

  if (error) throw new ApiError(500, error.message, "DB_ERROR");
  return (data ?? []).map(mapChatMessage);
}

export async function sendChatMessage(opts: {
  roomId: string;
  senderId: string;
  message: string;
  clientId?: string;
}): Promise<ChatMessageRow> {
  const supabase = getSupabaseSecret();
  const { data, error } = await supabase
    .from("chat_messages")
    .insert({
      room_id: opts.roomId,
      sender_id: opts.senderId,
      message: opts.message,
      is_ai: false,
      client_id: opts.clientId || undefined,
    })
    .select()
    .single();

  if (error || !data) throw new ApiError(400, error?.message ?? "Send failed", "DB_ERROR");
  return mapChatMessage(data as unknown as ChatMessageDbo);
}

export async function markChatRoomRead(opts: { roomId: string; userId: string }): Promise<void> {
  const supabase = getSupabaseSecret();
  await supabase
    .from("chat_messages")
    .update({ read_at: new Date().toISOString() })
    .eq("room_id", opts.roomId)
    .neq("sender_id", opts.userId)
    .is("read_at", null);
}

export function mintChatRealtimeToken(opts: { userId: string }): string {
  const secret = process.env.SUPABASE_JWT_SECRET;
  if (!secret) throw new ApiError(500, "SUPABASE_JWT_SECRET not configured", "CONFIG_ERROR");
  const iss = process.env.SUPABASE_URL;
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    {
      role: "authenticated",
      sub: opts.userId,
      aud: "authenticated",
      iss,
      iat: now,
      exp: now + 900,
    },
    secret,
    { algorithm: "HS256" }
  );
}

export async function sendWelcomeOnApproval(opts: {
  shopId: string;
  customerId: string;
  bookingDate: string;
  startTime: string;
  barberNotes?: string | null;
}): Promise<void> {
  const supabase = getSupabaseSecret();
  const { data: shop } = await supabase
    .from("barber_shops")
    .select("name")
    .eq("id", opts.shopId)
    .maybeSingle();

  if (!shop) return;
  const room = await ensureChatRoom({
    customerId: opts.customerId,
    shopId: opts.shopId,
  });

  const notes = opts.barberNotes?.trim();
  const timeText = String(opts.startTime).slice(0, 5);
  const message =
    `Your appointment is confirmed for ${opts.bookingDate} at ${timeText} at ${shop.name}.` +
    (notes ? ` Note: ${notes}` : "") +
    " Reply here anytime.";

  await supabase.from("chat_messages").insert({
    room_id: room.id,
    sender_id: room.barberId,
    message,
    is_ai: false,
  });
}