import DodoPayments from "dodopayments";
import { Webhook as StandardWebhook } from "standardwebhooks";

// Billing (item 3: paid tier). Zero-spend by design this pass — the Dodo
// business/products this needs (one "Custom domain + white-label" recurring
// product) do not exist yet in any Dodo dashboard, which is an owner-only
// step (per memory scribase-dodo-card-check-blocks-9-apps-2026-10-22 — Dodo
// project/product creation is a paid console action). This module is fully
// wired and correct against the real Dodo SDK/webhook contract; it simply
// returns a clear configuration error until DODO_PAYMENTS_API_KEY and
// DODO_PRODUCT_ID_CUSTOM_DOMAIN are filled in. No test keys are invented,
// no account is created by this code.
//
// Signature verification uses the `standardwebhooks` package directly
// rather than a `client.webhooks.unwrap()` SDK helper: the installed
// `dodopayments` SDK version (1.x, confirmed via `node_modules`) exposes
// `webhooks` only as webhook-endpoint CRUD, with no verification helper —
// `standardwebhooks` is Dodo's own documented fallback for exactly this
// case (see dodopayments:webhook-integration skill, "Alternative:
// standardwebhooks package").

const environment: "live_mode" | "test_mode" =
  process.env.DODO_PAYMENTS_ENVIRONMENT === "live_mode" ? "live_mode" : "test_mode";

let client: DodoPayments | null = null;

function getClient(): DodoPayments | null {
  if (!process.env.DODO_PAYMENTS_API_KEY) return null;
  if (!client) {
    client = new DodoPayments({
      bearerToken: process.env.DODO_PAYMENTS_API_KEY,
      environment,
    });
  }
  return client;
}

export function isDodoConfigured(): boolean {
  return Boolean(process.env.DODO_PAYMENTS_API_KEY && process.env.DODO_PRODUCT_ID_CUSTOM_DOMAIN);
}

export async function createCustomDomainCheckout(params: {
  orgSlug: string;
  email: string;
  returnUrl: string;
}): Promise<{ checkoutUrl: string }> {
  const c = getClient();
  const productId = process.env.DODO_PRODUCT_ID_CUSTOM_DOMAIN;
  if (!c || !productId) {
    throw new Error(
      "Dodo billing is not configured yet — owner step: create a 'VCPeer Book — Custom Domain' recurring " +
        "product in the Dodo dashboard, then set DODO_PAYMENTS_API_KEY + DODO_PRODUCT_ID_CUSTOM_DOMAIN."
    );
  }
  const session = await c.checkoutSessions.create({
    product_cart: [{ product_id: productId, quantity: 1 }],
    customer: { email: params.email, name: params.orgSlug },
    metadata: { org_slug: params.orgSlug },
    return_url: params.returnUrl,
  });
  if (!session.checkout_url) {
    throw new Error("Dodo did not return a checkout_url for this session");
  }
  return { checkoutUrl: session.checkout_url };
}

function getWebhookVerifier(): StandardWebhook | null {
  const secret = process.env.DODO_PAYMENTS_WEBHOOK_KEY;
  if (!secret) return null;
  return new StandardWebhook(secret);
}

export function unwrapWebhook(rawBody: string, headers: { [k: string]: string | undefined }): any {
  const verifier = getWebhookVerifier();
  if (!verifier) throw new Error("DODO_PAYMENTS_WEBHOOK_KEY is not configured");
  verifier.verify(rawBody, {
    "webhook-id": headers["webhook-id"] || "",
    "webhook-signature": headers["webhook-signature"] || "",
    "webhook-timestamp": headers["webhook-timestamp"] || "",
  });
  return JSON.parse(rawBody);
}
