# VCPeer Book — outstanding items needing live box/credentials access

This file follows the same pattern as `deploy/RUNBOOK.md`'s "Known
follow-ups" section (section 9) — honest callouts of things that are
genuinely not done, rather than silently skipped. Everything here was found
or built in the 2026-10-21 deep-build pass but **could not be finished**
because the live box (`130.61.180.42`, alias `box`) was unreachable on port
22 for this pass, and some items need an interactive admin login that this
pass also didn't have. Read `deploy/RUNBOOK.md` in full first — most of
what used to be "outstanding" there is already live; this file is only the
delta on top of that.

## 1. Apply `TZ=UTC` and the privacy/terms link fix to the live stack

Added to this repo's `.env.example` / `.env` and wired into
`docker-compose.yml` this pass (see git log), but the production config
lives in `/etc/products/vcpeer-book.env` on `box`, which this pass never
touched. Once box access is available:

```bash
# On box, as root/sudo:
cd /opt/infra-box/stacks/vcpeer-book
cp docker-compose.yml docker-compose.yml.bak-pre-tz-privacy-url-$(date +%s)
# Merge this repo's docker-compose.yml changes into the live compose file by
# hand — same merge-don't-overwrite rule as RUNBOOK.md section 3's Caddy
# instructions. As of 2026-10-22 this now includes THREE things, not two:
#   1. TZ env on postgres/calcom/calcom-cron
#   2. mailpit gated behind the "dev" profile
#   3. the calcom service's `command:` override (replace-placeholder patch
#      for the privacy-policy link) — this is NOT optional cosmetic cleanup,
#      see the 2026-10-22 finding below. Skipping it means the env var below
#      has zero effect on the live site.
echo "TZ=UTC" >> /etc/products/vcpeer-book.env
echo "NEXT_PUBLIC_WEBSITE_PRIVACY_POLICY_URL=https://vcpeer.com/privacy" >> /etc/products/vcpeer-book.env
docker compose --env-file /etc/products/vcpeer-book.env up -d postgres calcom calcom-cron
# Verify: docker exec vcpeer-book-calcom printenv TZ NEXT_PUBLIC_WEBSITE_PRIVACY_POLICY_URL
# Verify docker logs vcpeer-book-calcom | grep -i "Replacing all statically
#   built instances of https://cal.com/privacy" — confirms the patch ran.
# Verify (in a fresh/incognito browser profile, NOT one that's already
#   visited book.vcpeer.com — Next.js serves /_next/static/chunks/*.js with
#   long-lived immutable cache headers, so an already-visited browser will
#   keep showing the stale cached link even after the server-side fix is
#   live) that the real booking-confirmation form's "Privacy Policy" link
#   (at https://book.vcpeer.com/admin/30min, click a time slot) now points
#   at https://vcpeer.com/privacy, not https://cal.com/privacy.
```

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

## 4. Confirm `mailpit` isn't running in the live stack now that it's profile-gated

This pass added `profiles: ['dev']` to `mailpit` in `docker-compose.yml` so
a bare `docker-compose up -d` can never start it — but if an earlier,
pre-this-pass deploy on `box` ever ran `docker-compose up -d mailpit`
directly (RUNBOOK.md's original section 1 warning existed precisely because
that was possible), the container could still be sitting there from before.
Once box access is available:

```bash
docker ps -a --filter name=vcpeer-book-mailpit
# If it exists and is running:
docker compose --env-file /etc/products/vcpeer-book.env stop mailpit
docker compose --env-file /etc/products/vcpeer-book.env rm -f mailpit
```

## Confirmed NOT done by this pass (by design, per task constraints)

- No SSH, no `curl` against `book.vcpeer.com` admin-only endpoints, no box
  access of any kind was attempted. Everything in this file is written,
  ready-to-run, and verified against the git history / upstream APIs from
  the local repo only.
- No CI/CD or GitHub Actions work.
- No deploy performed.
