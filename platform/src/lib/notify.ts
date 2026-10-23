import { request } from "undici";

// Real Slack/Discord incoming-webhook posting for item 6 (notification
// layer). Both are optional — if the env var isn't set, the call is a
// documented no-op (logged once) rather than a crash, since standing up a
// Slack/Discord webhook URL is an owner-only step (create the app/webhook
// in their own workspace) this pass cannot do on its own.
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || "";
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";

let warnedSlack = false;
let warnedDiscord = false;

export async function notifyNewBooking(params: {
  attendeeName: string;
  attendeeEmail: string;
  eventTitle: string;
  startTime: string;
  joinUrl?: string;
}): Promise<void> {
  const text = `New booking: *${params.eventTitle}* with ${params.attendeeName} (${params.attendeeEmail}) at ${params.startTime}${
    params.joinUrl ? `\n${params.joinUrl}` : ""
  }`;
  await Promise.all([postSlack(text), postDiscord(text)]);
}

export async function notifyCancellation(params: { eventTitle: string; attendeeName: string; startTime: string }): Promise<void> {
  const text = `Booking cancelled: *${params.eventTitle}* with ${params.attendeeName}, was scheduled for ${params.startTime}`;
  await Promise.all([postSlack(text), postDiscord(text)]);
}

export async function notifyNoShow(params: { eventTitle: string; attendeeName: string; startTime: string }): Promise<void> {
  const text = `No-show detected: *${params.eventTitle}* with ${params.attendeeName}, was scheduled for ${params.startTime} — recovery email sent`;
  await Promise.all([postSlack(text), postDiscord(text)]);
}

async function postSlack(text: string): Promise<void> {
  if (!SLACK_WEBHOOK_URL) {
    if (!warnedSlack) {
      console.warn("[notify] SLACK_WEBHOOK_URL not set — Slack notifications disabled (owner step: create an Incoming Webhook in a Slack workspace).");
      warnedSlack = true;
    }
    return;
  }
  try {
    await request(SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch (err) {
    console.error("[notify] Slack post failed:", err);
  }
}

async function postDiscord(text: string): Promise<void> {
  if (!DISCORD_WEBHOOK_URL) {
    if (!warnedDiscord) {
      console.warn("[notify] DISCORD_WEBHOOK_URL not set — Discord notifications disabled (owner step: create a channel webhook).");
      warnedDiscord = true;
    }
    return;
  }
  try {
    await request(DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: text }),
    });
  } catch (err) {
    console.error("[notify] Discord post failed:", err);
  }
}
