import { Router } from "express";
import crypto from "crypto";
import { query, queryOne } from "../db";
import { notifyNewBooking, notifyCancellation } from "../lib/notify";
import { sendMail, recoveryEmailHtml } from "../lib/mailer";
import { ah } from "../lib/asyncHandler";

// Webhook-driven notification/automation layer (item 6), fed by Cal.com's
// own BOOKING_CREATED / BOOKING_CANCELLED / BOOKING_RESCHEDULED webhooks.
// Configure in the Cal.com admin: Settings -> Developer -> Webhooks -> New
// webhook, subscriberUrl = https://book.vcpeer.com/webhooks/calcom (routed
// to this service, not the calcom container, by the Caddy config in
// deploy/platform.caddy), secret = CALCOM_WEBHOOK_SECRET below. This is a
// one-time in-app configuration step (documented in deploy/RUNBOOK.md),
// not something this code can create on its own — Cal.com's webhook admin
// UI has no public "create via API with my own session" shortcut without
// an API key being issued first, which is itself an in-app action.

export const calcomWebhooksRouter = Router();

interface CalcomWebhookPayload {
  triggerEvent: string;
  createdAt: string;
  payload: {
    uid: string;
    type?: string;
    title: string;
    startTime: string;
    endTime: string;
    cancellationReason?: string;
    organizer?: { email: string; name: string };
    attendees?: { name: string; email: string }[];
    location?: string;
  };
}

