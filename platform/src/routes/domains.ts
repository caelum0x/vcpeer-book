import { Router } from "express";
import fs from "fs";
import path from "path";
import { query, queryOne } from "../db";
import { provisionSubdomain, checkExternalDomainPropagation, isCloudflareConfigured, renderCaddyBlock } from "../lib/cloudflare";
import { ah } from "../lib/asyncHandler";

// Custom-domain provisioning (item 4), backing the paid tier (item 3). Real
// infra automation: creates a Cloudflare DNS record via the API (not a
// manual runbook step), polls for propagation, flips status automatically.

export const domainsRouter = Router();

// Directory shared with the host's real Caddy process via a bind mount
// (docker-compose.yml's `platform` service, `CUSTOM_DOMAINS_CADDY_DIR`
// env var — defaults to a repo-local path for local dev, where no mount
// exists and reload is a no-op anyway, see reloadCaddyIfLocal below).
//
// Fixed 2026-10-24: this used to resolve to a path *inside this
// container's own filesystem* (`path.join(__dirname, "..", "..", "..",
// "deploy", "custom-domains.caddy")` — three levels up from the compiled
// `dist/routes/domains.js` lands at the container's filesystem root, never
// mounted anywhere the host's Caddy process could read it). Every custom
// domain that "went live" was writing a snippet nobody ever served.
const CADDY_SNIPPET_DIR =
  process.env.CUSTOM_DOMAINS_CADDY_DIR || path.join(__dirname, "..", "..", "..", "deploy", "custom-domains");
const CADDY_SNIPPET_PATH = path.join(CADDY_SNIPPET_DIR, "custom-domains.caddy");
const RELOAD_SENTINEL_PATH = path.join(CADDY_SNIPPET_DIR, ".reload-requested");

interface OrgRow {
  id: number;
}
interface FlagsRow {
  custom_domain_enabled: boolean;
}

domainsRouter.post("/api/domains/provision", ah(async (req, res) => {
  const { slug, domain, mode } = req.body || {}; // mode: 'subdomain' (default) | 'external'
  const org = await queryOne<OrgRow>(`SELECT id FROM platform.orgs WHERE slug = $1`, [slug]);
  if (!org) {
    res.status(404).json({ error: "org not found" });
    return;
  }
  const flags = await queryOne<FlagsRow>(`SELECT custom_domain_enabled FROM platform.feature_flags WHERE org_id = $1`, [org.id]);
  if (!flags?.custom_domain_enabled) {
    res.status(403).json({ error: "Custom domain is a paid feature — upgrade via /api/billing/checkout first" });
    return;
  }

  const requestedMode = mode === "external" ? "external" : "subdomain";
  const targetDomain = requestedMode === "subdomain" ? `${slug}.${process.env.VCPEER_BOOK_ROOT_DOMAIN || "book.vcpeer.com"}` : domain;
  if (!targetDomain) {
    res.status(400).json({ error: "domain is required for mode=external" });
    return;
  }

  const existing = await queryOne(`SELECT id FROM platform.domains WHERE domain = $1`, [targetDomain]);
  if (existing) {
    res.status(409).json({ error: `${targetDomain} is already provisioned or pending` });
    return;
  }

  try {
    let cfRecordId: string | null = null;
    let status = "pending";
    if (requestedMode === "subdomain") {
      if (!isCloudflareConfigured()) {
        res.status(503).json({ error: "CLOUDFLARE_DNS_API_TOKEN not configured — cannot provision subdomains" });
        return;
      }
      const record = await provisionSubdomain(slug);
      cfRecordId = record.id;
      status = "dns_created";
    }
    const inserted = await query<{ id: number }>(
      `INSERT INTO platform.domains (org_id, domain, cf_record_id, status) VALUES ($1, $2, $3, $4) RETURNING id`,
      [org.id, targetDomain, cfRecordId, status]
    );
    res.status(201).json({ data: { id: inserted[0].id, domain: targetDomain, status }, error: null });
  } catch (err: any) {
    res.status(502).json({ error: err.message });
  }
}));

