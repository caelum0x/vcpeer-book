import { Router } from "express";
import { requireApiKey } from "../lib/apiAuth";
import { getSlots, createBooking, getEventTypeId } from "../lib/calcom";
import { query } from "../db";
import { ah } from "../lib/asyncHandler";

// Public REST API layer (item 9) — a thin, VCPeer-branded API in front of
// Cal.com's own API so other VCPeer products (vcpeer.com, Menivor, etc.)
// can create bookings programmatically instead of only via the hosted web
// UI. API-key auth (lib/apiAuth.ts) + per-key rate limiting, real handler
// logic against the live Cal.com instance (lib/calcom.ts), not a stub.

export const publicApiRouter = Router();

publicApiRouter.get("/v1/slots", requireApiKey(), async (req, res) => {
  const { username, eventTypeSlug, startTime, endTime, timeZone } = req.query as Record<string, string>;
  if (!username || !eventTypeSlug || !startTime || !endTime) {
    res.status(400).json({ error: "username, eventTypeSlug, startTime, endTime are required query params" });
    return;
  }
  try {
    const slots = await getSlots({ username, eventTypeSlug, startTime, endTime, timeZone });
    res.json({ data: { username, eventTypeSlug, slots }, error: null });
  } catch (err: any) {
    res.status(502).json({ data: null, error: `Cal.com slots lookup failed: ${err.message}` });
  }
});

publicApiRouter.post("/v1/bookings", requireApiKey(), async (req, res) => {
  const { eventTypeId, username, eventTypeSlug, start, name, email, notes, timeZone } = req.body || {};
  if ((!eventTypeId && !(username && eventTypeSlug)) || !start || !name || !email) {
    res.status(400).json({ error: "start, name, email are required, plus either eventTypeId or {username, eventTypeSlug}" });
    return;
  }
  try {
    const resolvedEventTypeId = eventTypeId ? Number(eventTypeId) : await getEventTypeId(username, eventTypeSlug);
    const booking = await createBooking({
      eventTypeId: resolvedEventTypeId,
      start,
      responses: { name, email, notes },
      timeZone,
    });
    res.status(201).json({ data: booking, error: null });
  } catch (err: any) {
    res.status(502).json({ data: null, error: `Cal.com booking creation failed: ${err.message}` });
  }
});

// Lets a key owner see their own usage without a DB console — real data,
// scoped to the authenticated key only.
publicApiRouter.get(
  "/v1/usage",
  requireApiKey(),
  ah(async (req, res) => {
    const apiKey = (req as any).apiKey;
    const row = await query<{ last_used_at: string | null; rate_limit_per_min: number }>(
      `SELECT last_used_at, rate_limit_per_min FROM platform.api_keys WHERE id = $1`,
      [apiKey.id]
    );
    res.json({ data: row[0] || null, error: null });
  })
);
