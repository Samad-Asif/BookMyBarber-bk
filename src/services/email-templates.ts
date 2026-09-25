/**
 * Pure renderers for BookMyBarber transactional emails (HTML + plain text).
 * Every user-controlled value is HTML-escaped; no I/O happens here.
 */

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export interface BookingEmailItem {
  name: string;
  workerName: string | null;
  pricePkr: number | null;
}

export interface BookingEmailContext {
  bookingId: string;
  /** Human-friendly booking reference, e.g. BMB-1A2B3C4D */
  reference: string;
  customerName: string | null;
  shopName: string;
  shopAddress: string | null;
  shopCity: string | null;
  shopPhone: string | null;
  mapsUrl: string | null;
  /** Raw shop-local date, "YYYY-MM-DD" */
  bookingDate: string;
  /** e.g. "Thursday 24 September 2026" */
  dateLabel: string;
  /** e.g. "3:30 PM" */
  startTimeLabel: string;
  /** e.g. "3:30 PM – 4:00 PM" */
  timeLabel: string;
  items: BookingEmailItem[];
  totalPkr: number;
  status: string;
  barberNotes: string | null;
}

export interface PaymentEmailInfo {
  amountPkr: number;
  paidAtLabel: string;
  paymentReference: string | null;
}

export interface LoyaltyEmailInfo {
  tierKey: string;
  tierName: string;
  lifetimeSpendPkr: number;
  nextTierName: string | null;
  amountToNextTierPkr: number;
  progressPercent: number;
  /** Set when this payment moved the customer into a higher tier. */
  upgradedFromName: string | null;
}

const C = {
  brand: "#E77423",
  ink: "#14181F",
  muted: "#676F7E",
  border: "#E5E0DC",
  page: "#FBFAF9",
  chip: "#F0EDEA",
  success: "#2A9D90",
  warning: "#B7791F",
};

/** Solid tier colours with ≥4.5:1 contrast for white text (same as admin/app). */
export const TIER_EMAIL_COLORS: Record<string, string> = {
  iron: "#4B5563",
  silver: "#5F6B7E",
  gold: "#8A6A0B",
  diamond: "#1D6FB8",
  platinum: "#6A46C8",
};

const FONT = "Inter, 'Segoe UI', Arial, sans-serif";
const SERIF = "'Playfair Display', Georgia, serif";

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Subject lines are single-line plain text. */
function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function formatPkr(amount: number): string {
  return `PKR ${new Intl.NumberFormat("en-US").format(Math.round(amount))}`;
}

/** "15:30:00" → "3:30 PM" (same rules as the app/admin time-format helpers) */
export function formatTime12h(time24: string): string {
  const [hRaw, mRaw] = String(time24).split(":");
  const h = Number.parseInt(hRaw, 10);
  const m = Number.parseInt(mRaw ?? "0", 10);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return String(time24);
  const suffix = h >= 12 ? "PM" : "AM";
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${suffix}`;
}

/** "2026-09-24" → "Thursday 24 September 2026" (the date is already shop-local) */
export function formatBookingDate(date: string): string {
  const [y, m, d] = date.split("-").map((part) => Number.parseInt(part, 10));
  if (!y || !m || !d) return date;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

function shortBookingDate(date: string): string {
  const [y, m, d] = date.split("-").map((part) => Number.parseInt(part, 10));
  if (!y || !m || !d) return date;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

function paragraph(html: string, opts?: { muted?: boolean; small?: boolean }): string {
  const size = opts?.small ? 13 : 15;
  const color = opts?.muted ? C.muted : C.ink;
  return `<p style="margin:0 0 16px;font-family:${FONT};font-size:${size}px;line-height:1.6;color:${color};">${html}</p>`;
}

function codeBlock(code: string): string {
  return `<div style="background:${C.chip};border-radius:12px;padding:20px;text-align:center;margin:0 0 20px;">
  <span style="font-family:'Courier New',monospace;font-size:34px;font-weight:700;letter-spacing:8px;color:${C.ink};">${escapeHtml(code)}</span>
</div>`;
}

function detailsTable(rows: Array<[string, string]>): string {
  const body = rows
    .map(
      ([label, valueHtml]) => `<tr>
    <td style="padding:10px 12px 10px 0;border-bottom:1px solid ${C.border};font-family:${FONT};font-size:13px;color:${C.muted};vertical-align:top;white-space:nowrap;">${escapeHtml(label)}</td>
    <td style="padding:10px 0;border-bottom:1px solid ${C.border};font-family:${FONT};font-size:14px;color:${C.ink};text-align:right;font-weight:600;vertical-align:top;">${valueHtml}</td>
  </tr>`
    )
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 20px;">${body}</table>`;
}

