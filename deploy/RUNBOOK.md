# VCPeer Book deploy runbook

**Current live status (2026-10-21):** this is deployed and live, not just
written. `https://book.vcpeer.com` (verified: `/auth/login` title "Login |
VCPeer Book", `/admin/30min` title "30 min meeting | VCPeer Admin", both HTTP
200, valid LE cert, `CN=book.vcpeer.com`, valid through 2027-01-12) is served
by `vcpeer-book-postgres` + `vcpeer-book-calcom` on the `box` Oracle Ampere
host (130.61.180.42), stack at `/opt/infra-box/stacks/vcpeer-book/`, config
in `/etc/products/vcpeer-book.env`, Caddy site at
`/etc/caddy/sites-enabled/vcpeer-book.caddy`. DNS (`book.vcpeer.com` A ->
130.61.180.42) is live. The Jitsi app keys (`jitsiHost` ->
`https://vcpeer.com/join`) are confirmed set in the live `App` table. As of
2026-10-21, `vcpeer-book-calcom-cron` is also deployed in production (see
section 8 — this closed the gap where `CRON_API_KEY` sat unused and
reminder/webhook-retry endpoints never fired live), and a nightly Postgres
backup cron (`/etc/cron.d/vcpeer-book-backup`, 03:27 UTC, 14-day retention,
dumps to `/srv/backups/vcpeer-book/`, root:root 700) is installed and was
smoke-tested with a real manual dump. Everything below this point describes
the original write-up of the procedure (kept for historical accuracy and as
the reference for re-deploys/upgrades) — read the "Known follow-ups" section
at the bottom for what is still genuinely outstanding.

Stack: Cal.com community edition (**cal.diy**, MIT, `github.com/calcom/cal.diy`
— `calcom/cal.com` now redirects there) + Postgres, branded for VCPeer, with
every booking getting its own unique VCPeer video room link
(`https://vcpeer.com/join/<uuid>`, minted per-booking by Cal.com's built-in
Jitsi conferencing app — not a shared static link; see `branding/README.md`
"Video room integration" for the privacy-bug history and fix). See
`branding/README.md` for the full branding rationale, and the project root
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
3. Install and configure the **Jitsi Video** conferencing app (gives every
   booking a unique room — do NOT use the static "Link meeting" location
   type for this, see `branding/README.md` "v1 (superseded)" for why that
   was a privacy bug):
   - Settings → My Account → Conferencing → **Add** → install "Jitsi Video".
   - Settings → Admin → Apps → Conferencing → Jitsi Video → edit (pencil) →
     **Edit keys**: `jitsiHost = https://vcpeer.com/join`,
     `jitsiPathPattern` left blank (defaults to `{uuid}`) → Save.
   - For every event type you want bookable: Basics → Location → select
     **Jitsi Video** → Save.
   Verified end-to-end locally with two separate bookings of the same event
   type: each got its own `https://vcpeer.com/join/<uuid>`, confirmed on
   both the confirmation page and in the confirmation email.
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

**DONE, live in production (2026-10-21).** Installed as `/etc/cron.d/vcpeer-book-backup`
on `box`, following the exact pattern already used for `oxhan-backup` on the
same host (custom-format `pg_dump -Fc`, not plain-SQL+gzip as originally
sketched below — `-Fc` is what the sibling stacks on this box use and it's
what `pg_restore` expects):

```
27 3 * * * root docker exec vcpeer-book-postgres pg_dump -U calcom -Fc calcom > /srv/backups/vcpeer-book/vcpeer-book-$(date +\%F).dump && find /srv/backups/vcpeer-book -name "vcpeer-book-2*.dump" -mtime +14 -delete
```

`/srv/backups/vcpeer-book/` is `root:root 0700`, same permissions as
`/srv/backups/oxhan/`. Smoke-tested with a real manual run on 2026-10-21 —
produced a 584KB `.dump` file, confirmed via `sudo ls -la`.

