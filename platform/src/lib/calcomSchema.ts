import crypto from "crypto";
import { PoolClient } from "pg";
import { query, queryOne, pool } from "../db";

// Either the shared pool or a single checked-out transaction client — both
// expose the same `.query()` shape, so createInviteTeam/createInviteToken
// below can run on one transaction (see onboarding.ts's use of
// `withTransaction`) without duplicating their SQL.
type Queryable = Pick<PoolClient, "query">;

async function run<T>(db: Queryable, text: string, params: any[]): Promise<T[]> {
  const result = await db.query(text, params);
  return result.rows as T[];
}

// Direct-SQL helpers against Cal.com's OWN Prisma-managed tables (the
// `public` schema in the same Postgres database this service's `platform`
// schema lives in). This is the exact same trust level and pattern already
// established and running in production by this repo's
// `deploy/apply-vcpeer-branding.sql` — direct, idempotent SQL against
// Cal.com's schema, zero source forked or edited. Every statement here was
// verified against a real local Cal.com v6.2.0-arm instance before being
// used against any non-local database (see BUILD-LOG-2026-10-23.md for the
// verification transcript) — getting this schema wrong on a live tenant
// instance is a correctness risk this file takes seriously.
//
// Why direct SQL instead of calling Cal.com's own tRPC/REST endpoints for
// team/invite creation: Cal.com's "invite a team member" flow is itself
// gated behind an authenticated session (you must already be logged in as
// a team admin to call it), which doesn't exist yet for a brand-new
// self-serve signup with no prior account — there is no public, unauthenticated
// Cal.com endpoint to "create a team + invite token" the way there is for
// `/api/auth/signup` itself (see lib/calcom.ts's header comment on why that
// one IS called over HTTP, not via SQL).

export async function isUsernameTaken(username: string): Promise<boolean> {
  const row = await queryOne<{ id: number }>(`SELECT id FROM users WHERE username = $1 LIMIT 1`, [username]);
  return Boolean(row);
}

/**
 * Creates a plain (non-organization, no parent) Cal.com Team purely as a
 * container for a team-invite `VerificationToken` — this is what lets
 * `POST /api/auth/signup` succeed for a brand-new tenant even while
 * `NEXT_PUBLIC_DISABLE_SIGNUP=true` globally (see
 * `apps/web/app/api/auth/signup/route.ts`'s `ensureSignupIsEnabled`: "Still
 * allow signups if there is a team invite"). Each signed-up user's own
 * data (EventType/Booking/Schedule, all foreign-keyed by userId, not
 * teamId) is isolated by Cal.com's own per-user model regardless of this
 * team structure — the team itself is not a multi-user workspace in this
 * flow, just the invite container item 1 needs.
 */
export async function createInviteTeam(params: { name: string; slug: string }, db: Queryable = pool): Promise<number> {
  const rows = await run<{ id: number }>(
    db,
    `INSERT INTO "Team" (name, slug, "isOrganization", "hideBranding", "brandColor", "darkBrandColor")
     VALUES ($1, $2, false, true, '#4678F9', '#4678F9')
     RETURNING id`,
    [params.name, params.slug]
  );
  return rows[0].id;
}

export async function createInviteToken(
  params: { email: string; teamId: number; expiresInHours?: number },
  db: Queryable = pool
): Promise<string> {
  const token = crypto.randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + (params.expiresInHours ?? 72) * 60 * 60 * 1000);
  // `updatedAt` has Prisma's `@updatedAt` directive, which Prisma's own
  // client sets on every write — it is NOT a database-level DEFAULT, so a
  // raw SQL insert (bypassing Prisma entirely, same as this whole module)
  // must set it explicitly or Postgres rejects the NOT NULL constraint.
  // Caught live against a real local Cal.com instance during this round's
  // verification — see BUILD-LOG-2026-10-23.md.
  await run(
    db,
    `INSERT INTO "VerificationToken" (identifier, token, expires, "teamId", "updatedAt")
     VALUES ($1, $2, $3, $4, now())`,
    [params.email, token, expires, params.teamId]
  );
  return token;
}

