export type MailTransportKind = "gmail" | "smtp";

export interface MailEnvConfig {
  transport: MailTransportKind;
  /** null → nodemailer's built-in Gmail service settings */
  host: string | null;
  port: number | null;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
  replyTo: string | null;
  /** EMAIL_DRY_RUN=true → render + log emails without sending (local dev) */
  dryRun: boolean;
  /** Which env var supplied each credential (names only, never values). */
  sources: { user: string | null; pass: string | null; from: string | null };
}

// Accept the common aliases so a dashboard-configured deployment works even if
// the variables were not named exactly SMTP_USER / SMTP_PASS.
const USER_VARS = ["SMTP_USER", "SMTP_USERNAME", "EMAIL_USER", "GMAIL_USER"];
const PASS_VARS = [
  "SMTP_PASS",
  "SMTP_PASSWORD",
  "EMAIL_PASS",
  "EMAIL_PASSWORD",
  "GMAIL_APP_PASSWORD",
];
const FROM_VARS = ["SMTP_FROM", "EMAIL_FROM", "MAIL_FROM"];

const DEFAULT_SENDER_NAME = "BookMyBarber";

/** Values pasted into hosting dashboards often keep their surrounding quotes. */
function stripQuotes(value: string): string {
  const match = value.match(/^(["'])(.*)\1$/s);
  return match ? match[2].trim() : value;
}

function firstEnv(names: string[]): { value: string; source: string | null } {
  for (const name of names) {
    const value = stripQuotes((process.env[name] ?? "").trim());
    if (value) return { value, source: name };
  }
  return { value: "", source: null };
}

function withSenderName(from: string): string {
  // Bare address → add a display name so inboxes show "BookMyBarber".
  return /^[^\s<>"]+@[^\s<>"]+$/.test(from) ? `"${DEFAULT_SENDER_NAME}" <${from}>` : from;
}

export function loadMailEnv(): MailEnvConfig {
  const user = firstEnv(USER_VARS);
  const pass = firstEnv(PASS_VARS);
  const from = firstEnv(FROM_VARS);

  const host = stripQuotes((process.env.SMTP_HOST ?? "").trim()) || null;
  const transport: MailTransportKind =
    !host || host.toLowerCase() === "smtp.gmail.com" ? "gmail" : "smtp";
  const portRaw = Number(process.env.SMTP_PORT);
  const port = Number.isInteger(portRaw) && portRaw > 0 ? portRaw : null;
  const secure =
    (process.env.SMTP_SECURE ?? "").trim().toLowerCase() === "true" || port === 465;

  return {
    transport,
    host,
    port,
    secure,
    user: user.value,
    // Gmail shows App Passwords as "abcd efgh ijkl mnop"; the spaces are not
    // part of the password and make the SMTP login fail when pasted as-is.
    pass: transport === "gmail" ? pass.value.replace(/\s+/g, "") : pass.value,
    from: withSenderName(
      from.value || (user.value ? `"${DEFAULT_SENDER_NAME}" <${user.value}>` : "")
    ),
    replyTo: stripQuotes((process.env.SMTP_REPLY_TO ?? "").trim()) || null,
    dryRun: (process.env.EMAIL_DRY_RUN ?? "").trim().toLowerCase() === "true",
    sources: { user: user.source, pass: pass.source, from: from.source },
  };
}

/** Names of the env vars that still need a value before email can be sent. */
export function missingMailEnv(env: MailEnvConfig = loadMailEnv()): string[] {
  const missing: string[] = [];
  if (!env.user) missing.push("SMTP_USER");
  if (!env.pass) missing.push("SMTP_PASS");
  return missing;
}

export function isMailConfigured(): boolean {
  return missingMailEnv().length === 0;
}
