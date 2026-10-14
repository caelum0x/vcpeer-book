# VCPeer Book deploy runbook

Everything in this file was **written, not executed** — this task was local-only
(no deploy, no DNS, no servers, no store changes; disk-floor constrained). It is
the exact procedure for whoever deploys this later.

Stack: Cal.com community edition (**cal.diy**, MIT, `github.com/calcom/cal.diy`
— `calcom/cal.com` now redirects there) + Postgres, branded for VCPeer, with
booked meetings carrying a `https://vcpeer.com/join/<room-slug>` VCPeer video
room link as the event location. See `branding/README.md` for the full
rationale on the branding and location-link approach, and the project root
`docker-compose.yml` / `.env.example` for the actual config.

## 0. Image choice — read this before you pull anything

`calcom/cal.com` on Docker Hub has **not published anything past `v6.2.0`**
since the `calcom/cal.com` → `calcom/cal.diy` rename (2026-09-26, confirmed via
`gh api repos/calcom/cal.com` redirecting to `calcom/cal.diy`). As of this
writing there is **no `cal.diy`-named image** on Docker Hub or GHCR yet.

Docker Hub does carry **native arm64 builds** of each release under a
`-arm` tag suffix (confirmed via the Docker Hub tags API:
`https://hub.docker.com/v2/repositories/calcom/cal.com/tags/?ordering=last_updated`
— `v6.2.0-arm` has `architecture: arm64`, same push date as `v6.2.0`/`latest`
which are amd64). **Always use the `-arm` tag on the Oracle Ampere box** —
it runs natively (no QEMU emulation, far less CPU/RAM overhead). `latest` and
plain version tags without `-arm` are amd64-only and will silently run under
emulation if pulled on an arm64 host, which works but is slow and wastes
CPU/RAM on a shared box.

**Before every redeploy**, re-check for a newer release and for whether
`calcom/cal.diy` has started publishing its own image yet:

```bash
curl -s "https://hub.docker.com/v2/repositories/calcom/cal.com/tags/?page_size=5&ordering=last_updated" \
  | python3 -c "import json,sys;[print(r['name'], r['last_updated']) for r in json.load(sys.stdin)['results']]"
curl -s "https://api.github.com/repos/calcom/cal.diy/tags" | python3 -c "import json,sys;[print(t['name']) for t in json.load(sys.stdin)]" 2>&1 | head -5
```

If `cal.diy` ever ships its own multi-arch image, switch `docker-compose.yml`'s
`calcom.image` to it and drop the `-arm` suffix convention above.

## 1. Oracle Ampere ARM64 box setup

Use one of the existing free Oracle Ampere boxes (see memory
`hosting-all-on-oracle-2026-10-13` — do **not** spin up a new paid box; this
app is small enough to share a box with other VCPeer services).

```bash
# On the box (arm64 Linux, Docker + docker-compose already present per other
# products' runbooks on the same boxes):
mkdir -p /opt/vcpeer-book
cd /opt/vcpeer-book
git clone <this repo's remote, once one exists> .
# or: scp -r the vcpeer-book directory up, since this repo currently has no
# remote configured (local-only task — see report).

cp .env.example .env
# Fill in for real:
#   NEXT_PUBLIC_WEBAPP_URL / NEXT_PUBLIC_WEBSITE_URL / NEXTAUTH_URL = https://book.vcpeer.com
#   ALLOWED_HOSTNAMES='"book.vcpeer.com"'
#   NEXTAUTH_SECRET      = openssl rand -base64 32
#   CALENDSO_ENCRYPTION_KEY = openssl rand -base64 24
#   POSTGRES_PASSWORD    = openssl rand -hex 16
#   EMAIL_SERVER_HOST/PORT/USER/PASSWORD = real Scribase Mail Studio SMTP
#     creds (mail.scribase.com — see memory scribase-mail-studio-resend-parity;
#     do NOT use Mailpit in production, that's local-verification only)
#   EMAIL_FROM = bookings@vcpeer.com (needs SPF/DKIM on vcpeer.com pointing at
#     Scribase Mail's sending domain — check with Scribase Mail Studio's
#     domain-verification flow before go-live, or mail WILL land in spam)

docker-compose pull        # pulls calcom/cal.com:v6.2.0-arm natively, postgres:16-alpine, mailpit
docker-compose up -d postgres
# wait for postgres healthy, then:
docker-compose up -d calcom
# first boot runs prisma migrate + seeds the app store automatically (same
# entrypoint behavior verified locally — takes ~60-90s on first run).
```

**Do not run the `mailpit` service in production** — remove it from the
compose file or just never `docker-compose up -d mailpit` there. It exists
only so this task could capture and inspect the confirmation email locally
without a real SMTP provider.

## 2. First-run setup (one-time, through the browser, via an SSH tunnel)

Don't expose port 3000 publicly before Caddy/Cloudflare Tunnel is in front of
it. From your laptop:

```bash
ssh -L 3000:localhost:3000 <oracle-box>
```

