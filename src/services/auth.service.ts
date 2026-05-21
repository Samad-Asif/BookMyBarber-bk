import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { OAuth2Client } from "google-auth-library";
import crypto from "crypto";
import { getSupabaseSecret } from "../config/supabase";
import {
  loadAuthEnv,
  validateAuthEnv,
  isGoogleAuthConfigured,
  isMicrosoftAuthConfigured,
} from "../config/authEnv";
import { ApiError } from "../lib/errors";
import { AuthenticatedUser, UserRole } from "../types/auth";
import {
  buildMicrosoftAuthorizeUrl,
  exchangeMicrosoftAuthCode,
  graphGet,
  isMicrosoftOAuthConfigured,
} from "../lib/microsoft/oauthClient";

const BCRYPT_ROUNDS = 12;
const MS_LOGIN_SCOPES = "openid profile email offline_access";

export interface AuthTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}

export interface AuthSessionResponse {
  user: AuthenticatedUser;
  session: AuthTokens;
}

export interface AuthSignupPendingResponse {
  user: AuthenticatedUser;
  requiresConfirmation: true;
}

interface ProfileRow {
  id: string;
  email: string | null;
  phone: string | null;
  name: string | null;
  role: UserRole;
  password_hash: string | null;
  google_sub: string | null;
  microsoft_oid: string | null;
}

function getAuthEnv() {
  const env = loadAuthEnv();
  const { valid, missing } = validateAuthEnv(env);
  if (!valid) {
    throw new ApiError(
      500,
      `Auth not configured: ${missing.join(", ")}`,
      "AUTH_CONFIG_ERROR"
    );
  }
  return env;
}

function mapProfile(row: ProfileRow): AuthenticatedUser {
  return {
    id: row.id,
    email: row.email ?? undefined,
    phone: row.phone ?? undefined,
    role: row.role,
  };
}

function accessExpiresInSeconds(ttl: string): number {
  const match = ttl.match(/^(\d+)([smhd])$/);
  if (!match) return 900;
  const n = Number(match[1]);
  const unit = match[2];
  const mult =
    unit === "s" ? 1 : unit === "m" ? 60 : unit === "h" ? 3600 : 86400;
  return n * mult;
}

function signAccessToken(user: AuthenticatedUser): {
  token: string;
  expiresIn: number;
} {
  const env = getAuthEnv();
  const expiresIn = accessExpiresInSeconds(env.jwtAccessTtl);
  const token = jwt.sign(
    {
      sub: user.id,
      role: user.role,
      email: user.email,
    },
    env.jwtAccessSecret,
    { expiresIn: expiresIn }
  );
  return { token, expiresIn };
}

function generateRefreshPlain(): { token: string; sessionId: string; secret: string } {
  const sessionId = crypto.randomUUID();
  const secret = crypto.randomBytes(32).toString("base64url");
  return { token: `${sessionId}.${secret}`, sessionId, secret };
}

async function createRefreshSession(
  userId: string,
  userAgent?: string
): Promise<string> {
  const env = getAuthEnv();
  const { token, sessionId, secret } = generateRefreshPlain();
  const tokenHash = await bcrypt.hash(secret, 10);
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + env.jwtRefreshTtlDays);

  const supabase = getSupabaseSecret();
  const { error } = await supabase.from("refresh_sessions").insert({
    id: sessionId,
    user_id: userId,
    token_hash: tokenHash,
    expires_at: expiresAt.toISOString(),
    user_agent: userAgent ?? null,
  });

  if (error) {
    throw new ApiError(500, error.message, "SESSION_CREATE_FAILED");
  }

  return token;
}

async function issueSession(
  user: AuthenticatedUser,
  userAgent?: string
): Promise<AuthSessionResponse> {
  const supabase = getSupabaseSecret();
  await supabase
    .from("profiles")
    .update({ last_login_at: new Date().toISOString() })
    .eq("id", user.id);

  const { token, expiresIn } = signAccessToken(user);
  const refreshPlain = await createRefreshSession(user.id, userAgent);

  return {
    user,
    session: {
      access_token: token,
      refresh_token: refreshPlain,
      expires_in: expiresIn,
      token_type: "bearer",
    },
  };
}

async function findProfileByEmail(email: string): Promise<ProfileRow | null> {
  const supabase = getSupabaseSecret();
  const { data, error } = await supabase
    .from("profiles")
    .select(
      "id, email, phone, name, role, password_hash, google_sub, microsoft_oid"
    )
    .ilike("email", email)
    .maybeSingle();

  if (error) throw new ApiError(500, error.message, "DB_ERROR");
  return data as ProfileRow | null;
}

async function findProfileByGoogleSub(sub: string): Promise<ProfileRow | null> {
  const supabase = getSupabaseSecret();
  const { data, error } = await supabase
    .from("profiles")
    .select(
      "id, email, phone, name, role, password_hash, google_sub, microsoft_oid"
    )
    .eq("google_sub", sub)
    .maybeSingle();

  if (error) throw new ApiError(500, error.message, "DB_ERROR");
  return data as ProfileRow | null;
}

