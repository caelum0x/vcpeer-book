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
`gh api repos/calcom/cal.com` redirecting to `calcom/cal.diy`). **Re-checked
2026-10-21**: still true — `calcom/cal.diy`'s latest GitHub release is also
`v6.2.0` (2026-03-01), no newer tag exists upstream.

**Update (2026-10-21): the `calcom/cal.diy` Docker Hub repo now exists, but
is still empty** — `GET
https://hub.docker.com/v2/repositories/calcom/cal.diy/` returns `200` with
`date_registered: 2026-04-14` (so the namespace has been reserved for over
six months), but
`https://hub.docker.com/v2/repositories/calcom/cal.diy/tags/` returns
`count: 0` — zero tags, zero pulls. Don't treat the repo's mere existence as
"ready to switch to" — keep pulling `calcom/cal.com:v6.2.0-arm` (current
pin, confirmed still correct) until that repo actually has a tag in it.

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
`calcom/cal.diy` has started actually publishing tags into that (now
existing but still empty) image repo:

```bash
curl -s "https://hub.docker.com/v2/repositories/calcom/cal.com/tags/?page_size=5&ordering=last_updated" \
  | python3 -c "import json,sys;[print(r['name'], r['last_updated']) for r in json.load(sys.stdin)['results']]"
curl -s "https://api.github.com/repos/calcom/cal.diy/tags" | python3 -c "import json,sys;[print(t['name']) for t in json.load(sys.stdin)]" 2>&1 | head -5
# Added 2026-10-21 — the cal.diy-named Docker Hub repo exists now but was
# still empty as of this writing; this is the actual readiness check (count
# must be > 0, not just a 200 on the repo URL):
curl -s "https://hub.docker.com/v2/repositories/calcom/cal.diy/tags/?page_size=5" \
  | python3 -c "import json,sys;d=json.load(sys.stdin);print('tag count:', d['count']);[print(r['name'], r['last_updated']) for r in d['results']]"
```

If `cal.diy` ever ships its own multi-arch image (tag count above > 0),
switch `docker-compose.yml`'s `calcom.image` to it and drop the `-arm`
suffix convention above.

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

**Do not run the `mailpit` service in production.** As of 2026-10-21 this is
now enforced by Compose itself, not just a warning in this doc — `mailpit`
is gated behind the `dev` Compose profile in `docker-compose.yml`, so a bare
`docker-compose up -d` (what section 1's own `docker-compose pull` /
`docker-compose up -d postgres` / `docker-compose up -d calcom` sequence and
any future redeploy run) **never starts it**, even if an operator forgets
this paragraph. To run it locally for verification: `docker-compose
--profile dev up -d mailpit`. It exists only so this task could capture and
inspect the confirmation email locally without a real SMTP provider.

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
2. **Fast path (recommended, added 2026-10-22):** run
   `deploy/apply-vcpeer-branding.sh` right after creating the admin user. It
   idempotently applies steps 2-3 below (brand colors, disable-branding,
   Jitsi app install + keys + event-type locations, and the 15min/30min
   title/description copy) in one pass via direct SQL against the running
   Postgres container — verified locally end-to-end (perturb every value
   back to stock Cal.com defaults, run the script, confirm full recovery,
   run again to confirm it's a safe no-op). See
   `branding/README.md` "Reproducible branding seed" and the script's own
   header for exactly what it does and why. Steps 2-3 below are the manual,
   browser-driven equivalent — keep them for reference / if you want to
   verify or tweak one setting at a time, not because the script is
   incomplete.
2. Settings → My Account → Appearance: set **Custom brand colors** to light
   `#4678F9` / dark `#4678F9` (both — see `branding/README.md` "Brand color
   drift vs. vcpeer" for why both are the same value now, and the
   contrast-checker warning this exact value triggers in Cal.com's own UI,
   which is expected and safe to ignore), and turn on **Disable Cal.com
   branding** (exact steps verified locally — see `branding/README.md`).
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
5. Confirm the real booking-confirmation form's "Privacy Policy" link points
   at `https://vcpeer.com/privacy`, not `https://cal.com/privacy` — this is
   NOT an in-app setting, it's handled by `docker-compose.yml`'s `calcom`
   service `command:` override at container start. Check in a browser
   profile that hasn't already loaded `/_next/static/` assets from this host
   before the fix was deployed (immutable cache headers will otherwise show
   a stale cached link even when the server is already fixed). See
   `branding/README.md` "Privacy/Terms links are hardcoded, not
   runtime-configurable" for the full mechanism and why env vars alone don't
   work here.

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

## 8b. Platform service deploy (added 2026-10-23 — self-serve signup, analytics, webhooks, billing, custom domains, public API, embeddable widget)

Real application code, not a Cal.com config patch — lives in `platform/`
(own `package.json`, its own `Dockerfile`), added as a fourth service in
`docker-compose.yml` (`platform`, port 4100, `127.0.0.1`-only). See
`platform/src/server.ts`'s header comments and `BUILD-LOG-2026-10-23.md`
for what each route does; this section is deploy mechanics only.

1. **Bring the container up** (additive — never touches `postgres`/`calcom`):
   ```bash
   cd /opt/vcpeer-book   # or wherever this repo lives on the box
   docker compose --env-file /etc/products/vcpeer-book.env build platform
   docker compose --env-file /etc/products/vcpeer-book.env up -d platform
   docker compose logs -f platform   # expect "listening on :4100", then "ok":true from a curl to /healthz
   ```
2. **Fill in the new env vars** in `/etc/products/vcpeer-book.env` (see
   `.env.example`'s "PLATFORM SERVICE" section for the full list and what
   each one gates). Nothing here is required to boot — every missing var
   degrades gracefully (Slack/Discord notifications log a one-time warning
   and no-op, Dodo billing returns a clear 503, Cloudflare domain
   provisioning returns a clear 503) — but each is a real feature with
   nothing live until it's set.
3. **Set `VCPEER_BOOK_CADDY_RELOAD=true`** only on the box itself (never
   locally) — this is what lets `routes/domains.ts`'s background poller
   actually run `caddy reload` once a paid org's custom domain goes live.
4. **Merge `deploy/platform.caddy`** into the box's Caddyfile (same
   "merge by hand, don't overwrite" rule as section 3) — routes the
   marketing site, signup wizard, dashboard, widget, and all `/api/*`
   `/v1/*` `/webhooks/*` paths to the new container; everything else keeps
   going straight to `calcom`, byte-for-byte unchanged from before this
   service existed.
