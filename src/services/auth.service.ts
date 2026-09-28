import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { OAuth2Client } from "google-auth-library";
import crypto from "crypto";
import { getSupabaseSecret } from "../config/supabase";
import {
  loadAuthEnv,
  validateAuthEnv,
  isGoogleAuthConfigured,
  isGoogleWebAuthConfigured,
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
  requiresEmailVerification: true;
  email: string;
  isExisting?: boolean;
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
  email_verified_at: string | null;
}

const PROFILE_SELECT =
  "id, email, phone, name, role, password_hash, google_sub, microsoft_oid, email_verified_at";

function generateEmailCode(): string {
  return crypto
    .randomBytes(4)
    .toString("base64url")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 6)
    .padStart(6, "A");
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
  // Exact match on the stored (lowercase) address. Never ilike: "_" and "%" are
  // wildcards there, so "ali_khan@…" would also find "ali.khan@…" and send that
  // account's password reset to someone else's inbox.
  const { data, error } = await supabase
    .from("profiles")
    .select(PROFILE_SELECT)
    .eq("email", email.trim().toLowerCase())
    .maybeSingle();

  if (error) throw new ApiError(500, error.message, "DB_ERROR");
  return data as ProfileRow | null;
}

async function findProfileByGoogleSub(sub: string): Promise<ProfileRow | null> {
  const supabase = getSupabaseSecret();
  const { data, error } = await supabase
    .from("profiles")
    .select(PROFILE_SELECT)
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
    .select(PROFILE_SELECT)
    .eq("microsoft_oid", oid)
    .maybeSingle();

  if (error) throw new ApiError(500, error.message, "DB_ERROR");
  return data as ProfileRow | null;
}

async function createProfile(params: {
  email?: string | null;
  phone?: string | null;
  name?: string | null;
  city?: string | null;
  role: UserRole;
  passwordHash?: string | null;
  googleSub?: string | null;
  microsoftOid?: string | null;
  emailVerifiedAt?: string | null;
}): Promise<ProfileRow> {
  const supabase = getSupabaseSecret();
  const { data, error } = await supabase
    .from("profiles")
    .insert({
      email: params.email ?? null,
      phone: params.phone ?? null,
      name: params.name ?? null,
      role: params.role,
      city: params.city ?? "Lahore",
      password_hash: params.passwordHash ?? null,
      google_sub: params.googleSub ?? null,
      microsoft_oid: params.microsoftOid ?? null,
      email_verified_at: params.emailVerifiedAt ?? null,
    })
    .select(PROFILE_SELECT)
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
    email_verified_at: string;
    password_hash: null;
  }>
): Promise<ProfileRow> {
  const supabase = getSupabaseSecret();
  const { data, error } = await supabase
    .from("profiles")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", profileId)
    .select(PROFILE_SELECT)
    .single();

  if (error || !data) {
    throw new ApiError(500, error?.message ?? "Profile update failed", "DB_ERROR");
  }
  return data as ProfileRow;
}

async function storeAndSendVerificationCode(email: string): Promise<void> {
  const code = generateEmailCode();
  const codeHash = await bcrypt.hash(code, 10);
  const expiresAt = new Date();
  expiresAt.setMinutes(expiresAt.getMinutes() + 15);

  const supabase = getSupabaseSecret();
  const { error } = await supabase.from("email_verification_codes").insert({
    email,
    code_hash: codeHash,
    expires_at: expiresAt.toISOString(),
  });

  if (error) {
    throw new ApiError(500, error.message, "DB_ERROR");
  }

  const { sendEmailVerificationCode } = await import("./email.service");
  await sendEmailVerificationCode(email, code);
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

  if (!profile.email_verified_at) {
    const { checkAccountLocked, trackOtpSend } = await import("./auth-lock.service");
    await checkAccountLocked(profile.email ?? email);
    await trackOtpSend(profile.email ?? email);
    await storeAndSendVerificationCode(profile.email ?? email);
    throw new ApiError(
      403,
      "Please verify your email before signing in",
      "EMAIL_NOT_VERIFIED"
    );
  }

  return issueSession(mapProfile(profile), userAgent);
}

