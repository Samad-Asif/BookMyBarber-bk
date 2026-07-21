import { getSupabaseSecret } from "../config/supabase";
import { ApiError } from "../lib/errors";

const OTP_WINDOW_MS = 15 * 60 * 1000;
const MAX_OTP_SENDS = 5;
const MAX_FAILED_VERIFIES = 5;
const LOCK_DURATION_MS = 24 * 60 * 60 * 1000;

export async function checkAccountLocked(email: string): Promise<void> {
    const supabase = getSupabaseSecret();
    const { data, error } = await supabase
        .from("profiles")
        .select("locked_until")
        .ilike("email", email.trim().toLowerCase())
        .maybeSingle();

    if (error) {
        throw new ApiError(500, error.message, "DB_ERROR");
    }

    if (data?.locked_until && new Date(data.locked_until) > new Date()) {
        throw new ApiError(
            403,
            "Account is locked for 24 hours due to too many attempts",
            "ACCOUNT_LOCKED",
            { lockedUntil: data.locked_until },
        );
    }

    if (data?.locked_until && new Date(data.locked_until) <= new Date()) {
        await resetCounters(email);
    }
}

export async function trackOtpSend(email: string): Promise<void> {
    const supabase = getSupabaseSecret();
    const normalized = email.trim().toLowerCase();
    const now = new Date().toISOString();

    const { data } = await supabase
        .from("profiles")
        .select("otp_send_count, otp_window_start")
        .ilike("email", normalized)
        .maybeSingle();

    const windowStart = data?.otp_window_start
        ? new Date(data.otp_window_start).getTime()
        : Date.now();
    const isExpired = Date.now() - windowStart > OTP_WINDOW_MS;
    const count = isExpired ? 0 : (data?.otp_send_count ?? 0);

    if (count >= MAX_OTP_SENDS) {
        await lockAccount(normalized);
        return;
    }

    const { error } = await supabase
        .from("profiles")
        .update({
            otp_send_count: count + 1,
            otp_fail_count: isExpired ? 0 : undefined,
            otp_window_start: isExpired ? now : (data?.otp_window_start ?? now),
            updated_at: now,
        })
        .ilike("email", normalized);

    if (error) {
        throw new ApiError(500, error.message, "DB_ERROR");
    }
}

export async function trackFailedVerify(email: string): Promise<void> {
    const supabase = getSupabaseSecret();
    const normalized = email.trim().toLowerCase();
    const now = new Date().toISOString();

    const { data } = await supabase
        .from("profiles")
        .select("otp_fail_count, otp_window_start")
        .ilike("email", normalized)
        .maybeSingle();

    const windowStart = data?.otp_window_start
        ? new Date(data.otp_window_start).getTime()
        : Date.now();
    const isExpired = Date.now() - windowStart > OTP_WINDOW_MS;
    const count = isExpired ? 0 : (data?.otp_fail_count ?? 0);

    if (count >= MAX_FAILED_VERIFIES) {
        await lockAccount(normalized);
        return;
    }

    const { error } = await supabase
        .from("profiles")
        .update({
            otp_fail_count: count + 1,
            otp_send_count: isExpired ? 0 : undefined,
            otp_window_start: isExpired ? now : (data?.otp_window_start ?? now),
            updated_at: now,
        })
        .ilike("email", normalized);

    if (error) {
        throw new ApiError(500, error.message, "DB_ERROR");
    }
}

export async function lockAccount(email: string): Promise<void> {
    const supabase = getSupabaseSecret();
    const normalized = email.trim().toLowerCase();
    const lockedUntil = new Date(Date.now() + LOCK_DURATION_MS).toISOString();
    const now = new Date().toISOString();

    const { error } = await supabase
        .from("profiles")
        .update({
            locked_until: lockedUntil,
            otp_send_count: 0,
            otp_fail_count: 0,
            otp_window_start: now,
            updated_at: now,
        })
        .ilike("email", normalized);

    if (error) {
        throw new ApiError(500, error.message, "DB_ERROR");
    }

    const { sendAccountLockedEmail } = await import("./email.service");
    await sendAccountLockedEmail(normalized);

    throw new ApiError(
        403,
        "Account is locked for 24 hours due to too many attempts",
        "ACCOUNT_LOCKED",
        { lockedUntil },
    );
}

export async function resetCounters(email: string): Promise<void> {
    const supabase = getSupabaseSecret();
    const now = new Date().toISOString();

    const { error } = await supabase
        .from("profiles")
        .update({
            locked_until: null,
            otp_send_count: 0,
            otp_fail_count: 0,
            otp_window_start: now,
            updated_at: now,
        })
        .ilike("email", email.trim().toLowerCase());

    if (error) {
        throw new ApiError(500, error.message, "DB_ERROR");
    }
}

// agent : admin unlock endpoint — TODO