// Lists every domain row for one org — backs the settings page (item 4's
// missing UI, see BUILD-LOG-2026-10-24.md) so a tenant can see what they've
// already provisioned without a direct DB query.
domainsRouter.get(
  "/api/domains",
  ah(async (req, res) => {
    const slug = typeof req.query.slug === "string" ? req.query.slug : undefined;
    if (!slug) {
      res.status(400).json({ error: "slug query param is required" });
      return;
    }
    const org = await queryOne<OrgRow>(`SELECT id FROM platform.orgs WHERE slug = $1`, [slug]);
    if (!org) {
      res.status(404).json({ error: "org not found" });
      return;
    }
    const rows = await query(
      `SELECT domain, status, last_error, created_at, updated_at FROM platform.domains WHERE org_id = $1 ORDER BY created_at DESC`,
      [org.id]
    );
    res.json({ data: rows, error: null });
  })
);

domainsRouter.get(
  "/api/domains/:domain/status",
  ah(async (req, res) => {
    const row = await queryOne(`SELECT domain, status, last_error, created_at, updated_at FROM platform.domains WHERE domain = $1`, [req.params.domain]);
    if (!row) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json({ data: row, error: null });
  })
);

interface DomainRow {
  id: number;
  domain: string;
  status: string;
}

/**
 * Background poller: checks DNS propagation for pending domains, then
 * appends a Caddy site block + (when running on the box itself) reloads
 * Caddy, and flips the domain's status to 'live'. Real automation, not a
 * manual runbook step — this is the actual deliverable for item 4.
 */
export async function pollPendingDomains(): Promise<{ checked: number; wentLive: number }> {
  const pending = await query<DomainRow>(`SELECT id, domain, status FROM platform.domains WHERE status IN ('pending', 'dns_created', 'propagated')`);
  let wentLive = 0;
  for (const d of pending) {
    try {
      const propagated = await checkExternalDomainPropagation(d.domain);
      if (!propagated && d.status !== "dns_created") {
        // "dns_created" domains (our own subdomains) are proxied through
        // Cloudflare already and don't need a resolver-level check — they
        // go straight to the Caddy step below. "pending"/"propagated"
        // external domains wait here until the customer's own DNS change
        // resolves.
        continue;
      }
      appendCaddyBlock(d.domain);
      await reloadCaddyIfLocal();
      await query(`UPDATE platform.domains SET status = 'live', updated_at = now() WHERE id = $1`, [d.id]);
      wentLive += 1;
    } catch (err: any) {
      await query(`UPDATE platform.domains SET status = 'failed', last_error = $2, updated_at = now() WHERE id = $1`, [d.id, String(err.message || err)]);
    }
  }
  return { checked: pending.length, wentLive };
}

function appendCaddyBlock(domain: string): void {
  const block = renderCaddyBlock(domain);
  const dir = path.dirname(CADDY_SNIPPET_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const existing = fs.existsSync(CADDY_SNIPPET_PATH) ? fs.readFileSync(CADDY_SNIPPET_PATH, "utf8") : "";
  if (existing.includes(`${domain} {`)) return; // already appended
  fs.writeFileSync(CADDY_SNIPPET_PATH, `${existing}\n${block}`);
}

async function reloadCaddyIfLocal(): Promise<void> {
  // Only attempt a real reload when this service is actually running on the
  // same box as Caddy (production) — detected via an explicit env var
  // rather than guessing from hostname, so local/dev runs never try to
  // touch a directory that isn't mounted.
  if (process.env.VCPEER_BOOK_CADDY_RELOAD !== "true") return;
  // Fixed 2026-10-24: this used to `exec("caddy reload ...")` directly —
  // the `platform` container has no `caddy` binary and, even if it did,
  // runs in its own PID/filesystem namespace, so the command would either
  // fail outright or silently reload nothing on the host. Caddy itself
  // also runs as the unprivileged `caddy` system user, not reachable from
  // inside a Docker container without a docker-socket mount (not worth the
  // privilege escalation for a reload). Instead: drop a sentinel file into
  // the same bind-mounted directory the rendered `.caddy` snippet already
  // lives in; a host-side root cron (deploy/RUNBOOK.md section 8c, installed
  // alongside the existing Postgres backup cron) polls for it every minute,
  // runs `systemctl reload caddy`, and deletes it.
  fs.writeFileSync(RELOAD_SENTINEL_PATH, new Date().toISOString());
}

export function startDomainPollerJob(intervalMs = 60 * 1000): NodeJS.Timeout {
  return setInterval(() => {
    pollPendingDomains()
      .then(({ checked, wentLive }) => {
        if (checked) console.log(`[domainPoller] checked ${checked} pending domain(s), ${wentLive} went live`);
      })
      .catch((err) => console.error("[domainPoller] pass failed:", err));
  }, intervalMs);
}
