export interface MailEnvConfig {
  user: string;
  pass: string;
  from: string;
}

export function loadMailEnv(): MailEnvConfig {
  return {
    user: (process.env.SMTP_USER ?? "").trim(),
    pass: (process.env.SMTP_PASS ?? "").trim(),
    from:
      (process.env.SMTP_FROM ?? "").trim() ||
      (process.env.SMTP_USER ?? "").trim() ||
      "BookMyBarber <noreply@bookmybarber.com>",
  };
}

export function isMailConfigured(): boolean {
  const env = loadMailEnv();
  return Boolean(env.user && env.pass);
}