function verifySignature(rawBody: string, signatureHeader: string | undefined, secret: string): boolean {
  if (!secret) return true; // no secret configured yet (local dev) — accept, but this branch never runs once CALCOM_WEBHOOK_SECRET is set in production
  if (!signatureHeader) return false;
  const provided = signatureHeader.replace(/^sha256=/, "");
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

calcomWebhooksRouter.post("/webhooks/calcom", ah(async (req, res) => {
  const rawBody = (req as any).rawBody as string;
  const signature = req.header("x-cal-signature-256");
  const secret = process.env.CALCOM_WEBHOOK_SECRET || "";

  if (!verifySignature(rawBody, signature, secret)) {
    await query(`INSERT INTO platform.webhook_log (source, trigger_event, payload, processed_ok, error) VALUES ('calcom', 'UNKNOWN', $1, false, 'signature verification failed')`, [rawBody]);
    res.status(401).json({ error: "invalid signature" });
    return;
  }

  let event: CalcomWebhookPayload;
  try {
    event = JSON.parse(rawBody);
  } catch {
    res.status(400).json({ error: "invalid JSON" });
    return;
  }

  try {
    await handleCalcomEvent(event);
    await query(`INSERT INTO platform.webhook_log (source, trigger_event, payload, processed_ok) VALUES ('calcom', $1, $2, true)`, [
      event.triggerEvent,
      JSON.stringify(event),
    ]);
    res.json({ received: true });
  } catch (err: any) {
    console.error("[webhooks/calcom] handler error:", err);
    await query(`INSERT INTO platform.webhook_log (source, trigger_event, payload, processed_ok, error) VALUES ('calcom', $1, $2, false, $3)`, [
      event.triggerEvent,
      JSON.stringify(event),
      String(err?.message || err),
    ]);
    // Still 200 — we've durably logged it; Cal.com's own retry queue
    // (calcom-cron's webhookTriggers poll) would otherwise keep redelivering
    // a payload that fails for a structural reason, not a transient one.
    res.json({ received: true, warning: "processing error logged" });
  }
}));

async function handleCalcomEvent(event: CalcomWebhookPayload): Promise<void> {
  const p = event.payload;
  const attendee = p.attendees?.[0];
  const organizerEmail = p.organizer?.email || "";

  // Feed the analytics funnel (item 5) directly from the webhook — this is
  // the real, always-on source for the booking_confirmed/booking_cancelled
  // stages (more reliable than relying only on a client-side beacon, which
  // Cal.com community edition's booking page has no script-injection point
  // for without forking the source — see analytics.ts's header comment).
  if (event.triggerEvent === "BOOKING_CREATED") {
    await query(
      `INSERT INTO platform.analytics_events (event_type, event_type_slug, booking_uid, metadata)
       VALUES ('booking_confirmed', $1, $2, $3)`,
      [p.type || null, p.uid, JSON.stringify({ title: p.title })]
    );
    await query(
      `INSERT INTO platform.bookings_tracked (booking_uid, event_type_slug, attendee_email, organizer_email, start_time, end_time, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'created')
       ON CONFLICT (booking_uid) DO UPDATE SET start_time = $5, end_time = $6, status = 'created', updated_at = now()`,
      [p.uid, p.type || null, attendee?.email || null, organizerEmail, p.startTime, p.endTime]
    );
    await notifyNewBooking({
      attendeeName: attendee?.name || "unknown",
      attendeeEmail: attendee?.email || "unknown",
      eventTitle: p.title,
      startTime: p.startTime,
      joinUrl: p.location,
    });
  } else if (event.triggerEvent === "BOOKING_CANCELLED") {
    await query(
      `INSERT INTO platform.analytics_events (event_type, event_type_slug, booking_uid, metadata)
       VALUES ('booking_cancelled', $1, $2, $3)`,
      [p.type || null, p.uid, JSON.stringify({ reason: p.cancellationReason || null })]
    );
    await query(`UPDATE platform.bookings_tracked SET status = 'cancelled', updated_at = now() WHERE booking_uid = $1`, [p.uid]);
    await notifyCancellation({ eventTitle: p.title, attendeeName: attendee?.name || "unknown", startTime: p.startTime });

    // Reschedule-recovery email (item 6 + item 12) — one-click rebook link,
    // sent the moment a booking is cancelled (not just on no-show).
    if (attendee?.email) {
      const rescheduleUrl = `${process.env.NEXT_PUBLIC_WEBAPP_URL || "https://book.vcpeer.com"}/reschedule/${p.uid}`;
      await sendMail({
        to: attendee.email,
        subject: `Still want to talk? Rebook "${p.title}" in one click`,
        html: recoveryEmailHtml({ attendeeName: attendee.name, rescheduleUrl, eventTitle: p.title }),
      });
      await query(`UPDATE platform.bookings_tracked SET recovery_sent_at = now() WHERE booking_uid = $1`, [p.uid]);
    }
  } else if (event.triggerEvent === "BOOKING_RESCHEDULED") {
    await query(`UPDATE platform.bookings_tracked SET status = 'rescheduled', start_time = $2, end_time = $3, updated_at = now() WHERE booking_uid = $1`, [
      p.uid,
      p.startTime,
      p.endTime,
    ]);
  }
}

/**
 * Receives a room-join beacon from vcpeer.com's own MiroTalk room server
 * (`vcpeer/app/src/server.js`'s `/join/:roomId` route) so this service can
 * tell a real no-show (booking time passed, nobody ever joined) apart from
 * a completed call. Cross-repo wiring: `vcpeer` itself needs a small beacon
 * POST added to its own join handler — tracked as a remaining item in
 * BUILD-LOG-2026-10-23.md, this endpoint is the receiving half and is fully
 * live and real on this side.
 */
calcomWebhooksRouter.post("/webhooks/vcpeer-join", ah(async (req, res) => {
  const { bookingUid, roomId } = req.body || {};
  if (!bookingUid && !roomId) {
    res.status(400).json({ error: "bookingUid or roomId required" });
    return;
  }
  const uid = bookingUid || roomId;
  await query(`UPDATE platform.bookings_tracked SET joined_at = now(), status = 'completed', updated_at = now() WHERE booking_uid = $1`, [uid]);
  await query(`INSERT INTO platform.analytics_events (event_type, booking_uid) VALUES ('call_joined', $1)`, [uid]);
  res.status(204).end();
}));