Then open `http://localhost:3000/auth/setup` and:
1. Create the admin user (real VCPeer team email, a real strong password —
   this task's local admin password tripped Cal.com's own "add 2FA or use a
   15+ char password" nag; use a password manager and set a real one).
2. Settings → My Account → Appearance: set **Custom brand colors** to light
   `#2563EB` / dark `#4678F9`, and turn on **Disable Cal.com branding** (exact
   steps verified locally — see `branding/README.md`).
3. For every event type you want bookable, set **Location → Link meeting**
   and paste a VCPeer room URL (`https://vcpeer.com/join/<slug>`) — generate
   a fresh random slug per event type, write it down, never reuse it
   elsewhere. Verified end-to-end locally: the attendee's confirmation page
   and the confirmation email both show this exact URL as "Where".
4. Settings → Admin → turn off public signups if `NEXT_PUBLIC_DISABLE_SIGNUP`
   in `.env` didn't already cover it (internal tool, not a public SaaS).

## 3. Reverse proxy — Caddy (same pattern as the live `vcpeer` deploy)

Follow the exact pattern in `vcpeer/deploy/Caddyfile.vcpeer` — **merge by
hand** into the box's existing Caddyfile, don't overwrite it:

```caddyfile
book.vcpeer.com {
    reverse_proxy 127.0.0.1:3000
    encode gzip
}
```

If the box instead uses a Cloudflare Tunnel (check which of the 4 Oracle
boxes this lands on first — some use Caddy+ACME, some use `cloudflared`),
add a tunnel ingress rule instead:

```yaml
ingress:
  - hostname: book.vcpeer.com
    service: http://localhost:3000
  # ... existing rules ...
  - service: http_status:404
```

DNS: `book.vcpeer.com` CNAME → the tunnel, or A record → the box's IP if
using Caddy+ACME directly (owner-only DNS step — not performed here).

## 4. Process supervision

`docker-compose` with `restart: unless-stopped` (already set on every service
in `docker-compose.yml`) is sufficient — no separate `pm2`/systemd unit
needed, Docker's own restart policy covers reboots once the Docker daemon is
set to start on boot (it is, on the existing Oracle boxes per their own
runbooks).

## 5. Backup — Postgres volume

```bash
# Nightly cron on the box, same cadence as the other Oracle-hosted Postgres
# (caldesk-pg, oxhan-postgres) per memory railyard-backend-infra:
docker exec vcpeer-book-postgres pg_dump -U calcom calcom \
  | gzip > /opt/backups/vcpeer-book/calcom-$(date +%F).sql.gz

# Keep 14 days, prune older:
find /opt/backups/vcpeer-book -name '*.sql.gz' -mtime +14 -delete
```

Restore:
```bash
docker-compose stop calcom
gunzip -c /opt/backups/vcpeer-book/calcom-<date>.sql.gz \
  | docker exec -i vcpeer-book-postgres psql -U calcom calcom
docker-compose start calcom
```

## 6. Rollback

Image tags are pinned in `docker-compose.yml` (`calcom/cal.com:v6.2.0-arm`),
never `:latest` — rollback is just:

```bash
git log --oneline -- docker-compose.yml   # find the previous image tag
git checkout <previous-commit> -- docker-compose.yml
docker-compose up -d calcom                # re-pulls the previous tag if not cached
```

No destructive DB migration is expected between adjacent Cal.com patch
releases, but **always back up Postgres (step 5) before any upgrade** —
`prisma migrate deploy` runs automatically on container start and is
one-directional.

## 7. Upstream update procedure

1. Re-run the image-check commands in section 0.
2. Read the release's changelog on `github.com/calcom/cal.diy/releases` (or
   `calcom/cal.com` if still there) for breaking changes / new required env
   vars — diff against `.env.example` upstream
   (`https://raw.githubusercontent.com/calcom/cal.com/main/.env.example`) and
   merge any new vars into this repo's `.env.example`.
3. Back up Postgres (step 5).
4. Bump the tag in `docker-compose.yml`, `docker-compose pull`,
   `docker-compose up -d calcom`, watch logs for migration errors.
5. Smoke-test: log in, open one event type, confirm its Location still shows
   the VCPeer Link-meeting URL (upgrades should never touch booking data),
   book a test slot, confirm the email still carries the room link.

## 8. Known follow-ups (not built here, honestly flagged)

- **Per-booking unique VCPeer rooms**: current setup is one persistent room
  per event type (see `branding/README.md` for why). If overlapping
  concurrent bookings of the same event type become a real scenario, build a
  proper Cal.com conferencing-app integration (`createMeeting()` hook) —
  that requires forking `cal.diy` source, out of scope for this adoption.
- **Cal.com wordmark in the internal dashboard nav** cannot be replaced via
  env/settings in community edition (requires either an Enterprise-tier
  custom-logo feature or a source fork) — see `branding/README.md`. Not
  visible to attendees, only to the logged-in VCPeer team, so left as-is.
- **SPF/DKIM for `bookings@vcpeer.com` via Scribase Mail** must be verified
  before go-live or confirmation emails will land in spam — this is a
  Scribase Mail Studio domain-verification step, not a Cal.com config step.
- Add VCPeer Book's booking link as a "Schedule a call" CTA on the main
  `vcpeer.com` MiroTalk call rooms, per
  `plans/OSS-ADOPTION-2026-10-15.md`'s original rationale for this adoption.