5. **Configure the Cal.com -> platform webhook** (powers item 6's
   notifications/no-show detection and feeds item 5's analytics from
   `BOOKING_CREATED`/`BOOKING_CANCELLED`/`BOOKING_RESCHEDULED`): log in as
   the admin, Settings -> Developer -> Webhooks -> New Webhook ->
   Subscriber URL `https://book.vcpeer.com/webhooks/calcom`, Payload
   Template default, Secret = the same value as `CALCOM_WEBHOOK_SECRET` in
   `/etc/products/vcpeer-book.env`. This is an in-app, one-time step with
   no API shortcut available before an API key already exists — can't be
   scripted from a pass without an interactive admin session.
6. **Mint the first API keys** (item 8's widget + item 9's public API):
   ```bash
   curl -X POST https://book.vcpeer.com/api/admin/api-keys \
     -H "x-admin-secret: $ADMIN_API_SECRET" \
     -H "content-type: application/json" \
     -d '{"label":"vcpeer.com widget","scope":"widget"}'
   ```
   Save the returned key immediately — only its hash is stored, it cannot
   be retrieved again (see `routes/adminKeys.ts`).
7. **Verify live**: `curl https://book.vcpeer.com/healthz` (platform),
   `curl https://book.vcpeer.com/pricing` (marketing site through Caddy),
   `curl https://book.vcpeer.com/admin/30min` (confirms Cal.com's own
   routes are untouched).

## 8c. Custom-domain Caddy auto-provisioning — directory + reload cron (added 2026-10-24)

Item 4's `pollPendingDomains()` (`routes/domains.ts`) renders a real Caddy
site block per live paid-tier custom domain and needs the host's actual
Caddy process to pick it up. Two one-time steps on the box, neither touches
an existing site file:

1. **Import the directory** — add one line to the box's main Caddyfile
   (`/opt/infra-box/caddy/Caddyfile` and its deployed copy
   `/etc/caddy/Caddyfile`), directly after the existing
   `import /etc/caddy/sites-enabled/*.caddy` line:
   ```caddyfile
   import /opt/infra-box/stacks/vcpeer-book/deploy/custom-domains/*.caddy
   ```
   (adjust the path if this stack is checked out somewhere else on the box).
   An empty/no-match glob is a valid Caddy import, so this is safe to add
   before any custom domain has ever gone live. Validate + reload the same
   way as any other Caddyfile edit: `sudo systemctl reload caddy`.
