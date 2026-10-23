import { Router } from "express";
import crypto from "crypto";
import { query } from "../db";
import { generateApiKey } from "../lib/apiAuth";
import { ah } from "../lib/asyncHandler";

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Minimal admin-only endpoint to mint API keys for the public REST API
// (item 9) and the embeddable widget (item 8). Protected by a shared
// secret (ADMIN_API_SECRET) rather than a full admin auth system — this
// platform service has no login UI of its own yet; it defers to Cal.com's
// own admin account for everything else. Good enough for a single
// operator minting a handful of keys; revisit if/when this grows a real
// admin panel.

export const adminKeysRouter = Router();

adminKeysRouter.post("/api/admin/api-keys", ah(async (req, res) => {
  const secret = req.header("x-admin-secret") || "";
  if (!process.env.ADMIN_API_SECRET || !safeEqual(secret, process.env.ADMIN_API_SECRET)) {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  const { label, scope, orgId, rateLimitPerMin } = req.body || {};
  const resolvedScope = scope === "widget" ? "widget" : "full";
  const { rawKey, hash } = generateApiKey(resolvedScope === "widget" ? "vcbw" : "vcb");
  await query(
    `INSERT INTO platform.api_keys (key_hash, label, scope, org_id, rate_limit_per_min) VALUES ($1, $2, $3, $4, $5)`,
    [hash, label || "unnamed key", resolvedScope, orgId || null, rateLimitPerMin || 60]
  );
  // The raw key is returned exactly once — only its SHA-256 hash is stored,
  // matching the pattern every real API-key system uses (Stripe, GitHub,
  // etc.) so a database read alone can never leak a usable credential.
  res.status(201).json({ data: { apiKey: rawKey, scope: resolvedScope }, error: null });
}));
