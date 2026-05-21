import { loadAuthEnv } from "../../config/authEnv";

const authEnv = () => loadAuthEnv();

export function getMicrosoftTenant(): string {
  return authEnv().microsoftTenantId;
}

export function getMicrosoftClientId(): string {
  return authEnv().microsoftClientId;
}

export function getMicrosoftClientSecret(): string {
  return authEnv().microsoftClientSecret;
}

export function getMicrosoftAuthBase(): string {
  return `https://login.microsoftonline.com/${getMicrosoftTenant()}/oauth2/v2.0`;
}

export const MS_GRAPH = "https://graph.microsoft.com/v1.0";

export function isMicrosoftOAuthConfigured(): boolean {
  const env = authEnv();
  return Boolean(env.microsoftClientId && env.microsoftClientSecret);
}

export function buildMicrosoftAuthorizeUrl(params: {
  redirectUri: string;
  scope: string;
  state: string;
}): string {
  const search = new URLSearchParams({
    client_id: getMicrosoftClientId(),
    response_type: "code",
    redirect_uri: params.redirectUri,
    response_mode: "query",
    scope: params.scope,
    state: params.state,
  });
  return `${getMicrosoftAuthBase()}/authorize?${search.toString()}`;
}

export async function microsoftTokenRequest(body: Record<string, string>) {
  const res = await fetch(`${getMicrosoftAuthBase()}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Microsoft token error: ${text}`);
  }
  return res.json() as Promise<{
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    id_token?: string;
  }>;
}

export async function exchangeMicrosoftAuthCode(
  code: string,
  redirectUri: string
) {
  return microsoftTokenRequest({
    client_id: getMicrosoftClientId(),
    client_secret: getMicrosoftClientSecret(),
    code,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
}

export async function refreshMicrosoftOAuthToken(refreshToken: string) {
  return microsoftTokenRequest({
    client_id: getMicrosoftClientId(),
    client_secret: getMicrosoftClientSecret(),
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
}

export async function graphGet(accessToken: string, path: string) {
  const res = await fetch(`${MS_GRAPH}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function graphPost(accessToken: string, path: string, body: unknown) {
  const res = await fetch(`${MS_GRAPH}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}