Restore:
```bash
docker compose stop calcom
sudo docker exec -i vcpeer-book-postgres pg_restore -U calcom -d calcom -c \
  < /srv/backups/vcpeer-book/vcpeer-book-<date>.dump
docker compose start calcom
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
   **Jitsi Video** (not a reverted "Link meeting" — upgrades should never
   touch booking/app-key data, but check anyway), confirm Settings → Admin →
   Apps → Conferencing → Jitsi Video's keys still show `jitsiHost =
   https://vcpeer.com/join`, then book two test slots and confirm the two
   confirmation emails carry two *different* `vcpeer.com/join/<uuid>` links
   (this is the privacy-bug regression check — see `branding/README.md`
   "v1 (superseded)" for what it's guarding against).

## 8. Cron triggers — required, not optional

cal.diy gates several background jobs behind `CRON_API_KEY` and expects an
**external** periodic caller — on upstream's own hosted Cal.com this is a
GitHub Actions cron workflow per endpoint
(`calcom/cal.diy/.github/workflows/cron-bookingReminder.yml` etc), **not**
anything the app container runs on its own. This repo generates
`CRON_API_KEY` in `.env` but, until the `calcom-cron` service was added to
`docker-compose.yml`, nothing ever called those endpoints — pending-booking
reminder emails (`/api/cron/bookingReminder`, reminds the organizer at
48h/24h/3h if a booking is still awaiting confirmation), timezone-change
processing (`/api/cron/changeTimeZone`), and webhook delivery retries
(`/api/cron/webhookTriggers`) would have silently never fired in production.

The `calcom-cron` service (`alpine` + `curl` + `crond`) replicates upstream's
own cadence: `*/15 * * * *` for `bookingReminder` and
`workflows/scheduleEmailReminders`, hourly for `changeTimeZone`, every
minute for `webhookTriggers`. It starts automatically with
`docker-compose up -d` (no extra step), but **after deploy, tail its logs
once** to confirm the curls are returning 200s, not 401s:

```bash
docker-compose logs -f calcom-cron
```

A 401 there means `CRON_API_KEY` in `.env` doesn't match what the `calcom`
container has loaded — redeploy `calcom-cron` after fixing `.env`
(`docker-compose up -d calcom-cron`).

**DONE, deployed to production (2026-10-21).** This service existed locally
since the 2026-10-?? fix but had never been pushed to the live
`/opt/infra-box/stacks/vcpeer-book/docker-compose.yml` — the production
stack ran with only `postgres` + `calcom` for a week while `CRON_API_KEY`
sat unused in `/etc/products/vcpeer-book.env`. Closed this gap: added the
same `calcom-cron` block to the production compose file (backed up the
prior file as `docker-compose.yml.bak-pre-cron-<timestamp>` first), brought
up only the new service with
`docker compose --env-file /etc/products/vcpeer-book.env up -d calcom-cron`
(did not touch the already-running `postgres`/`calcom` containers), and
verified directly inside the container that
`curl ... -H "authorization: $CRON_API_KEY" http://calcom:3000/api/cron/webhookTriggers`
returns `200`. Busybox `crond -l 2` does not log successful job runs to
stdout (only warnings/errors), so an empty `docker logs` is expected and is
itself the "no 401s" signal — don't mistake silence for the service being
dead; check `docker ps` for `Up` + the manual curl above as the real test.

## 9. Known follow-ups (not built here, honestly flagged)

- **Per-booking unique VCPeer rooms**: DONE (2026-10-15 follow-up) — Cal.com's
  built-in Jitsi conferencing app (`jitsiHost` app key pointed at
  `https://vcpeer.com/join`) now mints a fresh `{uuid}` room per booking,
  still zero source changes. See `branding/README.md` "v2 (current)" for the
  full verification (two bookings, two different room links, both on the
  confirmation page and in the Mailpit-captured emails).
- **Cal.com wordmark in the internal dashboard nav** cannot be replaced via
  env/settings in community edition (requires either an Enterprise-tier
  custom-logo feature or a source fork) — see `branding/README.md`. Not
  visible to attendees, only to the logged-in VCPeer team, so left as-is.
- **SPF/DKIM for `bookings@vcpeer.com`**: production actually sends via OCI
  Email Delivery (`smtp.email.eu-frankfurt-1.oci.oraclecloud.com`), not
  Scribase Mail as this doc originally planned — confirmed by reading
  `/etc/products/vcpeer-book.env` on `box`. SPF is **already correct**:
  `dig TXT vcpeer.com` shows `v=spf1 ... include:eu.rp.oracleemaildelivery.com
  ~all` live today. DKIM was **not** independently confirmed this pass (OCI's
  DKIM CNAME selector name isn't known from outside the OCI console, so it
  can't be checked via a blind `dig` the way SPF was) — if confirmation
  emails ever start landing in spam, check DKIM signing status in the OCI
  Email Delivery console for the `vcpeer.com` approved sender, not here.
- **`CRON_API_KEY`-gated endpoints wired up in production**: DONE
  (2026-10-21, this pass) — see section 8 above. The `calcom-cron` sidecar
  was in the local repo's `docker-compose.yml` but had never been deployed
  to the live stack; now live, verified with a direct 200 from
  `/api/cron/webhookTriggers`.
- **Nightly Postgres backup**: DONE (2026-10-21, this pass) — see section 5
  above. `/etc/cron.d/vcpeer-book-backup` installed on `box`, smoke-tested
  with a real manual dump.
- **VCPeer Book's booking link as a CTA on the main `vcpeer.com` app**: DONE
  (confirmed 2026-10-19 by reading the live `vcpeer` source, not just
  planned) — `https://book.vcpeer.com/admin/30min` is already linked from
  the nav ("Book") on `launchboard.html`, `notify.html`, `send.html`, and
  `landing.html`, from an "Open Book" CTA on `landing.html`, from a
  dedicated `public/views/seo/free-scheduling-link.html` SEO landing page,
  and `public/js/client.js` opens it pre-filled with the current room's
  context from inside an active call. No further cross-repo wiring needed.