function statusPill(label: string, color: string): string {
  return `<span style="display:inline-block;padding:4px 12px;border-radius:999px;background:${color};color:#FFFFFF;font-family:${FONT};font-size:12px;font-weight:700;letter-spacing:0.3px;">${escapeHtml(label)}</span>`;
}

function itemsHtml(items: BookingEmailItem[]): string {
  return items
    .map((item) => {
      const who = item.workerName ? ` <span style="color:${C.muted};font-weight:400;">with ${escapeHtml(item.workerName)}</span>` : "";
      const price = item.pricePkr != null ? ` <span style="color:${C.muted};font-weight:400;white-space:nowrap;">· ${escapeHtml(formatPkr(item.pricePkr))}</span>` : "";
      return `${escapeHtml(item.name)}${who}${price}`;
    })
    .join("<br>");
}

/** Date on one line, the time range kept together on the next. */
function whenHtml(ctx: BookingEmailContext): string {
  return `${escapeHtml(ctx.dateLabel)}<br><span style="white-space:nowrap;">${escapeHtml(ctx.timeLabel)}</span>`;
}

function itemsText(items: BookingEmailItem[]): string {
  return items
    .map((item) => {
      const who = item.workerName ? ` with ${item.workerName}` : "";
      const price = item.pricePkr != null ? ` (${formatPkr(item.pricePkr)})` : "";
      return `  - ${item.name}${who}${price}`;
    })
    .join("\n");
}

function locationHtml(ctx: BookingEmailContext): string {
  const parts = [ctx.shopAddress, ctx.shopCity].filter(Boolean).map(escapeHtml).join(", ");
  const link = ctx.mapsUrl
    ? `<br><a href="${escapeHtml(ctx.mapsUrl)}" style="color:${C.brand};font-weight:600;text-decoration:none;">Open in Maps</a>`
    : "";
  return `${parts || "—"}${link}`;
}

