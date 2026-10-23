import "dotenv/config";
import express from "express";
import path from "path";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { runMigrations } from "./db";
import { analyticsRouter } from "./routes/analytics";
import { calcomWebhooksRouter } from "./routes/webhooks";
import { publicApiRouter } from "./routes/publicApi";
import { widgetRouter } from "./routes/widget";
import { billingRouter, dodoWebhookRouter } from "./routes/billing";
import { domainsRouter, startDomainPollerJob } from "./routes/domains";
import { onboardingRouter, startOnboardingReconcilerJob } from "./routes/onboarding";
import { adminKeysRouter } from "./routes/adminKeys";
import { startNoShowDetectorJob } from "./jobs/noShowDetector";

const app = express();
const PORT = Number(process.env.PLATFORM_PORT || 4100);

// Global rate limit as a backstop in front of the per-API-key limiter in
// lib/apiAuth.ts — protects unauthenticated endpoints (track beacon,
// onboarding, webhooks) from being hammered.
app.use(
  rateLimit({
    windowMs: 60_000,
    limit: 300,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// Dodo's webhook route needs the raw, unparsed request body for signature
// verification — it MUST be mounted before the global express.json()
// below, otherwise json() would already have consumed and re-serialized
// the stream by the time dodoWebhookRouter's own express.raw() middleware
// runs, breaking every signature check. See routes/billing.ts's header.
app.use(dodoWebhookRouter);

// Capture the raw body for Cal.com webhook signature verification
// (routes/webhooks.ts) via a tee — that route's content-type is JSON, so
// it shares this app-level json() middleware with everything else rather
// than needing its own express.raw() mount like the Dodo route above.
app.use(
  express.json({
    verify: (req, _res, buf) => {
      (req as any).rawBody = buf.toString("utf8");
    },
  })
);

// The public REST API (item 9) and embeddable widget (item 8) are, by
// design, called cross-origin — the whole point of the widget is to run
// embedded on vcpeer.com's active-call/post-call screens while this API
// lives on book.vcpeer.com. API-key auth (lib/apiAuth.ts) is the real
// access control; CORS here only decides which browsers are even allowed
// to attempt the request, so an open policy on these specific paths is
// the correct one, same model as any public, key-authenticated API
// (Stripe, GitHub, etc. all allow CORS from any origin on their APIs).
app.use(["/v1", "/api/track", "/widget.js", "/widget.css"], cors());

app.use(analyticsRouter);
app.use(calcomWebhooksRouter);
app.use(publicApiRouter);
app.use(widgetRouter);
app.use(billingRouter);
app.use(domainsRouter);
app.use(onboardingRouter);
app.use(adminKeysRouter);

// Static marketing site at the root — Caddy routes book.vcpeer.com's root
// path and a handful of others (/pricing, /signup/*, /dashboard,
// /widget.js, /api/*, /webhooks/*) to this service; everything else
// (/admin/*, /auth/*, /<username>/<slug>, /booking/*) keeps going straight
// to the calcom container. See deploy/platform.caddy.
app.get("/pricing", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "landing", "pricing.html"));
});
app.use(express.static(path.join(__dirname, "..", "public", "landing")));
app.use("/dashboard", express.static(path.join(__dirname, "..", "public", "dashboard")));

app.get("/healthz", (_req, res) => res.json({ ok: true }));

// Final safety net — every route handler above is wrapped with lib/
// asyncHandler.ts's `ah()`, which forwards rejected promises here instead
// of letting them become an unhandled rejection that kills the whole
// process (confirmed during this service's own verification pass: before
// this existed, one query against a not-yet-migrated table took the
// entire service down). Always returns JSON, never leaks the raw error to
// the client.
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[vcpeer-book-platform] unhandled route error:", err);
  if (!res.headersSent) {
    res.status(500).json({ error: "internal error" });
  }
});

async function main() {
  await runMigrations();
  app.listen(PORT, () => {
    console.log(`[vcpeer-book-platform] listening on :${PORT}`);
  });
  startNoShowDetectorJob();
  startOnboardingReconcilerJob();
  startDomainPollerJob();
}

main().catch((err) => {
  console.error("[vcpeer-book-platform] fatal startup error:", err);
  process.exit(1);
});
