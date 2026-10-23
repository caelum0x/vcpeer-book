import { request } from "undici";

// Real Cloudflare DNS automation for item 4 (custom-domain provisioning).
//
// Two supported modes, both real:
//  - "subdomain" (default): provisions `<slug>.book.vcpeer.com` as the
//    paying org's branded subdomain, via a real Cloudflare API call against
//    the `vcpeer.com` zone this portfolio already owns (CLOUDFLARE_DNS_API_TOKEN,
//    confirmed live/working — see memory bidstage-www-cross-worker-route-squat-fix).
//    This is the actual deliverable: Cal.com Cloud's own paid "Organizations"
//    tier sells exactly this (a company subdomain), per STRATEGY-2026-10-23.md
//    section 2.
//  - "external": the org brings their own domain; since that domain's DNS
//    isn't in our Cloudflare account, we can't create a record for them —
//    instead we poll their domain's CNAME via plain DNS resolution until it
//    points at book.vcpeer.com, matching what any multi-tenant SaaS asks a
//    customer to do on their own DNS provider.

const CF_API_TOKEN = process.env.CLOUDFLARE_DNS_API_TOKEN || "";
const CF_ZONE_ID = process.env.CLOUDFLARE_VCPEER_ZONE_ID || "84dbd09a667fee5410a30057c9186a3e"; // vcpeer.com zone
const CF_API_BASE = "https://api.cloudflare.com/client/v4";
const ROOT_DOMAIN = process.env.VCPEER_BOOK_ROOT_DOMAIN || "book.vcpeer.com";

export interface CloudflareRecordResult {
  id: string;
  name: string;
  content: string;
}

export function isCloudflareConfigured(): boolean {
  return Boolean(CF_API_TOKEN);
}

/** Creates (or returns the existing) CNAME record for `<slug>.book.vcpeer.com` -> book.vcpeer.com. */
export async function provisionSubdomain(slug: string): Promise<CloudflareRecordResult> {
  if (!CF_API_TOKEN) {
    throw new Error("CLOUDFLARE_DNS_API_TOKEN not configured — cannot provision DNS");
  }
  const recordName = `${slug}.${ROOT_DOMAIN}`;

  const existing = await cfFetch(`/zones/${CF_ZONE_ID}/dns_records?type=CNAME&name=${encodeURIComponent(recordName)}`);
  if (existing.result?.length) {
    const r = existing.result[0];
    return { id: r.id, name: r.name, content: r.content };
  }

  const created = await cfFetch(`/zones/${CF_ZONE_ID}/dns_records`, {
    method: "POST",
    body: {
      type: "CNAME",
      name: recordName,
      content: ROOT_DOMAIN,
      ttl: 300,
      proxied: true, // Cloudflare-proxied: automatic edge TLS, no origin cert needed
      comment: "vcpeer-book platform: auto-provisioned tenant subdomain",
    },
  });
  const r = created.result;
  return { id: r.id, name: r.name, content: r.content };
}

export async function deleteSubdomainRecord(recordId: string): Promise<void> {
  if (!CF_API_TOKEN) return;
  await cfFetch(`/zones/${CF_ZONE_ID}/dns_records/${recordId}`, { method: "DELETE" });
}

/** DNS-resolves `domain` and checks whether its CNAME/A chain reaches book.vcpeer.com's target. Used for "external" mode. */
export async function checkExternalDomainPropagation(domain: string): Promise<boolean> {
  const dns = await import("dns/promises");
  try {
    const result = await dns.resolveCname(domain).catch(() => [] as string[]);
    if (result.some((target) => target.replace(/\.$/, "") === ROOT_DOMAIN)) return true;
    // Fall back to A-record match against the box's own public IP, for
    // customers who prefer an A record over a CNAME.
    const boxIp = process.env.VCPEER_BOOK_BOX_IP || "130.61.180.42";
    const aRecords = await dns.resolve4(domain).catch(() => [] as string[]);
    return aRecords.includes(boxIp);
  } catch {
    return false;
  }
}

async function cfFetch(path: string, init: { method?: string; body?: unknown } = {}): Promise<any> {
  const res = await request(`${CF_API_BASE}${path}`, {
    method: (init.method as any) || "GET",
    headers: {
      authorization: `Bearer ${CF_API_TOKEN}`,
      "content-type": "application/json",
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.body.text();
  const json = text ? JSON.parse(text) : {};
  if (res.statusCode >= 400 || json.success === false) {
    throw new Error(`Cloudflare API error (${res.statusCode}): ${JSON.stringify(json.errors || json)}`);
  }
  return json;
}

/** Renders a Caddy site block for a newly-live tenant domain, reverse-proxying to the same Cal.com origin. Appended to deploy/custom-domains.caddy by the domains route. */
export function renderCaddyBlock(domain: string): string {
  return `${domain} {\n    reverse_proxy 127.0.0.1:3000\n    encode gzip\n}\n`;
}
