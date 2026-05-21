import { getSupabaseSecret } from "../config/supabase";
import { ApiError } from "./errors";

export async function assertShopOwner(
  shopId: string,
  userId: string
): Promise<{ id: string; owner_id: string; name: string }> {
  const supabase = getSupabaseSecret();
  const { data: shop, error } = await supabase
    .from("barber_shops")
    .select("id, owner_id, name")
    .eq("id", shopId)
    .single();

  if (error || !shop) {
    throw new ApiError(404, "Barber shop not found", "NOT_FOUND");
  }

  if (shop.owner_id !== userId) {
    throw new ApiError(403, "You do not own this shop", "FORBIDDEN");
  }

  return shop;
}

export async function getShopOwnerId(shopId: string): Promise<string | null> {
  const supabase = getSupabaseSecret();
  const { data } = await supabase
    .from("barber_shops")
    .select("owner_id")
    .eq("id", shopId)
    .single();
  return data?.owner_id ?? null;
}
