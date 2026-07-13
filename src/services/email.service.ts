import nodemailer from "nodemailer";
import { loadMailEnv, isMailConfigured } from "../config/mailEnv";
import { ApiError } from "../lib/errors";
import { logger } from "../config/logger";

let transporter: nodemailer.Transporter | null = null;

function getTransporter(): nodemailer.Transporter {
  if (transporter) return transporter;
  const env = loadMailEnv();
  if (!isMailConfigured()) {
    throw new ApiError(500, "SMTP email not configured", "AUTH_CONFIG_ERROR");
  }
  transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: env.user, pass: env.pass },
  });
  return transporter;
}

export function validateEmailConfig(): void {
  const env = loadMailEnv();
  if (!env.user || !env.pass) {
    throw new ApiError(
      500,
      "Email not configured: SMTP_USER and SMTP_PASS are required",
      "AUTH_CONFIG_ERROR"
    );
  }
}

async function sendEmail(opts: { to: string; subject: string; html: string }): Promise<void> {
  const env = loadMailEnv();
  const transport = getTransporter();
  try {
    await transport.sendMail({
      from: env.from,
      to: opts.to,
      subject: opts.subject,
      html: opts.html,
    });
  } catch (err: unknown) {
    logger.error("sendEmail failed", {
      to: opts.to,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new ApiError(
      500,
      `Failed to send email: ${err instanceof Error ? err.message : String(err)}`,
      "EMAIL_FAILED"
    );
  }
}

export async function sendPasswordResetCode(
  email: string,
  code: string
): Promise<void> {
  return sendEmail({
    to: email,
    subject: "Your BookMyBarber Password Reset Code",
    html: `
      <!DOCTYPE html>
      <html>
        <head><meta charset="utf-8"></head>
        <body style="font-family: Inter, Arial, sans-serif; background: #FBFAF9; padding: 32px;">
          <div style="max-width: 480px; margin: 0 auto; background: #FFFFFF; border-radius: 16px; border: 1px solid #E5E0DC; padding: 32px;">
            <h1 style="font-family: 'Playfair Display', serif; color: #E77423; font-size: 28px; margin: 0 0 8px;">BookMyBarber</h1>
            <p style="color: #14181F; font-size: 15px; line-height: 1.5; margin: 0 0 20px;">
              You requested a password reset. Use the code below to reset your password. This code expires in 15 minutes.
            </p>
            <div style="background: #F0EDEA; border-radius: 12px; padding: 20px; text-align: center; margin-bottom: 20px;">
              <span style="font-family: 'Courier New', monospace; font-size: 36px; font-weight: 700; letter-spacing: 8px; color: #14181F;">
                ${code}
              </span>
            </div>
            <p style="color: #676F7E; font-size: 13px; line-height: 1.4; margin: 0;">
              If you did not request this, you can safely ignore this email.
            </p>
          </div>
        </body>
      </html>
    `,
  });
}

export async function sendAccountLockedEmail(email: string): Promise<void> {
  return sendEmail({
    to: email,
    subject: "Your BookMyBarber account has been locked",
    html: `
      <!DOCTYPE html>
      <html>
        <head><meta charset="utf-8"></head>
        <body style="font-family: Inter, Arial, sans-serif; background: #FBFAF9; padding: 32px;">
          <div style="max-width: 480px; margin: 0 auto; background: #FFFFFF; border-radius: 16px; border: 1px solid #E5E0DC; padding: 32px;">
            <h1 style="font-family: 'Playfair Display', serif; color: #E77423; font-size: 28px; margin: 0 0 8px;">Account Locked</h1>
            <p style="color: #14181F; font-size: 15px; line-height: 1.5; margin: 0 0 20px;">
              Your BookMyBarber account has been temporarily locked for 24 hours due to too many verification attempts.
            </p>
            <p style="color: #14181F; font-size: 15px; line-height: 1.5; margin: 0 0 20px;">
              You will be able to try again after the lock period expires.
            </p>
            <p style="color: #676F7E; font-size: 13px; line-height: 1.4; margin: 0;">
              If you did not make these attempts, please contact support.
            </p>
          </div>
        </body>
      </html>
    `,
  });
}

export async function sendEmailVerificationCode(
  email: string,
  code: string
): Promise<void> {
  return sendEmail({
    to: email,
    subject: "Verify your BookMyBarber email",
    html: `
      <!DOCTYPE html>
      <html>
        <head><meta charset="utf-8"></head>
        <body style="font-family: Inter, Arial, sans-serif; background: #FBFAF9; padding: 32px;">
          <div style="max-width: 480px; margin: 0 auto; background: #FFFFFF; border-radius: 16px; border: 1px solid #E5E0DC; padding: 32px;">
            <h1 style="font-family: 'Playfair Display', serif; color: #E77423; font-size: 28px; margin: 0 0 8px;">Welcome to BookMyBarber</h1>
            <p style="color: #14181F; font-size: 15px; line-height: 1.5; margin: 0 0 20px;">
              Thanks for signing up! Use the code below to verify your email address. This code expires in 15 minutes.
            </p>
            <div style="background: #F0EDEA; border-radius: 12px; padding: 20px; text-align: center; margin-bottom: 20px;">
              <span style="font-family: 'Courier New', monospace; font-size: 36px; font-weight: 700; letter-spacing: 8px; color: #14181F;">
                ${code}
              </span>
            </div>
            <p style="color: #676F7E; font-size: 13px; line-height: 1.4; margin: 0;">
              If you did not sign up for BookMyBarber, you can safely ignore this email.
            </p>
          </div>
        </body>
      </html>
    `,
  });
}
