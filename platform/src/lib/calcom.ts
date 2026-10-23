import { request } from "undici";

// Thin HTTP client against the self-hosted Cal.com instance this platform
// service sits in front of. Talks only to Cal.com's own public HTTP
// surface (REST + the signup form endpoint) — no Prisma client, no source
// import from the calcom/cal.diy codebase. This is deliberately a plain
// fetch wrapper, not the @calcom/api-client SDK, so this service has zero
// build-time dependency on Cal.com's monorepo.

const CALCOM_BASE_URL = process.env.CALCOM_BASE_URL || "http://calcom:3000";
const CALCOM_API_KEY = process.env.CALCOM_API_KEY || ""; // cal.com v1 API key (Settings -> Developer -> API keys)

export interface CalcomSlot {
  time: string;
}

export class CalcomApiError extends Error {
  constructor(message: string, public status: number, public body: unknown) {
    super(message);
  }
}

async function calcomFetch(path: string, init: { method?: string; body?: unknown; query?: Record<string, string> } = {}) {
  const url = new URL(path, CALCOM_BASE_URL);
  if (init.query) {
    for (const [k, v] of Object.entries(init.query)) url.searchParams.set(k, v);
  }
  if (CALCOM_API_KEY && !path.startsWith("/api/auth/")) {
    url.searchParams.set("apiKey", CALCOM_API_KEY);
  }
  let res;
  try {
    res = await request(url, {
      method: (init.method as any) || "GET",
      headers: { "content-type": "application/json" },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
  } catch (err: any) {
    throw new CalcomApiError(`Cal.com request failed: ${init.method || "GET"} ${path} -> ${err.code || err.message || "network error"}`, 0, null);
  }
  const text = await res.body.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    // non-JSON response (e.g. an HTML error page) — keep raw text for debugging
  }
  if (res.statusCode >= 400) {
    throw new CalcomApiError(`Cal.com request failed: ${init.method || "GET"} ${path} -> ${res.statusCode}`, res.statusCode, parsed);
  }
  return parsed;
}

/**
 * Fetches available slots for a public event type, using Cal.com's own
 * public v1 "slots" endpoint (no API key required — same endpoint the
 * booking page's own calendar widget calls). Used by:
 *  - the public REST API layer (item 9)
 *  - the embeddable widget (item 8)
 */
export async function getSlots(params: {
  username: string;
  eventTypeSlug: string;
  startTime: string; // ISO date, inclusive
  endTime: string; // ISO date, exclusive
  timeZone?: string;
}): Promise<Record<string, CalcomSlot[]>> {
  const result: any = await calcomFetch("/api/trpc/slots/getSchedule", {
    query: {
      input: JSON.stringify({
        json: {
          usernameList: [params.username],
          eventTypeSlug: params.eventTypeSlug,
          startTime: params.startTime,
          endTime: params.endTime,
          timeZone: params.timeZone || "UTC",
          duration: undefined,
        },
      }),
    },
  });
  // tRPC batch response shape: { result: { data: { json: { slots: {...} } } } }
  const slots = result?.result?.data?.json?.slots ?? result?.result?.data?.slots ?? {};
  return slots;
}

/**
 * Creates a booking via Cal.com's own public v1 booking endpoint. Used by
 * the public REST API layer (item 9) and the embeddable widget (item 8) so
 * a caller never needs direct Cal.com credentials of its own.
 */
export async function createBooking(params: {
  eventTypeId: number;
  start: string; // ISO
  responses: { name: string; email: string; notes?: string };
  timeZone?: string;
  language?: string;
}): Promise<any> {
  return calcomFetch("/api/book/event", {
    method: "POST",
    body: {
      eventTypeId: params.eventTypeId,
      start: params.start,
      responses: params.responses,
      timeZone: params.timeZone || "UTC",
      language: params.language || "en",
      metadata: {},
    },
  });
}

/**
 * Self-hosted signup, mirroring exactly what Cal.com's own
 * `apps/web/app/(use-page-wrapper)/signup/page.tsx` form posts to
 * (`POST /api/auth/signup`, body `{ username, email, password, token }`).
 * `ensureSignupIsEnabled` in that route still allows the request through
 * when a valid team-invite `token` is present even while
 * NEXT_PUBLIC_DISABLE_SIGNUP=true globally — this is how the onboarding
 * wizard (item 1) opens a self-serve path without flipping that flag for
 * the whole instance (which would also re-expose Cal.com's own bare
 * /signup page to the internal admin's install).
 */
export async function completeSignup(params: {
  username: string;
  email: string;
  password: string;
  token: string;
}): Promise<any> {
  return calcomFetch("/api/auth/signup", {
    method: "POST",
    body: params,
  });
}

/**
 * Resolves a public event type's numeric id from its username+slug, via
 * Cal.com's own `publicViewer.event` tRPC query (the same one the public
 * booking page itself calls to render). Lets the public API (item 9) and
 * the embeddable widget (item 8) accept the human-friendly
 * {username, eventTypeSlug} pair instead of requiring a caller to already
 * know Cal.com's internal numeric EventType id.
 */
export async function getEventTypeId(username: string, eventSlug: string): Promise<number> {
  const result: any = await calcomFetch("/api/trpc/public/event", {
    query: {
      input: JSON.stringify({ json: { username, eventSlug, org: null } }),
    },
  });
  const id = result?.result?.data?.json?.id ?? result?.result?.data?.id;
  if (!id) throw new Error(`Could not resolve event type id for ${username}/${eventSlug}`);
  return Number(id);
}

export function calcomPublicBookingUrl(username: string, slug: string): string {
  const webAppUrl = process.env.NEXT_PUBLIC_WEBAPP_URL || "https://book.vcpeer.com";
  return `${webAppUrl}/${username}/${slug}`;
}

export function calcomSignupUrl(token: string): string {
  const webAppUrl = process.env.NEXT_PUBLIC_WEBAPP_URL || "https://book.vcpeer.com";
  return `${webAppUrl}/signup?token=${encodeURIComponent(token)}`;
}
