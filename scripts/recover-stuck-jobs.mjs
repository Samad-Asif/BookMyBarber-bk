import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY,
);

const STUCK_MS = 90_000;

const { data: stuck, error } = await supabase
  .from("haircut_requests")
  .select("id, status, updated_at, user_id, ai_analysis_id")
  .in("status", ["pending", "queued", "analyzing", "processing"])
  .order("created_at", { ascending: false })
  .limit(10);

if (error) {
  console.error("query failed:", error.message);
  process.exit(1);
}

console.log("In-progress jobs:", JSON.stringify(stuck, null, 2));

const cutoff = Date.now() - STUCK_MS;
for (const row of stuck ?? []) {
  const updated = new Date(row.updated_at).getTime();
  if (updated > cutoff && row.status !== "pending") {
    console.log(`skip ${row.id} (${row.status}) — updated ${Math.round((Date.now() - updated) / 1000)}s ago`);
    continue;
  }

  await supabase
    .from("haircut_requests")
    .update({ status: "pending" })
    .eq("id", row.id);

  const base = (process.env.API_BASE_URL ?? "https://book-my-barber-bk-seven.vercel.app").replace(/\/$/, "");
  const secret = process.env.INTERNAL_CRON_SECRET ?? process.env.JWT_ACCESS_SECRET;
  const url = `${base}/v1/internal/haircut-process/${row.id}`;

  console.log(`reset + dispatch ${row.id} (${row.status}) -> ${url}`);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json",
    },
  });
  console.log(`  -> HTTP ${res.status}`, await res.text().catch(() => ""));
}
