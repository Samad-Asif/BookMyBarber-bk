import { z } from "zod";
import { USER_ROLES } from "../types/auth";

const CITIES = ["Gujranwala", "Lahore", "Vehari"] as const;

const emailSchema = z
  .string()
  .trim()
  .email("Invalid email format")
  .transform((e) => e.toLowerCase());

const passwordSchema = z
  .string()
  .min(6, "Password must be at least 6 characters");

const codeSchema = z
  .string()
  .trim()
  .min(1, "code is required")
  .transform((c) => c.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6))
  .refine((c) => c.length === 6, "code must be 6 characters");

export const loginBodySchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "password is required"),
});

export const registerBodySchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  role: z
    .enum(USER_ROLES)
    .optional()
    .default("customer"),
  name: z.string().trim().min(1).max(120).optional(),
  city: z.enum(CITIES).optional(),
});

export const verifyEmailBodySchema = z.object({
  email: emailSchema,
  code: codeSchema,
});

export const resendVerificationBodySchema = z.object({
  email: emailSchema,
});

export const googleBodySchema = z.object({
  idToken: z.string().min(1, "idToken is required"),
});

export const microsoftExchangeBodySchema = z.object({
  code: z.string().min(1, "code is required"),
  // Deep links (bookmybarberapp://…) are not always valid absolute URLs for z.url()
  redirectUri: z.string().trim().min(1, "redirectUri is required"),
});

export const refreshBodySchema = z
  .object({
    refresh_token: z.string().min(1).optional(),
    refreshToken: z.string().min(1).optional(),
  })
  .refine((b) => Boolean(b.refresh_token ?? b.refreshToken), {
    message: "refresh_token is required",
  })
  .transform((b) => ({
    refresh_token: (b.refresh_token ?? b.refreshToken) as string,
  }));

export const forgotPasswordBodySchema = z.object({
  email: emailSchema,
});

export const verifyResetCodeBodySchema = z.object({
  email: emailSchema,
  code: codeSchema,
});

export const resetPasswordBodySchema = z.object({
  resetToken: z.string().min(1, "resetToken is required"),
  password: passwordSchema,
});

export const logoutBodySchema = z.object({
  refresh_token: z.string().min(1).optional(),
  refreshToken: z.string().min(1).optional(),
});