export async function signUp(
  email: string,
  password: string,
  role: UserRole = "customer",
  options?: { name?: string; city?: string; userAgent?: string }
): Promise<AuthSignupPendingResponse> {
  const normalized = email.trim().toLowerCase();
  const existing = await findProfileByEmail(normalized);
  if (existing) {
    if (existing.email_verified_at) {
      throw new ApiError(400, "Email already registered", "SIGNUP_FAILED");
    }
    const { checkAccountLocked, trackOtpSend } = await import("./auth-lock.service");
    await checkAccountLocked(normalized);
    await trackOtpSend(normalized);
    await storeAndSendVerificationCode(normalized);
    return { requiresEmailVerification: true, email: normalized, isExisting: true };
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  await createProfile({
    email: normalized,
    role,
    passwordHash,
    name: options?.name ?? null,
    city: options?.city ?? "Lahore",
    emailVerifiedAt: null,
  });

  await storeAndSendVerificationCode(normalized);

  return { requiresEmailVerification: true, email: normalized };
}

export async function resendVerificationCode(
  email: string
): Promise<{ sent: true }> {
  const normalized = email.trim().toLowerCase();
  const profile = await findProfileByEmail(normalized);

  // Anti-enumeration: always succeed from the client's perspective
  if (!profile || profile.email_verified_at) {
    return { sent: true };
  }

  const { checkAccountLocked, trackOtpSend } = await import("./auth-lock.service");
  await checkAccountLocked(normalized);
  await trackOtpSend(normalized);

  await storeAndSendVerificationCode(normalized);
  return { sent: true };
}

export async function verifyEmail(
  email: string,
  code: string
): Promise<AuthSessionResponse> {
  const { checkAccountLocked, trackFailedVerify } = await import("./auth-lock.service");
  const supabase = getSupabaseSecret();
  const emailLower = email.trim().toLowerCase();
  const now = new Date().toISOString();

  await checkAccountLocked(emailLower);

  const { data: codes, error } = await supabase
    .from("email_verification_codes")
    .select("id, code_hash, expires_at")
    .eq("email", emailLower)
    .is("used_at", null)
    .gt("expires_at", now)
    .order("created_at", { ascending: false })
    .limit(5);

  if (error) {
    throw new ApiError(500, error.message, "DB_ERROR");
  }

  if (!codes || codes.length === 0) {
    await trackFailedVerify(emailLower);
    throw new ApiError(400, "Invalid or expired verification code", "VALIDATION_ERROR");
  }

  let matchedId: string | null = null;
  for (const row of codes) {
    if (await bcrypt.compare(code.toUpperCase(), (row as { code_hash: string }).code_hash)) {
      matchedId = (row as { id: string }).id;
      break;
    }
  }

  if (!matchedId) {
    await trackFailedVerify(emailLower);
    throw new ApiError(400, "Invalid or expired verification code", "VALIDATION_ERROR");
  }

  await supabase
    .from("email_verification_codes")
    .update({ used_at: now })
    .eq("id", matchedId);

  const { error: updateError } = await supabase
    .from("profiles")
    .update({ email_verified_at: now, updated_at: now })
    .eq("email", emailLower);

  if (updateError) {
    throw new ApiError(500, updateError.message, "DB_ERROR");
  }

  const profile = await findProfileByEmail(emailLower);
  if (!profile) {
    throw new ApiError(400, "User not found", "VALIDATION_ERROR");
  }

  return issueSession(mapProfile(profile));
}

/**
 * Sign in with a Google ID token (from a native SDK, or fetched by the browser
 * flow below). An existing account is matched by Google id, or by email only
 * when Google has verified that address. `role` applies to new accounts.
 */
export async function signInWithGoogle(
  idToken: string,
  userAgent?: string,
  role: UserRole = "customer"
): Promise<AuthSessionResponse> {
  const env = loadAuthEnv();
  if (!isGoogleAuthConfigured(env)) {
    throw new ApiError(500, "Google auth not configured", "AUTH_CONFIG_ERROR");
  }

  const client = new OAuth2Client(env.googleClientIds[0]);
  let payload: { sub?: string; email?: string; email_verified?: boolean; name?: string };
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

  // An unverified address could be anyone's, so it may neither match nor create an account.
  const email = payload.email_verified ? payload.email?.trim().toLowerCase() : undefined;

  let profile =
    (await findProfileByGoogleSub(payload.sub)) ??
    (email ? await findProfileByEmail(email) : null);

  if (profile) {
    const patch: Parameters<typeof linkOAuthToProfile>[1] = {};
    if (profile.google_sub !== payload.sub) patch.google_sub = payload.sub;
    if (!profile.email && email) patch.email = email;
    if (!profile.name && payload.name) patch.name = payload.name;
    if (!profile.email_verified_at && email && profile.email === email) {
      // Google just proved who owns this address. A password set on it before it
      // was verified may be someone else's (account pre-hijacking), so drop it.
      patch.email_verified_at = new Date().toISOString();
      patch.password_hash = null;
    }
    if (Object.keys(patch).length > 0) {
      profile = await linkOAuthToProfile(profile.id, patch);
    }
  } else {
    if (!email) {
      throw new ApiError(
        401,
        "Your Google account's email address isn't verified",
        "AUTH_FAILED"
      );
    }
    profile = await createProfile({
      email,
      name: payload.name ?? null,
      role,
      googleSub: payload.sub,
      emailVerifiedAt: new Date().toISOString(),
    });
  }

  return issueSession(mapProfile(profile), userAgent);
}

// ── Google sign-in through the browser (PKCE) ───────────────────────────────
// The app opens Google in a browser tab; Google returns to our callback, which
// hands a one-time code back to the app's deep link; the app then trades that
// code plus its PKCE verifier for a session. Only the web OAuth client is
// needed, and a code intercepted on the way back is useless without the
// verifier, which never leaves the app.

const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_FLOW_AUDIENCE = "bmb-google-sign-in";
/** The browser flow only ever returns to the app itself. */
const APP_REDIRECT_PREFIX = "bookmybarberapp://";

/** Its own key, so a sign-in state token can never pass as an access token. */
function googleFlowSecret(): string {
  return `${getAuthEnv().jwtAccessSecret}:google-sign-in`;
}

function assertGoogleWebAuthConfigured() {
  const env = loadAuthEnv();
  if (!isGoogleWebAuthConfigured(env)) {
    throw new ApiError(500, "Google auth not configured", "AUTH_CONFIG_ERROR");
  }
  return env;
}

/** Step 1: Google's sign-in URL for the app to open. */
export function getGoogleLoginAuthUrl(params: {
  redirectUri: string;
  codeChallenge: string;
  state: string;
}): string {
  const env = assertGoogleWebAuthConfigured();
  if (!params.redirectUri.startsWith(APP_REDIRECT_PREFIX)) {
    throw new ApiError(400, "Unsupported redirectUri", "VALIDATION_ERROR");
  }

  const flow = jwt.sign({ r: params.redirectUri, s: params.state }, googleFlowSecret(), {
    audience: GOOGLE_FLOW_AUDIENCE,
    expiresIn: "10m",
  });

  const query = new URLSearchParams({
    client_id: env.googleWebClientId,
    redirect_uri: env.googleAuthRedirectUri,
    response_type: "code",
    scope: "openid email profile",
    state: flow,
    code_challenge: params.codeChallenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  });
  return `${GOOGLE_AUTHORIZE_URL}?${query}`;
}

/** Step 2: Google sent the browser to our callback; the app deep link to forward it to. */
export function getGoogleCallbackRedirect(query: {
  code?: string;
  state?: string;
  error?: string;
}): string {
  let flow: jwt.JwtPayload;
  try {
    flow = jwt.verify(query.state ?? "", googleFlowSecret(), {
      audience: GOOGLE_FLOW_AUDIENCE,
    }) as jwt.JwtPayload;
  } catch {
    throw new ApiError(
      400,
      "This sign-in link has expired. Close this window and try again from the app.",
      "AUTH_FAILED"
    );
  }

  const target = flow.r;
  if (typeof target !== "string" || !target.startsWith(APP_REDIRECT_PREFIX) || typeof flow.s !== "string") {
    throw new ApiError(400, "Invalid sign-in request", "AUTH_FAILED");
  }

  const result = new URLSearchParams({ state: flow.s });
  if (query.code) result.set("code", query.code);
  else result.set("error", query.error || "access_denied");
  return `${target}${target.includes("?") ? "&" : "?"}${result}`;
}

/** Step 3: the app trades the code and its PKCE verifier for a session. */
export async function signInWithGoogleCode(
  code: string,
  codeVerifier: string,
  userAgent?: string,
  role: UserRole = "customer"
): Promise<AuthSessionResponse> {
  const env = assertGoogleWebAuthConfigured();
  const client = new OAuth2Client(
    env.googleWebClientId,
    env.googleClientSecret,
    env.googleAuthRedirectUri
  );

  let idToken: string | null | undefined;
  try {
    const { tokens } = await client.getToken({ code, codeVerifier });
    idToken = tokens.id_token;
  } catch {
    throw new ApiError(401, "Google authentication failed", "AUTH_FAILED");
  }
  if (!idToken) {
    throw new ApiError(401, "Google authentication failed", "AUTH_FAILED");
  }

  return signInWithGoogle(idToken, userAgent, role);
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
      emailVerifiedAt: new Date().toISOString(),
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
    .select(PROFILE_SELECT)
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

export async function forgotPassword(
  email: string
): Promise<{ sent: boolean }> {
  const supabase = getSupabaseSecret();
  const emailLower = email.trim().toLowerCase();

  const profile = await findProfileByEmail(emailLower);
  if (!profile) {
    return { sent: true };
  }

  const code = generateEmailCode();
  const tokenHash = await bcrypt.hash(code, 10);
  const expiresAt = new Date();
  expiresAt.setMinutes(expiresAt.getMinutes() + 15);

  const { error } = await supabase.from("password_reset_tokens").insert({
    email: emailLower,
    token_hash: tokenHash,
    expires_at: expiresAt.toISOString(),
  });

  if (error) {
    throw new ApiError(500, error.message, "DB_ERROR");
  }

  const { sendPasswordResetCode } = await import("./email.service");
  await sendPasswordResetCode(emailLower, code);

  return { sent: true };
}

export async function verifyResetCode(
  email: string,
  code: string
): Promise<{ resetToken: string }> {
  const supabase = getSupabaseSecret();
  const emailLower = email.trim().toLowerCase();
  const now = new Date().toISOString();

  const { data: tokens, error } = await supabase
    .from("password_reset_tokens")
    .select("id, token_hash, expires_at")
    .eq("email", emailLower)
    .is("used_at", null)
    .gt("expires_at", now)
    .order("created_at", { ascending: false })
    .limit(5);

  if (error) {
    throw new ApiError(500, error.message, "DB_ERROR");
  }

  if (!tokens || tokens.length === 0) {
    throw new ApiError(400, "Invalid or expired reset code", "VALIDATION_ERROR");
  }

  let matchedId: string | null = null;
  for (const row of tokens) {
    if (await bcrypt.compare(code.toUpperCase(), (row as { token_hash: string }).token_hash)) {
      matchedId = (row as { id: string }).id;
      break;
    }
  }

  if (!matchedId) {
    throw new ApiError(400, "Invalid or expired reset code", "VALIDATION_ERROR");
  }

  await supabase
    .from("password_reset_tokens")
    .update({ used_at: now })
    .eq("id", matchedId);

  const env = getAuthEnv();
  const profile = await findProfileByEmail(emailLower);
  if (!profile) {
    throw new ApiError(400, "User not found", "VALIDATION_ERROR");
  }

  const resetToken = jwt.sign(
    { sub: profile.id, email: emailLower, purpose: "password_reset" },
    env.jwtAccessSecret,
    { expiresIn: "5m" }
  );

  return { resetToken };
}

export async function resetPassword(
  resetToken: string,
  newPassword: string
): Promise<{ success: boolean }> {
  const env = getAuthEnv();
  let payload: jwt.JwtPayload;
  try {
    payload = jwt.verify(resetToken, env.jwtAccessSecret) as jwt.JwtPayload;
  } catch {
    throw new ApiError(400, "Invalid or expired reset token", "VALIDATION_ERROR");
  }

  if (payload.purpose !== "password_reset" || !payload.sub) {
    throw new ApiError(400, "Invalid reset token", "VALIDATION_ERROR");
  }

  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
  const supabase = getSupabaseSecret();

  const { error: updateError } = await supabase
    .from("profiles")
    .update({ password_hash: passwordHash, updated_at: new Date().toISOString() })
    .eq("id", payload.sub);

  if (updateError) {
    throw new ApiError(500, updateError.message, "DB_ERROR");
  }

  await supabase
    .from("refresh_sessions")
    .update({ revoked_at: new Date().toISOString() })
    .eq("user_id", payload.sub)
    .is("revoked_at", null);

  return { success: true };
}

