#!/usr/bin/env node
/**
 * Seed test customer + barber accounts for Maestro E2E runs.
 *
 * Usage:
 *   node scripts/seed-test-accounts.mjs
 *
 * Creates (or updates) two profiles directly in Supabase with
 * email_verified_at set so the login flows pass immediately.
 *
 * Requires: SUPABASE_URL, SUPABASE_SECRET_KEY in BookMyBarber-bk/.env
 */
import "dotenv/config";
import bcrypt from "bcrypt";
import { createClient } from "@supabase/supabase-js";

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

const ACCOUNTS = [
  {
    email: "testcustomer@example.com",
    password: "TestPass123!",
    name: "Test Customer",
    role: "customer",
    city: "Lahore",
  },
  {
    email: "testbarber@example.com",
    password: "TestPass123!",
    name: "Test Barber",
    role: "barber",
    city: "Lahore",
  },
];

const now = new Date().toISOString();
const passwordHash = await bcrypt.hash("TestPass123!", 12);

for (const acct of ACCOUNTS) {
  const { data: existing } = await supabase
    .from("profiles")
    .select("id, role")
    .ilike("email", acct.email)
    .maybeSingle();

  if (existing) {
    const { error } = await supabase
      .from("profiles")
      .update({
        role: acct.role,
        password_hash: passwordHash,
        email_verified_at: now,
        updated_at: now,
      })
      .eq("id", existing.id);

    if (error) {
      console.error(`Update failed for ${acct.email}:`, error.message);
      process.exit(1);
    }
    console.log(`Updated ${acct.role} ${existing.id} (${acct.email})`);
  } else {
    const { data, error } = await supabase
      .from("profiles")
      .insert({
        email: acct.email,
        name: acct.name,
        role: acct.role,
        city: acct.city,
        password_hash: passwordHash,
        email_verified_at: now,
      })
      .select("id")
      .single();

    if (error) {
      console.error(`Insert failed for ${acct.email}:`, error.message);
      process.exit(1);
    }
    console.log(`Created ${acct.role} ${data.id} (${acct.email})`);
  }
}

console.log("\nTest accounts ready:");
console.log("  Customer: testcustomer@example.com / TestPass123!");
console.log("  Barber:   testbarber@example.com   / TestPass123!");
