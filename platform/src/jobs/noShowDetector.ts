import { query } from "../db";
import { sendMail, recoveryEmailHtml, reviewRequestEmailHtml } from "../lib/mailer";
import { notifyNoShow } from "../lib/notify";

// Item 6 (no-show detection) + item 12 (no-show/cancellation recovery) +
// the review-request half of item 6. Runs as a plain setInterval inside
// this service, same pattern as calcom-cron's crond polling in
// docker-compose.yml — no external queue/broker needed at this scale.

interface TrackedBooking {
  booking_uid: string;
  event_type_slug: string | null;
  attendee_email: string | null;
  start_time: string;
  end_time: string;
}

const NO_SHOW_GRACE_MINUTES = 10; // how long past start_time before we call it a no-show
const REVIEW_REQUEST_DELAY_MINUTES = 60; // how long after end_time before asking for a review

export async function runNoShowDetectionPass(): Promise<{ noShows: number; reviewsRequested: number }> {
  const noShowRows = await query<TrackedBooking & { title?: string }>(
    `SELECT booking_uid, event_type_slug, attendee_email, start_time, end_time
     FROM platform.bookings_tracked
     WHERE status = 'created'
       AND joined_at IS NULL
       AND no_show_notified_at IS NULL
       AND start_time < now() - ($1 || ' minutes')::interval`,
    [String(NO_SHOW_GRACE_MINUTES)]
  );

  let noShows = 0;
  for (const booking of noShowRows) {
    await query(`UPDATE platform.bookings_tracked SET status = 'no_show', no_show_notified_at = now(), updated_at = now() WHERE booking_uid = $1`, [
      booking.booking_uid,
    ]);
    await query(`INSERT INTO platform.analytics_events (event_type, event_type_slug, booking_uid) VALUES ('booking_cancelled', $1, $2)`, [
      booking.event_type_slug,
      booking.booking_uid,
    ]);

    if (booking.attendee_email) {
      const rescheduleUrl = `${process.env.NEXT_PUBLIC_WEBAPP_URL || "https://book.vcpeer.com"}/reschedule/${booking.booking_uid}`;
      try {
        await sendMail({
          to: booking.attendee_email,
          subject: `Missed it? Rebook instantly`,
          html: recoveryEmailHtml({
            attendeeName: booking.attendee_email.split("@")[0],
            rescheduleUrl,
            eventTitle: booking.event_type_slug || "your call",
          }),
        });
        await query(`UPDATE platform.bookings_tracked SET recovery_sent_at = now() WHERE booking_uid = $1`, [booking.booking_uid]);
      } catch (err) {
        console.error("[noShowDetector] failed to send recovery email:", err);
      }
    }
    await notifyNoShow({
      eventTitle: booking.event_type_slug || "unknown event",
      attendeeName: booking.attendee_email || "unknown",
      startTime: booking.start_time,
    });
    noShows += 1;
  }

  const reviewRows = await query<TrackedBooking>(
    `SELECT booking_uid, event_type_slug, attendee_email, start_time, end_time
     FROM platform.bookings_tracked
     WHERE status = 'completed'
       AND review_requested_at IS NULL
       AND end_time < now() - ($1 || ' minutes')::interval`,
    [String(REVIEW_REQUEST_DELAY_MINUTES)]
  );

  let reviewsRequested = 0;
  for (const booking of reviewRows) {
    if (booking.attendee_email) {
      try {
        const reviewUrl = `${process.env.VCPEER_REVIEW_FORM_URL || "https://vcpeer.com/feedback"}?booking=${booking.booking_uid}`;
        await sendMail({
          to: booking.attendee_email,
          subject: "Quick feedback on your VCPeer call?",
          html: reviewRequestEmailHtml({
            attendeeName: booking.attendee_email.split("@")[0],
            eventTitle: booking.event_type_slug || "your call",
            reviewUrl,
          }),
        });
      } catch (err) {
        console.error("[noShowDetector] failed to send review-request email:", err);
      }
    }
    await query(`UPDATE platform.bookings_tracked SET review_requested_at = now() WHERE booking_uid = $1`, [booking.booking_uid]);
    reviewsRequested += 1;
  }

  return { noShows, reviewsRequested };
}

export function startNoShowDetectorJob(intervalMs = 5 * 60 * 1000): NodeJS.Timeout {
  return setInterval(() => {
    runNoShowDetectionPass()
      .then(({ noShows, reviewsRequested }) => {
        if (noShows || reviewsRequested) {
          console.log(`[noShowDetector] pass complete: ${noShows} no-shows, ${reviewsRequested} review requests sent`);
        }
      })
      .catch((err) => console.error("[noShowDetector] pass failed:", err));
  }, intervalMs);
}
