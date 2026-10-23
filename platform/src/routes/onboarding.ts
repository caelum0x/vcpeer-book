import { Router } from "express";
import path from "path";
import { query, queryOne, withTransaction } from "../db";
import {
  isUsernameTaken,
  createInviteTeam,
  createInviteToken,
  findNewUserIdForTeam,
  installJitsiCredentialForUser,
  createFirstEventType,
  getUsernameForUser,
  EVENT_TYPE_TEMPLATES,
} from "../lib/calcomSchema";
import { calcomSignupUrl, calcomPublicBookingUrl } from "../lib/calcom";
import { ah } from "../lib/asyncHandler";

// Self-serve signup wizard (item 1) — the single highest-leverage item per
// STRATEGY-2026-10-23.md section 5 move 1. Opens a real second-tenant path
// without flipping NEXT_PUBLIC_DISABLE_SIGNUP globally (which would also
// re-expose Cal.com's own bare /signup page) by using Cal.com's own
// team-invite bypass (see lib/calcomSchema.ts header comment) — the
// internal admin account (`subasiarhan3@gmail.com`, role ADMIN, not a
// member of this invite team) is completely untouched by this flow.

export const onboardingRouter = Router();

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;

onboardingRouter.get("/signup/plan", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "..", "public", "signup", "plan.html"));
});
onboardingRouter.get("/signup/workspace", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "..", "public", "signup", "workspace.html"));
});
onboardingRouter.get("/signup/pending", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "..", "public", "signup", "pending.html"));
});

onboardingRouter.post("/api/onboarding/start", ah(async (req, res) => {
  const { slug, email, plan, requestedEventType } = req.body || {};

  if (typeof slug !== "string" || !SLUG_RE.test(slug)) {
    res.status(400).json({ error: "slug must be 3-30 lowercase letters/numbers/hyphens, not starting or ending with a hyphen" });
    return;
  }
  if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json({ error: "a valid email is required" });
    return;
  }
  const normalizedPlan = plan === "pro" ? "pro" : "free";
  const template = EVENT_TYPE_TEMPLATES[requestedEventType] ? requestedEventType : "demo_30";

  const slugTaken = await queryOne(`SELECT id FROM platform.orgs WHERE slug = $1`, [slug]);
  if (slugTaken) {
    res.status(409).json({ error: `"${slug}" is already taken on VCPeer Book` });
    return;
  }
  if (await isUsernameTaken(slug)) {
    res.status(409).json({ error: `"${slug}" is already taken as a Cal.com username — pick another workspace slug` });
    return;
  }

  const orgRows = await query<{ id: number }>(
    `INSERT INTO platform.orgs (slug, email, plan, requested_event_type, status) VALUES ($1, $2, $3, $4, 'provisioning') RETURNING id`,
    [slug, email, normalizedPlan, template]
  );
  const orgId = orgRows[0].id;
  await query(`INSERT INTO platform.feature_flags (org_id) VALUES ($1)`, [orgId]);

  try {
    // Team + VerificationToken must land together — a partial write (team
    // created, token insert fails) orphans a Team row that then collides
    // with the next retry's identical slug (confirmed live, see
    // BUILD-LOG-2026-10-23.md: this was caught by this exact failure mode
    // during verification before the transaction existed).
    const { teamId, token } = await withTransaction(async (client) => {
      const teamId = await createInviteTeam({ name: slug, slug: `vcb-${slug}` }, client);
      const token = await createInviteToken({ email, teamId }, client);
      return { teamId, token };
    });
    await query(`UPDATE platform.orgs SET calcom_team_id = $2, invite_token = $3 WHERE id = $1`, [orgId, teamId, token]);

    res.status(201).json({
      data: {
        orgId,
        slug,
        signupUrl: calcomSignupUrl(token),
        statusUrl: `/api/onboarding/status/${slug}`,
      },
      error: null,
    });
  } catch (err: any) {
    await query(`UPDATE platform.orgs SET status = 'abandoned' WHERE id = $1`, [orgId]);
    console.error("[onboarding] provisioning failed:", err);
    res.status(502).json({ error: "Could not start provisioning — see server logs" });
  }
}));

onboardingRouter.get("/api/onboarding/status/:slug", ah(async (req, res) => {
  const org = await queryOne<{ id: number; status: string; calcom_user_id: number | null }>(
    `SELECT id, status, calcom_user_id FROM platform.orgs WHERE slug = $1`,
    [req.params.slug]
  );
  if (!org) {
    res.status(404).json({ error: "not found" });
    return;
  }
  let bookingUrl: string | null = null;
  if (org.status === "active" && org.calcom_user_id) {
    const username = await getUsernameForUser(org.calcom_user_id);
    const template = await queryOne<{ requested_event_type: string }>(`SELECT requested_event_type FROM platform.orgs WHERE id = $1`, [org.id]);
    const slug = template ? EVENT_TYPE_TEMPLATES[template.requested_event_type]?.slug : undefined;
    if (username && slug) bookingUrl = calcomPublicBookingUrl(username, slug);
  }
  res.json({ data: { status: org.status, bookingUrl }, error: null });
}));

interface ProvisioningOrg {
  id: number;
  slug: string;
  calcom_team_id: number;
  requested_event_type: string;
}

/**
 * Background reconciler: once an invited user actually finishes Cal.com's
 * own signup form (a real, user-driven step this service cannot skip —
 * they choose their own password on Cal.com's own page), this notices the
 * new Membership row, installs their own Jitsi Video credential, creates
 * their first event type from the template they picked in the wizard, and
 * flips the org to 'active'. Polling, not a webhook, because Cal.com emits
 * no "user signed up" webhook trigger (the webhook triggers list is
 * booking/meeting/recording/form-only — see routes/webhooks.ts's header).
 */
export async function runOnboardingReconcilerPass(): Promise<{ activated: number }> {
  const pending = await query<ProvisioningOrg>(
    `SELECT id, slug, calcom_team_id, requested_event_type FROM platform.orgs WHERE status = 'provisioning' AND calcom_team_id IS NOT NULL`
  );
  let activated = 0;
  for (const org of pending) {
    const userId = await findNewUserIdForTeam(org.calcom_team_id);
    if (!userId) continue;
    try {
      const credentialId = await installJitsiCredentialForUser(userId);
      const template = EVENT_TYPE_TEMPLATES[org.requested_event_type] || EVENT_TYPE_TEMPLATES.demo_30;
      await createFirstEventType({ userId, template, credentialId });
      await query(`UPDATE platform.orgs SET status = 'active', calcom_user_id = $2, activated_at = now() WHERE id = $1`, [org.id, userId]);
      activated += 1;
    } catch (err) {
      console.error(`[onboardingReconciler] failed to finish provisioning org ${org.slug}:`, err);
    }
  }
  return { activated };
}

export function startOnboardingReconcilerJob(intervalMs = 30 * 1000): NodeJS.Timeout {
  return setInterval(() => {
    runOnboardingReconcilerPass()
      .then(({ activated }) => {
        if (activated) console.log(`[onboardingReconciler] activated ${activated} new tenant(s)`);
      })
      .catch((err) => console.error("[onboardingReconciler] pass failed:", err));
  }, intervalMs);
}
