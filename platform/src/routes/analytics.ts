import { Router } from "express";
import { query } from "../db";
import { ah } from "../lib/asyncHandler";

// Booking-funnel analytics (item 5). Cal.com community edition ships zero
// funnel analytics — this is new product surface, not a Cal.com setting.
// Funnel stages: page_view -> slot_selected -> booking_confirmed -> call_joined.

export const analyticsRouter = Router();

const VALID_EVENT_TYPES = new Set(["page_view", "slot_selected", "booking_confirmed", "booking_cancelled", "call_joined"]);

/**
 * Beacon endpoint — called from a small JS snippet on the public booking
 * page (see public/assets/beacon.js) and from the embeddable widget
 * (item 8). Cal.com's community edition has no plugin/script-injection
 * point in its booking page without forking the source, so wiring the
 * beacon onto the live /<username>/<slug> page itself is tracked as a
 * follow-up in NOTES.md — this endpoint and the booking_confirmed/
 * booking_cancelled ingestion via the Cal.com webhook (routes/webhooks.ts)
 * are real and already capture the funnel's two most important stages
 * without needing it.
 */
analyticsRouter.post("/api/track", ah(async (req, res) => {
  const { eventType, eventTypeSlug, tenantSlug, sessionId, bookingUid, metadata } = req.body || {};
  if (typeof eventType !== "string" || !VALID_EVENT_TYPES.has(eventType)) {
    res.status(400).json({ error: `eventType must be one of ${[...VALID_EVENT_TYPES].join(", ")}` });
    return;
  }
  await query(
    `INSERT INTO platform.analytics_events (event_type, event_type_slug, tenant_slug, session_id, booking_uid, metadata)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [eventType, eventTypeSlug || null, tenantSlug || null, sessionId || null, bookingUid || null, JSON.stringify(metadata || {})]
  );
  res.status(204).end();
}));

interface FunnelRow {
  event_type_slug: string | null;
  tenant_slug: string | null;
  event_type: string;
  count: string;
}

analyticsRouter.get("/api/analytics/summary", ah(async (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
  const rows = await query<FunnelRow>(
    `SELECT event_type_slug, tenant_slug, event_type, count(*)::text AS count
     FROM platform.analytics_events
     WHERE created_at > now() - ($1 || ' days')::interval
     GROUP BY event_type_slug, tenant_slug, event_type`,
    [String(days)]
  );

  // Pivot into one funnel per (tenant_slug, event_type_slug) pair.
  const funnels = new Map<string, { tenantSlug: string | null; eventTypeSlug: string | null; counts: Record<string, number> }>();
  for (const row of rows) {
    const key = `${row.tenant_slug ?? ""}::${row.event_type_slug ?? ""}`;
    if (!funnels.has(key)) {
      funnels.set(key, { tenantSlug: row.tenant_slug, eventTypeSlug: row.event_type_slug, counts: {} });
    }
    funnels.get(key)!.counts[row.event_type] = Number(row.count);
  }

  const result = [...funnels.values()].map((f) => {
    const views = f.counts.page_view || 0;
    const selected = f.counts.slot_selected || 0;
    const confirmed = f.counts.booking_confirmed || 0;
    const joined = f.counts.call_joined || 0;
    const cancelled = f.counts.booking_cancelled || 0;
    return {
      tenantSlug: f.tenantSlug,
      eventTypeSlug: f.eventTypeSlug,
      pageViews: views,
      slotsSelected: selected,
      bookingsConfirmed: confirmed,
      bookingsCancelled: cancelled,
      callsJoined: joined,
      viewToSelectRate: rate(selected, views),
      selectToConfirmRate: rate(confirmed, selected),
      confirmToJoinRate: rate(joined, confirmed),
      overallConversionRate: rate(confirmed, views),
    };
  });

  res.json({ days, funnels: result });
}));

function rate(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 1000) / 10; // one decimal place, percent
}