async function findProfileByMicrosoftOid(
  oid: string
): Promise<ProfileRow | null> {
  const supabase = getSupabaseSecret();
  const { data, error } = await supabase
    .from("profiles")
    .select(
      "id, email, phone, name, role, password_hash, google_sub, microsoft_oid"
    )
    .eq("microsoft_oid", oid)
    .maybeSingle();

  if (error) throw new ApiError(500, error.message, "DB_ERROR");
  return data as ProfileRow | null;
}

async function createProfile(params: {
  email?: string | null;
  phone?: string | null;
  name?: string | null;
  role: UserRole;
  passwordHash?: string | null;
  googleSub?: string | null;
  microsoftOid?: string | null;
}): Promise<ProfileRow> {
  const supabase = getSupabaseSecret();
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("profiles")
    .insert({
      email: params.email ?? null,
      phone: params.phone ?? null,
      name: params.name ?? null,
      role: params.role,
      city: "Lahore",
      password_hash: params.passwordHash ?? null,
      google_sub: params.googleSub ?? null,
      microsoft_oid: params.microsoftOid ?? null,
      email_verified_at: now,
    })
    .select(
      "id, email, phone, name, role, password_hash, google_sub, microsoft_oid"
    )
    .single();

  if (error || !data) {
    throw new ApiError(400, error?.message ?? "Could not create profile", "SIGNUP_FAILED");
  }
  return data as ProfileRow;
}

async function linkOAuthToProfile(
  profileId: string,
  patch: Partial<{
    email: string;
    name: string;
    google_sub: string;
    microsoft_oid: string;
  }>
): Promise<ProfileRow> {
  const supabase = getSupabaseSecret();
  const { data, error } = await supabase
    .from("profiles")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", profileId)
    .select(
      "id, email, phone, name, role, password_hash, google_sub, microsoft_oid"
    )
    .single();

  if (error || !data) {
    throw new ApiError(500, error?.message ?? "Profile update failed", "DB_ERROR");
  }
  return data as ProfileRow;
}

export async function signInWithPassword(
  email: string,
  password: string,
  userAgent?: string
): Promise<AuthSessionResponse> {
  const profile = await findProfileByEmail(email.trim());
  if (!profile?.password_hash) {
    throw new ApiError(401, "Invalid credentials", "AUTH_FAILED");
  }

  const ok = await bcrypt.compare(password, profile.password_hash);
  if (!ok) {
    throw new ApiError(401, "Invalid credentials", "AUTH_FAILED");
  }

  return issueSession(mapProfile(profile), userAgent);
}