/** True once the invited user has actually completed Cal.com's own signup form and joined the team. */
export async function findNewUserIdForTeam(teamId: number): Promise<number | null> {
  const row = await queryOne<{ userId: number }>(`SELECT "userId" FROM "Membership" WHERE "teamId" = $1 ORDER BY id ASC LIMIT 1`, [teamId]);
  return row?.userId ?? null;
}

export async function getUsernameForUser(userId: number): Promise<string | null> {
  const row = await queryOne<{ username: string | null }>(`SELECT username FROM users WHERE id = $1`, [userId]);
  return row?.username ?? null;
}

/** Mirrors deploy/apply-vcpeer-branding.sql's Jitsi credential seed, but for a newly-provisioned tenant user instead of the single admin. */
export async function installJitsiCredentialForUser(userId: number): Promise<number> {
  const existing = await queryOne<{ id: number }>(`SELECT id FROM "Credential" WHERE "userId" = $1 AND "appId" = 'jitsi'`, [userId]);
  if (existing) return existing.id;
  const rows = await query<{ id: number }>(
    `INSERT INTO "Credential" (type, key, "userId", "appId") VALUES ('jitsi_video', '{}'::jsonb, $1, 'jitsi') RETURNING id`,
    [userId]
  );
  return rows[0].id;
}

export interface EventTypeTemplate {
  slug: string;
  title: string;
  description: string;
  length: number;
}

export const EVENT_TYPE_TEMPLATES: Record<string, EventTypeTemplate> = {
  demo_30: {
    slug: "demo",
    title: "30-Minute Demo Call",
    description: "A live walkthrough of what we offer. Joins a private VCPeer video room, no account needed.",
    length: 30,
  },
  support_15: {
    slug: "support",
    title: "15-Minute Support Call",
    description: "Quick help, fast. Joins a private VCPeer video room, no account needed.",
    length: 15,
  },
  consultation_45: {
    slug: "consultation",
    title: "45-Minute Consultation",
    description: "An in-depth consultation call. Joins a private VCPeer video room, no account needed.",
    length: 45,
  },
};

/** Creates the tenant's first event type, located at their own Jitsi Video credential (their own unique vcpeer.com/join/<uuid> room per booking, same mechanism as the admin's). */
export async function createFirstEventType(params: { userId: number; template: EventTypeTemplate; credentialId: number }): Promise<number> {
  const existing = await queryOne<{ id: number }>(`SELECT id FROM "EventType" WHERE "userId" = $1 AND slug = $2`, [params.userId, params.template.slug]);
  if (existing) return existing.id;
  const rows = await query<{ id: number }>(
    `INSERT INTO "EventType" ("userId", title, slug, description, length, locations)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     RETURNING id`,
    [
      params.userId,
      params.template.title,
      params.template.slug,
      params.template.description,
      params.template.length,
      JSON.stringify([{ type: "integrations:jitsi", credentialId: params.credentialId }]),
    ]
  );
  const eventTypeId = rows[0].id;
  // CRITICAL: Cal.com's public booking-page lookup (getPublicEvent.ts)
  // does NOT query the EventType.userId scalar column at all — it queries
  // the implicit `_user_eventtype` many-to-many join table (Prisma's
  // `EventType.users <-> User` relation). Without this row, the event type
  // exists in the DB and the admin API can see it, but
  // `https://book.vcpeer.com/<username>/<slug>` 404s for every real
  // visitor. Caught live against a real local Cal.com instance during this
  // round's verification (the booking page 404'd despite the EventType
  // row existing with a correct userId) — see BUILD-LOG-2026-10-23.md.
  await query(`INSERT INTO "_user_eventtype" ("A", "B") VALUES ($1, $2) ON CONFLICT DO NOTHING`, [eventTypeId, params.userId]);
  return eventTypeId;
}
