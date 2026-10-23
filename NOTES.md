# VCPeer Book — outstanding items needing live box/credentials access

This file follows the same pattern as `deploy/RUNBOOK.md`'s "Known
follow-ups" section (section 9) — honest callouts of things that are
genuinely not done, rather than silently skipped. Read `deploy/RUNBOOK.md`
in full first — most of what used to be "outstanding" there is already
live; this file is only the delta on top of that.

## DONE (2026-10-22, second pass): TZ=UTC + privacy-link fix deployed live

The box (`130.61.180.42`, alias `box`) was unreachable in the prior pass
that wrote this file and item 1 below — it is reachable now (`ssh box`,
passwordless sudo). Applied for real, live, this pass:

- Backed up `/opt/infra-box/stacks/vcpeer-book/docker-compose.yml` to
  `docker-compose.yml.bak-pre-tz-privacy-url-<epoch>` on box, then merged in
  this repo's `TZ` env vars (postgres/calcom/calcom-cron) and the `calcom`
  service's `command:` override (the `replace-placeholder.sh` patch for the
  privacy-policy link). Production has no `mailpit` service at all, so that
  part of the local compose file didn't apply.
- Appended `TZ=UTC` and
  `NEXT_PUBLIC_WEBSITE_PRIVACY_POLICY_URL=https://vcpeer.com/privacy` to
  `/etc/products/vcpeer-book.env`.
- Ran `docker compose --env-file /etc/products/vcpeer-book.env up -d
  postgres calcom calcom-cron` — all three recreated and healthy.
- **Verified live, in-container:** `docker exec vcpeer-book-calcom printenv
  TZ NEXT_PUBLIC_WEBSITE_PRIVACY_POLICY_URL` → `UTC` /
  `https://vcpeer.com/privacy`; `docker logs vcpeer-book-calcom` shows
  `Replacing all statically built instances of https://cal.com/privacy with
  https://vcpeer.com/privacy.`
- **Verified live, over the wire:** fetched `https://book.vcpeer.com/admin/30min`
  fresh (cache-busted query string) and downloaded all 52 referenced
  `/_next/static/chunks/*.js` files directly from production. Zero chunks
  contain the stale `cal.com/privacy` string; 4 chunks
  (`1eea3a80d000b6b0.js`, `56c8dc4acf9d3fba.js`, `90b610e574fd1bbb.js`,
  `af41f9b7b2d364b9.js`) now contain the literal
  `"https://vcpeer.com/privacy"` string in place of it. Every real booker
  hitting the live booking-confirmation form now gets linked to VCPeer's own
  privacy policy, not Cal.com's.
- Also confirmed item 4 below is moot in production: the live
  `docker-compose.yml` never had a `mailpit` service defined at all (that
  was only ever in this repo's local-dev copy), so there was nothing to
  stop/remove on box.

Item 1's original text (the manual procedure, now executed) is kept below
for historical reference.

## DONE (2026-10-23): brand-color drift (item 2 below) closed, live

Box access (`ssh box`) was available again this pass. Ran
`deploy/apply-vcpeer-branding.sql` directly against `vcpeer-book-postgres`
(`docker exec -i vcpeer-book-postgres psql -U calcom -d calcom <
deploy/apply-vcpeer-branding.sql`) — no drift on the other idempotent
settings (Jitsi keys, event-type titles/locations all converged to the same
values, zero unexpected changes). Verified live over the wire: fetched
`https://book.vcpeer.com/admin/30min` fresh (cache-busted) — 4 occurrences
of `#4678F9` in the raw HTML, 0 of the old `#2563EB`. Item 2's text below is
kept for historical reference; it is no longer outstanding.

## Correction (2026-10-23): the "no off-box backup copy" gap in
`ARCHITECTURE-2026-10-23.md` is wrong — one already exists

That doc (written this pass, before this correction) claims "Currently
`pg_dump` output never leaves `box`" and lists an off-box copy as a
priority-2 build item. Checked live on `box` before building anything:
`/opt/infra-box/backup/backup.sh` + `backup.timer` (systemd, 03:30 UTC) is a
box-wide restic-to-Cloudflare-R2 job that backs up `/srv` (among other
paths) every night, and `/srv/backups/vcpeer-book/` is not in
`/opt/infra-box/backup/excludes.txt`. Confirmed directly: `restic ls latest
/srv/backups/vcpeer-book` on `box` lists all three retained
`vcpeer-book-2026-10-*.dump` files inside the latest nightly snapshot. The
nightly Postgres dump already leaves the box every night via this
pre-existing, portfolio-wide mechanism — no new off-box-copy work is
needed for `vcpeer-book` specifically. Do not re-build a bespoke
scp/rsync-to-another-box job for this; it would be redundant with infra
already covering it.

## 1. Apply `TZ=UTC` and the privacy/terms link fix to the live stack — DONE, see above

**2026-10-22 finding, important — read before applying the above:** setting
`NEXT_PUBLIC_WEBSITE_PRIVACY_POLICY_URL` in `.env` alone, as this section
previously instructed, **does not work** and was never going to. Verified by
reproducing it locally: Next.js inlines `NEXT_PUBLIC_*` vars into the
compiled `.next` output at the Docker image's own build time (Cal.com's CI,
when `v6.2.0-arm` was built), not read fresh from the container environment
at request/start time. The live site today still shows
`https://cal.com/privacy` to every real booker on the confirmation form, not
a missing link and not a 404 — Cal.com's own, not VCPeer's. The actual fix
(now in this repo's `docker-compose.yml`, see
`branding/README.md` "Privacy/Terms links are hardcoded, not
runtime-configurable" for the full mechanism) patches the compiled output at
container start using Cal.com's own vendored `scripts/replace-placeholder.sh`
— the same tool upstream's own `start.sh` already uses for
`NEXT_PUBLIC_WEBAPP_URL`. No Cal.com source forked or edited. Verified
working end-to-end locally (fresh browser profile, restart-idempotent).
Leave `NEXT_PUBLIC_WEBSITE_TERMS_URL` unset on the box too — there is no
terms-of-service page on `vcpeer.com` yet (checked: no `terms.html`, no
matching route in `vcpeer/app/src/server.js`); the `command:` override skips
that replacement entirely when the var is empty, so Terms keeps pointing at
Cal.com's real terms page instead of a broken empty href. Build the terms
page in the `vcpeer` repo first (out of scope here — that's `vcpeer`, not
`vcpeer-book`), then fill in the var and this starts working with zero
further code changes.

## 2. Fix brand-color drift (light-mode accent is one shade off)

See `branding/README.md`'s "Brand color drift vs. `vcpeer`" section for the
full finding: `vcpeer`'s design system moved to a single `#4678f9` brand
token (no more light/dark split), but VCPeer Book's live in-app "Custom
brand colors" setting still has light = `#2563EB` (set 2026-10-15, now
stale). This is a web-UI setting, not a shell command — needs a real admin
login:

1. Go to `https://book.vcpeer.com/auth/login`, sign in with the real admin
   account (password manager, per `deploy/RUNBOOK.md` section 2).
2. Settings → My Account → Appearance → Custom brand colors.
3. Set light = `#4678F9`, dark = `#4678F9` (both, matching the single
   current token). Save. Cal.com's own contrast checker will warn that
   `#4678F9` fails its light-mode button-contrast check — this is advisory
   only (the save still succeeds, confirmed locally) and expected; see
   `branding/README.md` for the contrast-ratio math. Don't change the color
   to work around the warning.
4. Spot-check `https://book.vcpeer.com/admin/30min` in light mode — the
   "Confirm" button and selected-date highlight should render `#4678F9`,
   not the old `#2563EB`.

**Faster alternative, once box access is back:** instead of the manual
browser steps above, run `deploy/apply-vcpeer-branding.sh` against the
live `vcpeer-book-postgres` container (`POSTGRES_CONTAINER=vcpeer-book-postgres
deploy/apply-vcpeer-branding.sh` from inside `/opt/infra-box/stacks/vcpeer-book`,
or adapt the `docker exec` calls inside it to the box's actual container
name if different). It applies this exact brand-color fix plus the Jitsi
app config and event-type title/description — all idempotently, all
verified locally this pass (2026-10-22) by perturbing every value back to
Cal.com's stock defaults, running the script, and confirming full recovery,
then running it again to confirm it's a safe no-op. See
`branding/README.md` "Reproducible branding seed" for the full writeup.

## 3. DKIM confirmation for `bookings@vcpeer.com` (carried forward from RUNBOOK.md section 9)

Not new this pass — repeating because it's still genuinely unconfirmed and
easy to lose track of. SPF is confirmed live and correct
(`dig TXT vcpeer.com` → `include:eu.rp.oracleemaildelivery.com`). DKIM
signing status can only be checked in the OCI Email Delivery console for
the `vcpeer.com` approved sender (not via a blind `dig`, since the DKIM
CNAME selector name isn't known from outside that console) — needs whoever
has OCI console access, not a box SSH session. If confirmation emails start
landing in spam, check there first.

## 4. Confirm `mailpit` isn't running in the live stack now that it's profile-gated — DONE, moot

Verified 2026-10-22: `docker ps -a --filter name=vcpeer-book-mailpit` on box
returns nothing — the production `docker-compose.yml` never defined a
`mailpit` service at all (that only ever existed in this repo's local-dev
copy), so there was never a container to stop or remove.

## Still genuinely outstanding (needs owner-only access)

- **Item 2 (brand-color drift)** — DONE, see the 2026-10-23 section above.
- **Item 3 (DKIM confirmation)** — needs OCI Email Delivery console access,
  not a box SSH session.
- **New gap found 2026-10-22, not yet fixed:** the live admin user (`id=1`,
  `subasiarhan3@gmail.com`) has **zero calendar credentials connected**
  (`SELECT * FROM "Credential"` on box shows only the `jitsi_video` row) and
  **zero `Schedule` rows** (falls back to Cal.com's hardcoded default
  working hours). The `google-calendar` and `office365-calendar` apps are
  installed but `enabled=false`, with no OAuth client keys configured. This
  means the booking page has no way to check real calendar conflicts —
  every slot Cal.com shows as "free" is only free relative to existing
  VCPeer Book bookings, not the admin's actual Google Calendar. A real
  double-booking (an external meeting the admin already has) would not be
  caught. Fixing this needs a Google Cloud OAuth client (console access —
  create project, enable Calendar API, configure OAuth consent screen,
  redirect URI `https://book.vcpeer.com/api/integrations/googlecalendar/callback`)
  plus an interactive Google OAuth consent login as the admin — both
  owner-only steps, not available this pass. Once a GCP OAuth client
  exists, set its client ID/secret in `/etc/products/vcpeer-book.env` (see
  cal.diy's own docs for the exact `GOOGLE_API_CREDENTIALS` / client-id
  env var names for the installed image version), restart `calcom`, enable
  the `google-calendar` app in Settings → Admin → Apps, then connect it
  under Settings → My Account → Calendars as the admin user.

## Confirmed NOT done by this pass (by design, per task constraints)

- No CI/CD or GitHub Actions work.