function renderLayout(opts: {
  preheader: string;
  heading: string;
  body: string;
  footer?: string;
}): string {
  const footer =
    opts.footer ??
    "You are receiving this email because you have a BookMyBarber account.";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${escapeHtml(opts.heading)}</title>
</head>
<body style="margin:0;padding:0;background:${C.page};">
<span style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(opts.preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.page};">
  <tr>
    <td align="center" style="padding:32px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#FFFFFF;border:1px solid ${C.border};border-radius:16px;">
        <tr>
          <td style="padding:32px;">
            <p style="margin:0 0 6px;font-family:${FONT};font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:${C.brand};">BookMyBarber</p>
            <h1 style="margin:0 0 20px;font-family:${SERIF};font-size:26px;line-height:1.25;color:${C.ink};">${escapeHtml(opts.heading)}</h1>
            ${opts.body}
          </td>
        </tr>
      </table>
      <p style="max-width:520px;margin:16px auto 0;font-family:${FONT};font-size:12px;line-height:1.5;color:${C.muted};text-align:center;">${escapeHtml(footer)}</p>
    </td>
  </tr>
</table>
</body>
</html>`;
}

function greeting(name: string | null): string {
  const first = name?.trim().split(/\s+/)[0];
  return first ? `Hi ${first},` : "Hi there,";
}

// ---------------------------------------------------------------------------
// Auth emails
// ---------------------------------------------------------------------------

export function renderVerificationCodeEmail(code: string): RenderedEmail {
  return {
    subject: "Verify your BookMyBarber email",
    html: renderLayout({
      preheader: `Your verification code is ${code}`,
      heading: "Welcome to BookMyBarber",
      body:
        paragraph(
          "Thanks for signing up! Use the code below to verify your email address. This code expires in 15 minutes."
        ) +
        codeBlock(code) +
        paragraph("If you did not sign up for BookMyBarber, you can safely ignore this email.", {
          muted: true,
          small: true,
        }),
    }),
    text: [
      "Welcome to BookMyBarber",
      "",
      "Thanks for signing up! Use this code to verify your email address (expires in 15 minutes):",
      "",
      `    ${code}`,
      "",
      "If you did not sign up for BookMyBarber, you can safely ignore this email.",
    ].join("\n"),
  };
}

export function renderPasswordResetCodeEmail(code: string): RenderedEmail {
  return {
    subject: "Your BookMyBarber Password Reset Code",
    html: renderLayout({
      preheader: `Your password reset code is ${code}`,
      heading: "Reset your password",
      body:
        paragraph(
          "You requested a password reset. Use the code below to reset your password. This code expires in 15 minutes."
        ) +
        codeBlock(code) +
        paragraph("If you did not request this, you can safely ignore this email.", {
          muted: true,
          small: true,
        }),
    }),
    text: [
      "Reset your BookMyBarber password",
      "",
      "Use this code to reset your password (expires in 15 minutes):",
      "",
      `    ${code}`,
      "",
      "If you did not request this, you can safely ignore this email.",
    ].join("\n"),
  };
}

export function renderAccountLockedEmail(): RenderedEmail {
  return {
    subject: "Your BookMyBarber account has been locked",
    html: renderLayout({
      preheader: "Too many verification attempts — your account is locked for 24 hours.",
      heading: "Account locked",
      body:
        paragraph(
          "Your BookMyBarber account has been temporarily locked for 24 hours due to too many verification attempts."
        ) +
        paragraph("You will be able to try again after the lock period expires.") +
        paragraph("If you did not make these attempts, please contact support.", {
          muted: true,
          small: true,
        }),
    }),
    text: [
      "Your BookMyBarber account has been locked",
      "",
      "Your account has been temporarily locked for 24 hours due to too many verification attempts.",
      "You will be able to try again after the lock period expires.",
      "",
      "If you did not make these attempts, please contact support.",
    ].join("\n"),
  };
}

// ---------------------------------------------------------------------------
// Booking + payment emails
// ---------------------------------------------------------------------------

export function renderBookingConfirmationEmail(ctx: BookingEmailContext): RenderedEmail {
  const when = `${ctx.dateLabel} · ${ctx.timeLabel}`;
  const rows: Array<[string, string]> = [
    ["Booking", escapeHtml(ctx.reference)],
    ["Shop", escapeHtml(ctx.shopName)],
    ["Where", locationHtml(ctx)],
    ["When", whenHtml(ctx)],
    [ctx.items.length > 1 ? "Services" : "Service", itemsHtml(ctx.items) || "—"],
    ["Total", escapeHtml(formatPkr(ctx.totalPkr))],
  ];
  if (ctx.shopPhone) rows.push(["Shop phone", escapeHtml(ctx.shopPhone)]);

  const notes = ctx.barberNotes?.trim();
  const body =
    paragraph(escapeHtml(greeting(ctx.customerName))) +
    paragraph(
      `Great news — <strong>${escapeHtml(ctx.shopName)}</strong> has confirmed your appointment. We look forward to seeing you!`
    ) +
    `<p style="margin:0 0 16px;">${statusPill("Confirmed", C.success)}</p>` +
    detailsTable(rows) +
    (notes
      ? paragraph(`<strong>Note from your barber:</strong> ${escapeHtml(notes)}`)
      : "") +
    paragraph(
      "Please arrive a few minutes early. Need to change or cancel? Open the BookMyBarber app and go to Bookings.",
      { muted: true, small: true }
    );

  return {
    subject: oneLine(
      `Booking confirmed: ${ctx.shopName} · ${shortBookingDate(ctx.bookingDate)}, ${ctx.startTimeLabel}`
    ),
    html: renderLayout({
      preheader: `${ctx.shopName} · ${when}`,
      heading: "Your booking is confirmed",
      body,
    }),
    text: [
      greeting(ctx.customerName),
      "",
      `Great news — ${ctx.shopName} has confirmed your appointment.`,
      "",
      `Booking:  ${ctx.reference}`,
      `Shop:     ${ctx.shopName}`,
      `Where:    ${[ctx.shopAddress, ctx.shopCity].filter(Boolean).join(", ") || "—"}`,
      ...(ctx.mapsUrl ? [`Map:      ${ctx.mapsUrl}`] : []),
      `When:     ${when}`,
      `Services:`,
      itemsText(ctx.items),
      `Total:    ${formatPkr(ctx.totalPkr)}`,
      ...(ctx.shopPhone ? [`Phone:    ${ctx.shopPhone}`] : []),
      ...(notes ? ["", `Note from your barber: ${notes}`] : []),
      "",
      "Please arrive a few minutes early. Need to change or cancel? Open the BookMyBarber app and go to Bookings.",
    ].join("\n"),
  };
}

function loyaltyHtml(loyalty: LoyaltyEmailInfo): string {
  const color = TIER_EMAIL_COLORS[loyalty.tierKey] ?? C.brand;
  const pct = Math.max(0, Math.min(100, Math.round(loyalty.progressPercent)));
  const upgrade = loyalty.upgradedFromName
    ? `<div style="background:${color};border-radius:10px;padding:12px 14px;margin:0 0 14px;font-family:${FONT};font-size:14px;line-height:1.5;color:#FFFFFF;font-weight:600;">Congratulations — you've been upgraded from ${escapeHtml(loyalty.upgradedFromName)} to ${escapeHtml(loyalty.tierName)}!</div>`
    : "";
  const next = loyalty.nextTierName
    ? `Spend <strong>${escapeHtml(formatPkr(loyalty.amountToNextTierPkr))}</strong> more to reach <strong>${escapeHtml(loyalty.nextTierName)}</strong>.`
    : "You've reached our highest tier — thank you for your loyalty!";
  return `<div style="border:1px solid ${C.border};border-radius:12px;padding:16px;margin:0 0 20px;">
  ${upgrade}
  <p style="margin:0 0 10px;font-family:${FONT};font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:${C.muted};">Your loyalty status</p>
  <p style="margin:0 0 10px;">${statusPill(loyalty.tierName, color)}
    <span style="font-family:${FONT};font-size:13px;color:${C.muted};margin-left:8px;">Lifetime spend ${escapeHtml(formatPkr(loyalty.lifetimeSpendPkr))}</span></p>
  <div style="background:${C.chip};border-radius:999px;height:8px;margin:0 0 10px;overflow:hidden;">
    <div style="width:${pct}%;background:${color};height:8px;border-radius:999px;"></div>
  </div>
  <p style="margin:0;font-family:${FONT};font-size:13px;line-height:1.5;color:${C.ink};">${next}</p>
</div>`;
}