2. **Install the reload cron** — `platform`'s container can't run
   `systemctl reload caddy` itself (no `caddy` binary in the container, and
   no docker-socket access by design — not worth the privilege escalation
   for a reload). It drops a `.reload-requested` sentinel file into the
   same bind-mounted directory instead; this cron on the host (root,
   alongside the existing `/etc/cron.d/vcpeer-book-backup`) consumes it:
   ```
   * * * * * root test -f /opt/infra-box/stacks/vcpeer-book/deploy/custom-domains/.reload-requested && rm -f /opt/infra-box/stacks/vcpeer-book/deploy/custom-domains/.reload-requested && systemctl reload caddy
   ```
   Install as `/etc/cron.d/vcpeer-book-caddy-reload` (`root:root 0644`).

Without both of these, a custom domain would flip to `status = 'live'` in
`platform.domains` (DNS record real, Cloudflare propagation real) while its
actual HTTPS traffic still 404s — this was the exact gap closed this round.

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
- **Brand color drift vs. the live `vcpeer` design system (found
  2026-10-21, DONE 2026-10-23)**: this repo's `branding/README.md`
  documented the in-app "Custom brand colors" setting as light `#2563EB` /
  dark `#4678F9`, stale against `vcpeer`'s single current
  `--ds-brand-500: #4678f9` token. Fixed live 2026-10-23 by running
  `deploy/apply-vcpeer-branding.sql` against the production
  `vcpeer-book-postgres` container (no browser login needed) — verified
  both in Postgres (`brandColor = darkBrandColor = #4678F9`) and over the
  wire (fresh fetch of `https://book.vcpeer.com/admin/30min` shows
  `#4678F9`, zero `#2563EB`). See `branding/README.md` for the full
  before/after and the contrast-checker warning `#4678F9` triggers (expected,
  advisory only, does not block saving).
- **`TZ=UTC` and the privacy/terms link fix added this pass (2026-10-21,
  mechanism corrected 2026-10-22) — not yet applied to the live stack**:
  `TZ` is a plain runtime env var and works as soon as it's in
  `/etc/products/vcpeer-book.env` and the container restarts. The
  privacy-policy link is NOT a plain runtime env var fix, despite looking
  like one — **2026-10-22 finding**: `NEXT_PUBLIC_WEBSITE_PRIVACY_POLICY_URL`
  is inlined into the compiled `.next` output at the Docker image's own
  build time, so setting it in `.env` alone (this section's original plan)
  has zero effect; the live site today still sends every real booker to
  Cal.com's own `https://cal.com/privacy`. The actual fix is now in this
  repo's `docker-compose.yml` (a `command:` override on the `calcom` service
  that patches the compiled output at container start using Cal.com's own
  `scripts/replace-placeholder.sh` — no source forked or edited) and must be
  merged into the live compose file along with the env var, not instead of
  it. See `branding/README.md` "Privacy/Terms links are hardcoded, not
  runtime-configurable" for the full mechanism, and `NOTES.md` section 1 for
  the exact box commands (now three docker-compose.yml changes to merge, not
  two).
- **Reproducible branding/config seed script (added 2026-10-22)**:
  `deploy/apply-vcpeer-branding.sql` + `deploy/apply-vcpeer-branding.sh` —
  idempotently applies brand colors, "Disable Cal.com branding", the Jitsi
  Video app install/keys/event-type locations, and the 15min/30min
  title/description copy via direct SQL, all in one command. Closes a real
  gap: before this, every one of those settings existed only as a
  browser-click or a one-off `psql` command, with nothing able to reproduce
  them on a fresh install or disaster-recovery restore. Verified locally:
  perturbed every value back to Cal.com's stock defaults, ran the script,
  confirmed full recovery, ran it again to confirm it's a safe no-op. Not
  yet run against the live box (needs access) — once it is, prefer it over
  the manual browser steps in section 2 above for any future redeploy.
- **VCPeer Book's booking link as a CTA on the main `vcpeer.com` app**: DONE
  (confirmed 2026-10-19 by reading the live `vcpeer` source, not just
  planned) — `https://book.vcpeer.com/admin/30min` is already linked from
  the nav ("Book") on `launchboard.html`, `notify.html`, `send.html`, and
  `landing.html`, from an "Open Book" CTA on `landing.html`, from a
  dedicated `public/views/seo/free-scheduling-link.html` SEO landing page,
  and `public/js/client.js` opens it pre-filled with the current room's
  context from inside an active call. No further cross-repo wiring needed.
