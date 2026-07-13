-- Add account lock & OTP rate-limiting columns to profiles
-- linked from auth-lock.service.ts

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS locked_until timestamptz,
  ADD COLUMN IF NOT EXISTS otp_send_count int DEFAULT 0,
  ADD COLUMN IF NOT EXISTS otp_fail_count int DEFAULT 0,
  ADD COLUMN IF NOT EXISTS otp_window_start timestamptz DEFAULT now();