function loyaltyText(loyalty: LoyaltyEmailInfo): string[] {
  return [
    ...(loyalty.upgradedFromName
      ? [`Congratulations — you've been upgraded from ${loyalty.upgradedFromName} to ${loyalty.tierName}!`]
      : []),
    `Loyalty status: ${loyalty.tierName} (lifetime spend ${formatPkr(loyalty.lifetimeSpendPkr)})`,
    loyalty.nextTierName
      ? `Spend ${formatPkr(loyalty.amountToNextTierPkr)} more to reach ${loyalty.nextTierName}.`
      : "You've reached our highest tier — thank you for your loyalty!",
  ];
}

export function renderPaymentReceiptEmail(
  ctx: BookingEmailContext,
  payment: PaymentEmailInfo,
  loyalty: LoyaltyEmailInfo | null
): RenderedEmail {
  const confirmed = ctx.status === "approved" || ctx.status === "completed";
  const statusLabel = confirmed ? "Confirmed" : "Awaiting barber confirmation";
  const when = `${ctx.dateLabel} · ${ctx.timeLabel}`;
  const rows: Array<[string, string]> = [
    ["Receipt", escapeHtml(ctx.reference)],
    ["Paid on", escapeHtml(payment.paidAtLabel)],
    ["Shop", escapeHtml(ctx.shopName)],
    ["Appointment", whenHtml(ctx)],
    [ctx.items.length > 1 ? "Services" : "Service", itemsHtml(ctx.items) || "—"],
    ["Amount paid", escapeHtml(formatPkr(payment.amountPkr))],
  ];
  if (payment.paymentReference) {
    rows.push(["Payment ref.", `<span style="font-family:'Courier New',monospace;font-size:12px;">${escapeHtml(payment.paymentReference)}</span>`]);
  }

  const body =
    paragraph(escapeHtml(greeting(ctx.customerName))) +
    paragraph(
      `Thank you for your payment of <strong>${escapeHtml(formatPkr(payment.amountPkr))}</strong> for your booking at <strong>${escapeHtml(ctx.shopName)}</strong>. Here is your receipt.`
    ) +
    `<p style="margin:0 0 16px;">${statusPill(statusLabel, confirmed ? C.success : C.warning)}</p>` +
    detailsTable(rows) +
    (loyalty ? loyaltyHtml(loyalty) : "") +
    paragraph(
      confirmed
        ? "Your appointment is confirmed. You can find it any time under Bookings in the BookMyBarber app."
        : "The shop will confirm your appointment shortly — we'll email you as soon as they do.",
      { muted: true, small: true }
    );

  return {
    subject: oneLine(`Your BookMyBarber receipt — ${formatPkr(payment.amountPkr)} paid to ${ctx.shopName}`),
    html: renderLayout({
      preheader: `Thanks! ${formatPkr(payment.amountPkr)} received for ${ctx.shopName}.`,
      heading: "Thank you for your payment",
      body,
      footer: "This is your payment receipt from BookMyBarber. Keep it for your records.",
    }),
    text: [
      greeting(ctx.customerName),
      "",
      `Thank you for your payment of ${formatPkr(payment.amountPkr)} for your booking at ${ctx.shopName}.`,
      "",
      `Receipt:      ${ctx.reference}`,
      `Paid on:      ${payment.paidAtLabel}`,
      `Shop:         ${ctx.shopName}`,
      `Appointment:  ${when}`,
      `Status:       ${statusLabel}`,
      `Services:`,
      itemsText(ctx.items),
      `Amount paid:  ${formatPkr(payment.amountPkr)}`,
      ...(payment.paymentReference ? [`Payment ref.: ${payment.paymentReference}`] : []),
      ...(loyalty ? ["", ...loyaltyText(loyalty)] : []),
      "",
      confirmed
        ? "Your appointment is confirmed. You can find it under Bookings in the BookMyBarber app."
        : "The shop will confirm your appointment shortly — we'll email you as soon as they do.",
    ].join("\n"),
  };
}

export function renderTestEmail(sentAtLabel: string): RenderedEmail {
  return {
    subject: "BookMyBarber email test",
    html: renderLayout({
      preheader: "Your BookMyBarber email settings are working.",
      heading: "Email is working",
      body:
        paragraph(
          "This is a test message from the BookMyBarber admin dashboard. If you can read it, verification codes, booking confirmations and payment receipts can be delivered."
        ) + paragraph(`Sent ${escapeHtml(sentAtLabel)}.`, { muted: true, small: true }),
      footer: "Sent from the BookMyBarber admin dashboard.",
    }),
    text: [
      "Email is working",
      "",
      "This is a test message from the BookMyBarber admin dashboard. If you can read it,",
      "verification codes, booking confirmations and payment receipts can be delivered.",
      "",
      `Sent ${sentAtLabel}.`,
    ].join("\n"),
  };
}
