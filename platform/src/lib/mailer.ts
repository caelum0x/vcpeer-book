import nodemailer from "nodemailer";

// Reuses the exact same EMAIL_SERVER_* creds already configured for Cal.com
// in this repo's .env / /etc/products/vcpeer-book.env (OCI Email Delivery in
// production, Mailpit locally) — no new SMTP provider, no new secret.
let transporter: nodemailer.Transporter | null = null;

function getTransporter(): nodemailer.Transporter {
  if (transporter) return transporter;
  transporter = nodemailer.createTransport({
    host: process.env.EMAIL_SERVER_HOST || "mailpit",
    port: Number(process.env.EMAIL_SERVER_PORT || 1025),
    secure: Number(process.env.EMAIL_SERVER_PORT || 1025) === 465,
    auth:
      process.env.EMAIL_SERVER_USER && process.env.EMAIL_SERVER_PASSWORD
        ? { user: process.env.EMAIL_SERVER_USER, pass: process.env.EMAIL_SERVER_PASSWORD }
        : undefined,
  });
  return transporter;
}

export async function sendMail(opts: { to: string; subject: string; html: string; text?: string }): Promise<void> {
  const from = `${process.env.EMAIL_FROM_NAME || "VCPeer"} <${process.env.EMAIL_FROM || "bookings@vcpeer.com"}>`;
  await getTransporter().sendMail({
    from,
    to: opts.to,
    subject: opts.subject,
    html: opts.html,
    text: opts.text || opts.html.replace(/<[^>]+>/g, ""),
  });
}

export function recoveryEmailHtml(params: { attendeeName: string; rescheduleUrl: string; eventTitle: string }): string {
  return `
    <p>Hi ${escapeHtml(params.attendeeName)},</p>
    <p>Looks like you missed <strong>${escapeHtml(params.eventTitle)}</strong>. No problem — pick a new time
    whenever works for you:</p>
    <p><a href="${params.rescheduleUrl}">Rebook instantly &rarr;</a></p>
    <p>&mdash; VCPeer</p>
  `;
}

export function reviewRequestEmailHtml(params: { attendeeName: string; eventTitle: string; reviewUrl: string }): string {
  return `
    <p>Hi ${escapeHtml(params.attendeeName)},</p>
    <p>Thanks for joining <strong>${escapeHtml(params.eventTitle)}</strong>. Got 30 seconds to tell us how it went?</p>
    <p><a href="${params.reviewUrl}">Leave quick feedback &rarr;</a></p>
    <p>&mdash; VCPeer</p>
  `;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}
