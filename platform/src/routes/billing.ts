import { Router, raw } from "express";
import { query, queryOne } from "../db";
import { createCustomDomainCheckout, isDodoConfigured, unwrapWebhook } from "../lib/dodo";
import { ah } from "../lib/asyncHandler";

// Paid-tier billing (item 3): per-org feature-flag table + Dodo Payments
// checkout + webhook. Gated on orgs created by the onboarding flow (item 1).

export const billingRouter = Router();

// Separate router, mounted in server.ts BEFORE the global express.json()
// middleware — Dodo signature verification requires the exact raw bytes
// of the request body (see dodopayments:webhook-integration skill's "Raw
// Body Requirement"); if the global json() parser ran first on this path,
// it would already have consumed the stream and re-serialization would
// break the signature every time.
export const dodoWebhookRouter = Router();

interface OrgRow {
  id: number;
  slug: string;
  email: string;
  plan: string;
}

billingRouter.get("/api/billing/status/:slug", ah(async (req, res) => {
  const org = await queryOne<OrgRow>(`SELECT id, slug, email, plan FROM platform.orgs WHERE slug = $1`, [req.params.slug]);
  if (!org) {
    res.status(404).json({ error: "org not found" });
    return;
  }
  const flags = await queryOne(`SELECT * FROM platform.feature_flags WHERE org_id = $1`, [org.id]);
  res.json({ data: { org, featureFlags: flags }, error: null });
}));

billingRouter.post("/api/billing/checkout", ah(async (req, res) => {
  const { slug } = req.body || {};
  const org = await queryOne<OrgRow>(`SELECT id, slug, email, plan FROM platform.orgs WHERE slug = $1`, [slug]);
  if (!org) {
    res.status(404).json({ error: "org not found" });
    return;
  }
  if (!isDodoConfigured()) {
    res.status(503).json({
      error:
        "Billing is not live yet — owner step: create a 'VCPeer Book — Custom Domain' recurring product in the Dodo Payments dashboard, then set DODO_PAYMENTS_API_KEY and DODO_PRODUCT_ID_CUSTOM_DOMAIN.",
    });
    return;
  }
  try {
    const { checkoutUrl } = await createCustomDomainCheckout({
      orgSlug: org.slug,
      email: org.email,
      returnUrl: `${process.env.PLATFORM_BASE_URL || "https://book.vcpeer.com"}/settings/${org.slug}?checkout=complete`,
    });
    res.json({ data: { checkoutUrl }, error: null });
  } catch (err: any) {
    res.status(502).json({ error: err.message });
  }
}));

dodoWebhookRouter.post("/webhooks/dodo", raw({ type: "application/json" }), async (req, res) => {
  const rawBody = (req.body as Buffer).toString("utf8");
  let event: any;
  try {
    event = unwrapWebhook(rawBody, {
      "webhook-id": req.header("webhook-id"),
      "webhook-signature": req.header("webhook-signature"),
      "webhook-timestamp": req.header("webhook-timestamp"),
    });
  } catch (err: any) {
    await query(`INSERT INTO platform.webhook_log (source, trigger_event, payload, processed_ok, error) VALUES ('dodo', 'UNKNOWN', $1, false, $2)`, [
      JSON.stringify({ raw: rawBody }),
      String(err.message || err),
    ]);
    res.status(401).json({ error: "invalid signature" });
    return;
  }

  try {
    await handleDodoEvent(event);
    await query(`INSERT INTO platform.webhook_log (source, trigger_event, payload, processed_ok) VALUES ('dodo', $1, $2, true)`, [
      event.type,
      JSON.stringify(event),
    ]);
    res.json({ received: true });
  } catch (err: any) {
    await query(`INSERT INTO platform.webhook_log (source, trigger_event, payload, processed_ok, error) VALUES ('dodo', $1, $2, false, $3)`, [
      event.type,
      JSON.stringify(event),
      String(err.message || err),
    ]);
    res.status(500).json({ error: "processing failed, will be retried" });
  }
});

async function handleDodoEvent(event: any): Promise<void> {
  const orgSlug = event?.data?.metadata?.org_slug;
  if (!orgSlug) return; // not one of ours (shouldn't happen once only our products are on this endpoint)
  const org = await queryOne<OrgRow>(`SELECT id FROM platform.orgs WHERE slug = $1`, [orgSlug]);
  if (!org) return;

  if (event.type === "subscription.active" || event.type === "subscription.renewed") {
    await query(
      `INSERT INTO platform.feature_flags (org_id, custom_domain_enabled, white_label_enabled, dodo_customer_id, dodo_subscription_id, subscription_status, updated_at)
       VALUES ($1, true, true, $2, $3, 'active', now())
       ON CONFLICT (org_id) DO UPDATE SET custom_domain_enabled = true, white_label_enabled = true,
         dodo_customer_id = $2, dodo_subscription_id = $3, subscription_status = 'active', updated_at = now()`,
      [org.id, event.data?.customer?.customer_id || null, event.data?.subscription_id || null]
    );
  } else if (event.type === "subscription.cancelled" || event.type === "subscription.expired") {
    await query(
      `UPDATE platform.feature_flags SET custom_domain_enabled = false, white_label_enabled = false, subscription_status = 'cancelled', updated_at = now()
       WHERE org_id = $1`,
      [org.id]
    );
  } else if (event.type === "subscription.on_hold") {
    await query(`UPDATE platform.feature_flags SET subscription_status = 'past_due', updated_at = now() WHERE org_id = $1`, [org.id]);
  }
}

// Admin settings: custom domain + logo, gated on custom_domain_enabled.
billingRouter.post(
  "/api/settings/:slug",
  ah(async (req, res) => {
    const org = await queryOne<OrgRow>(`SELECT id FROM platform.orgs WHERE slug = $1`, [req.params.slug]);
    if (!org) {
      res.status(404).json({ error: "org not found" });
      return;
    }
    const flags = await queryOne<{ custom_domain_enabled: boolean }>(`SELECT custom_domain_enabled FROM platform.feature_flags WHERE org_id = $1`, [
      org.id,
    ]);
    if (!flags?.custom_domain_enabled) {
      res.status(403).json({ error: "Custom domain + white-label is a paid feature — upgrade via /api/billing/checkout first" });
      return;
    }
    const { logoUrl } = req.body || {};
    if (logoUrl) {
      await query(`UPDATE platform.feature_flags SET logo_url = $2, updated_at = now() WHERE org_id = $1`, [org.id, logoUrl]);
    }
    res.json({ data: { ok: true }, error: null });
  })
);
