#!/usr/bin/env node
/**
 * Seed an admin profile with bcrypt password (local JWT auth).
 *
 * Usage:
 *   node scripts/seed-admin.mjs admin@bookmybarber.com 'YourSecurePassword'
 *
 * Requires: SUPABASE_URL, SUPABASE_SECRET_KEY (or SERVICE_ROLE), JWT_ACCESS_SECRET optional
 */
import "dotenv/config";
import bcrypt from "bcrypt";
import { createClient } from "@supabase/supabase-js";

const email = process.argv[2]?.trim().toLowerCase();
const password = process.argv[3];

if (!email || !password) {
  console.error(
    "Usage: node scripts/seed-admin.mjs <email> <password>"
  );
  process.exit(1);
}

const url = process.env.SUPABASE_URL?.trim();
const key =
  process.env.SUPABASE_SECRET_KEY?.trim() ||
  process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

if (!url || !key) {
  console.error("Set SUPABASE_URL and SUPABASE_SECRET_KEY in .env");
  process.exit(1);
}

const supabase = createClient(url, key, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const passwordHash = await bcrypt.hash(password, 12);
const now = new Date().toISOString();

const { data: existing } = await supabase
  .from("profiles")
  .select("id, role")
  .ilike("email", email)
  .maybeSingle();

if (existing) {
  const { error } = await supabase
    .from("profiles")
    .update({
      role: "admin",
      password_hash: passwordHash,
      email_verified_at: now,
      updated_at: now,
    })
    .eq("id", existing.id);

  if (error) {
    console.error("Update failed:", error.message);
    process.exit(1);
  }
  console.log(`Updated admin profile ${existing.id} for ${email}`);
} else {
  const { data, error } = await supabase
    .from("profiles")
    .insert({
      email,
      role: "admin",
      city: "Lahore",
      password_hash: passwordHash,
      email_verified_at: now,
    })
    .select("id")
    .single();

  if (error) {
    console.error("Insert failed:", error.message);
    process.exit(1);
  }
  console.log(`Created admin profile ${data.id} for ${email}`);
}