export async function signUp(
  email: string,
  password: string,
  role: UserRole = "customer",
  userAgent?: string
): Promise<AuthSessionResponse> {
  const normalized = email.trim().toLowerCase();
  const existing = await findProfileByEmail(normalized);
  if (existing) {
    throw new ApiError(400, "Email already registered", "SIGNUP_FAILED");
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const profile = await createProfile({
    email: normalized,
    role,
    passwordHash,
  });

  return issueSession(mapProfile(profile), userAgent);
}

export async function signInWithGoogle(
  idToken: string,
  userAgent?: string
): Promise<AuthSessionResponse> {
  const env = loadAuthEnv();
  if (!isGoogleAuthConfigured(env)) {
    throw new ApiError(500, "Google auth not configured", "AUTH_CONFIG_ERROR");
  }

  const client = new OAuth2Client(env.googleClientIds[0]);
  let payload: { sub?: string; email?: string; name?: string };
  try {
    const ticket = await client.verifyIdToken({
      idToken,
      audience: env.googleClientIds,
    });
    payload = ticket.getPayload() ?? {};
  } catch {
    throw new ApiError(401, "Google authentication failed", "AUTH_FAILED");
  }

  if (!payload.sub) {
    throw new ApiError(401, "Invalid Google token", "AUTH_FAILED");
  }

  let profile =
    (await findProfileByGoogleSub(payload.sub)) ??
    (payload.email ? await findProfileByEmail(payload.email) : null);

  if (profile) {
    if (!profile.google_sub || profile.google_sub !== payload.sub) {
      profile = await linkOAuthToProfile(profile.id, {
        google_sub: payload.sub,
        email: profile.email ?? payload.email,
        name: profile.name ?? payload.name,
      });
    }
  } else {
    profile = await createProfile({
      email: payload.email ?? null,
      name: payload.name ?? null,
      role: "customer",
      googleSub: payload.sub,
    });
  }

  return issueSession(mapProfile(profile), userAgent);
}

export function getMicrosoftLoginAuthUrl(
  redirectUri?: string,
  state?: string
): string {
  const env = loadAuthEnv();
  if (!isMicrosoftAuthConfigured(env)) {
    throw new ApiError(500, "Microsoft auth not configured", "AUTH_CONFIG_ERROR");
  }

  const uri = redirectUri?.trim() || env.microsoftAuthRedirectUri;
  return buildMicrosoftAuthorizeUrl({
    redirectUri: uri,
    scope: MS_LOGIN_SCOPES,
    state: state ?? crypto.randomBytes(16).toString("hex"),
  });
}

export async function signInWithMicrosoftCode(
  code: string,
  redirectUri: string,
  userAgent?: string
): Promise<AuthSessionResponse> {
  if (!isMicrosoftOAuthConfigured()) {
    throw new ApiError(500, "Microsoft auth not configured", "AUTH_CONFIG_ERROR");
  }

  const tokens = await exchangeMicrosoftAuthCode(code, redirectUri);
  const me = (await graphGet(tokens.access_token, "/me")) as {
    id: string;
    mail?: string;
    userPrincipalName?: string;
    displayName?: string;
  };

  const email = (me.mail ?? me.userPrincipalName ?? "").toLowerCase() || undefined;
  const oid = me.id;

  let profile =
    (await findProfileByMicrosoftOid(oid)) ??
    (email ? await findProfileByEmail(email) : null);

  if (profile) {
    if (!profile.microsoft_oid || profile.microsoft_oid !== oid) {
      profile = await linkOAuthToProfile(profile.id, {
        microsoft_oid: oid,
        email: profile.email ?? email,
        name: profile.name ?? me.displayName,
      });
    }
  } else {
    profile = await createProfile({
      email: email ?? null,
      name: me.displayName ?? null,
      role: "customer",
      microsoftOid: oid,
    });
  }

  return issueSession(mapProfile(profile), userAgent);
}

function parseRefreshToken(refreshToken: string): {
  sessionId: string;
  secret: string;
} | null {
  const dot = refreshToken.indexOf(".");
  if (dot <= 0) return null;
  const sessionId = refreshToken.slice(0, dot);
  const secret = refreshToken.slice(dot + 1);
  if (!sessionId || !secret) return null;
  return { sessionId, secret };
}

export async function refreshSession(
  refreshToken: string,
  userAgent?: string
): Promise<AuthSessionResponse> {
  const parsed = parseRefreshToken(refreshToken);
  if (!parsed) {
    throw new ApiError(401, "Invalid or expired refresh token", "UNAUTHORIZED");
  }

  const supabase = getSupabaseSecret();
  const { data: matched, error } = await supabase
    .from("refresh_sessions")
    .select("id, user_id, token_hash, expires_at, revoked_at")
    .eq("id", parsed.sessionId)
    .is("revoked_at", null)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();

  if (error) {
    throw new ApiError(500, error.message, "DB_ERROR");
  }

  if (!matched || !(await bcrypt.compare(parsed.secret, matched.token_hash))) {
    throw new ApiError(401, "Invalid or expired refresh token", "UNAUTHORIZED");
  }

  await supabase
    .from("refresh_sessions")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", matched.id);

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select(
      "id, email, phone, name, role, password_hash, google_sub, microsoft_oid"
    )
    .eq("id", matched.user_id)
    .single();

  if (profileError || !profile) {
    throw new ApiError(401, "User not found", "UNAUTHORIZED");
  }

  return issueSession(mapProfile(profile as ProfileRow), userAgent);
}

export async function signOut(refreshToken?: string): Promise<void> {
  if (!refreshToken) return;

  const parsed = parseRefreshToken(refreshToken);
  if (!parsed) return;

  const supabase = getSupabaseSecret();
  const { data: row } = await supabase
    .from("refresh_sessions")
    .select("id, token_hash")
    .eq("id", parsed.sessionId)
    .is("revoked_at", null)
    .maybeSingle();

  if (row && (await bcrypt.compare(parsed.secret, row.token_hash))) {
    await supabase
      .from("refresh_sessions")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", row.id);
  }
}

export async function getSessionUser(accessToken: string): Promise<AuthenticatedUser> {
  const env = getAuthEnv();
  let payload: jwt.JwtPayload;
  try {
    payload = jwt.verify(accessToken, env.jwtAccessSecret) as jwt.JwtPayload;
  } catch {
    throw new ApiError(401, "Invalid or expired token", "UNAUTHORIZED");
  }

  const sub = payload.sub;
  if (!sub || typeof sub !== "string") {
    throw new ApiError(401, "Invalid token", "UNAUTHORIZED");
  }

  const supabase = getSupabaseSecret();
  const { data, error } = await supabase
    .from("profiles")
    .select("id, email, phone, role")
    .eq("id", sub)
    .single();

  if (error || !data) {
    throw new ApiError(401, "User not found", "UNAUTHORIZED");
  }

  return {
    id: data.id,
    email: data.email ?? undefined,
    phone: data.phone ?? undefined,
    role: data.role as UserRole,
  };
}

/** @deprecated Phone auth deferred */
export async function signUpWithPhone(): Promise<never> {
  throw new ApiError(501, "Phone registration is not available yet", "NOT_IMPLEMENTED");
}

export async function signInWithPhone(): Promise<never> {
  throw new ApiError(501, "Phone login is not available yet", "NOT_IMPLEMENTED");
}

export async function verifyEmailOTP(): Promise<never> {
  throw new ApiError(501, "Email OTP verification is not available yet", "NOT_IMPLEMENTED");
}

export async function verifyPhoneOTP(): Promise<never> {
  throw new ApiError(501, "Phone OTP verification is not available yet", "NOT_IMPLEMENTED");
}
