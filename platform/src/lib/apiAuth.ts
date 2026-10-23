import crypto from "crypto";
import { Request, Response, NextFunction } from "express";
import { queryOne, query } from "../db";

// API-key auth + per-key rate limiting for the public REST API layer
// (item 9) and the embeddable widget (item 8, which uses a restricted
// "widget" scope key meant to be safe to expose in client-side JS).

export interface ApiKeyRecord {
  id: number;
  label: string;
  scope: "full" | "widget";
  org_id: number | null;
  rate_limit_per_min: number;
}

function hashKey(rawKey: string): string {
  return crypto.createHash("sha256").update(rawKey).digest("hex");
}

export function generateApiKey(prefix: "vcb" | "vcbw" = "vcb"): { rawKey: string; hash: string } {
  const rawKey = `${prefix}_${crypto.randomBytes(24).toString("hex")}`;
  return { rawKey, hash: hashKey(rawKey) };
}

// In-memory sliding-window counters, keyed by api key id. Good enough for a
// single-instance deployment (this service runs as one container on `box`,
// same scale as the rest of this portfolio's Node services); swap for a
// Redis-backed limiter if this is ever horizontally scaled.
const windows = new Map<number, { count: number; resetAt: number }>();

function checkRateLimit(keyId: number, limitPerMin: number): boolean {
  const now = Date.now();
  const w = windows.get(keyId);
  if (!w || now > w.resetAt) {
    windows.set(keyId, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  if (w.count >= limitPerMin) return false;
  w.count += 1;
  return true;
}

// Returns a plain (non-async) Express middleware that delegates to the real
// async check below and forwards any rejection to `next(err)` — an async
// function used directly as Express middleware would otherwise produce an
// unhandled rejection that crashes the whole process on any DB error (see
// lib/asyncHandler.ts's header comment for how this was actually caught).
export function requireApiKey(requiredScope?: "full") {
  return (req: Request, res: Response, next: NextFunction) => {
    handleAuth(req, res, next, requiredScope).catch(next);
  };
}

async function handleAuth(req: Request, res: Response, next: NextFunction, requiredScope?: "full"): Promise<void> {
  const header = req.header("authorization") || "";
  const rawKey = header.startsWith("Bearer ") ? header.slice(7) : req.query.api_key?.toString();
  if (!rawKey) {
    res.status(401).json({ error: "Missing API key (Authorization: Bearer <key>)" });
    return;
  }
  const record = await queryOne<ApiKeyRecord>(
    `SELECT id, label, scope, org_id, rate_limit_per_min FROM platform.api_keys
     WHERE key_hash = $1 AND revoked = false`,
    [hashKey(rawKey)]
  );
  if (!record) {
    res.status(401).json({ error: "Invalid or revoked API key" });
    return;
  }
  if (requiredScope === "full" && record.scope !== "full") {
    res.status(403).json({ error: "This API key does not have the required scope" });
    return;
  }
  if (!checkRateLimit(record.id, record.rate_limit_per_min)) {
    res.status(429).json({ error: "Rate limit exceeded for this API key" });
    return;
  }
  await query(`UPDATE platform.api_keys SET last_used_at = now() WHERE id = $1`, [record.id]);
  (req as any).apiKey = record;
  next();
}
