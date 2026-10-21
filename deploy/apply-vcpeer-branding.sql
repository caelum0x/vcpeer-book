-- VCPeer Book — idempotent branding/config seed.
--
-- Everything this repo's branding/README.md and deploy/RUNBOOK.md describe as
-- "in-app settings, no source change" (brand colors, "Disable Cal.com
-- branding", the Jitsi Video conferencing app + per-event-type location, the
-- 15min/30min title+description copy) lives ONLY in Postgres rows that were
-- set by hand, once, through the browser or a one-off `psql` command. Until
-- now there was no script to reproduce that state — a fresh install, a
-- disaster-recovery restore onto an empty DB, or a staging/second
-- environment would all silently regress to stock, unbranded Cal.com
-- defaults (shared meet.jit.si rooms, "Powered by Cal.com" footer, generic
-- "15 min meeting" seed copy) with nothing in git flagging that gap. This
-- script closes it.
--
-- Idempotent: every statement is a straight UPDATE keyed on role='ADMIN' /
-- slug, or an INSERT guarded by a NOT EXISTS check — running this twice (or
-- a hundred times) converges to the same end state and never errors or
-- duplicates rows. Safe to run as part of a fresh deploy, right after the
-- one-time /auth/setup admin-creation wizard, or at any point later to
-- re-assert the correct config if someone changes a setting by accident.
--
-- Usage (same docker-exec-into-postgres pattern already used in this repo's
-- deploy/RUNBOOK.md for the one-off EventType title/description UPDATE):
--   docker exec -i vcpeer-book-postgres psql -U calcom -d calcom \
--     < deploy/apply-vcpeer-branding.sql
-- Or via the wrapper (does the above plus container/precondition checks and
-- a plain-English verification summary): deploy/apply-vcpeer-branding.sh
--
-- Assumes: exactly one admin user already exists (role = 'ADMIN'), created
-- via the one-time /auth/setup wizard. This is a safe assumption here, not a
-- hack — NEXT_PUBLIC_DISABLE_SIGNUP=true (.env.example) and
-- branding/README.md both document this as a single-admin internal team
-- tool, never a multi-tenant instance. Also assumes Cal.com's own per-user
-- seed has already created the `15min` / `30min` event types — verified
-- locally that this does NOT happen right after account creation or after
-- any single onboarding step; it happens only once the setup wizard
-- redirects to `/event-types` (i.e. after finishing or skipping every
-- onboarding step: plan selection, calendar connect, etc). Running this
-- script before that point still safely updates the admin's brand
-- colors/hideBranding (steps 1, idempotent), but steps 2-5 touching
-- "EventType"/"Credential" will silently affect 0 rows until the wizard is
-- actually finished — re-run the script again once it is, no harm either
-- way.

BEGIN;

-- 1. Brand colors + "Disable Cal.com branding", for the admin user.
--    #4678F9 for both light and dark matches the single current `vcpeer`
--    design-system brand token (see branding/README.md "Brand color drift
--    vs. vcpeer" — vcpeer dropped its old light/dark split). Note: Cal.com's
--    own appearance-settings UI flags this exact value as failing its
--    button-contrast check in light mode (~3.98:1 vs the ~4.5:1 AA text
--    threshold it checks against) — confirmed by applying it through the
--    real UI locally. That warning is advisory only (the save still
--    succeeds, verified) and is not a bug in this script: #4678F9 is the
--    one brand blue the rest of the VCPeer suite renders today, so matching
--    it exactly is the correct call, not the contrast checker's stricter
--    preference.
UPDATE users
SET "hideBranding"   = true,
    "brandColor"     = '#4678F9',
    "darkBrandColor" = '#4678F9'
WHERE role = 'ADMIN';

-- 2. Jitsi Video conferencing app keys (App-wide, not per-user) — makes
--    every booking's auto-generated room a https://vcpeer.com/join/<uuid>
--    link instead of the upstream default meet.jit.si. See
--    branding/README.md "Video room integration" for the privacy-bug history
--    (a static shared link) this specifically avoids re-introducing.
UPDATE "App"
SET keys = jsonb_build_object('jitsiHost', 'https://vcpeer.com/join', 'jitsiPathPattern', '')
WHERE slug = 'jitsi';

-- 3. Install the Jitsi Video app as a credential for the admin (mirrors
--    Settings -> Conferencing -> Add -> Jitsi Video), if not already
--    installed.
INSERT INTO "Credential" (type, key, "userId", "appId")
SELECT 'jitsi_video', '{}'::jsonb, u.id, 'jitsi'
FROM users u
WHERE u.role = 'ADMIN'
  AND NOT EXISTS (
    SELECT 1 FROM "Credential" c WHERE c."userId" = u.id AND c."appId" = 'jitsi'
  );

-- 4. Point both public event types' Location at that Jitsi credential, so
--    every booking mints its own unique room (not a shared static link).
--    Unconditional UPDATE keyed to the admin's current credential id is
--    still idempotent: re-running converges to the same locations value
--    every time, it just doesn't skip the write when already correct.
UPDATE "EventType" et
SET locations = jsonb_build_array(
  jsonb_build_object('type', 'integrations:jitsi', 'credentialId', c.id)
)
FROM "Credential" c, users u
WHERE u.role = 'ADMIN'
  AND c."userId" = u.id AND c."appId" = 'jitsi'
  AND et."userId" = u.id
  AND et.slug IN ('15min', '30min');

-- 5. Public event type titles/descriptions — replaces Cal.com's generic
--    seed copy ("15 min meeting", no description) with the branded,
--    SEO-relevant copy already decided and applied once in production (see
--    branding/README.md "Event type titles/descriptions"). Re-applying here
--    means a fresh install or DR restore doesn't regress to the generic
--    seed text while someone remembers to run the one-off UPDATE again.
UPDATE "EventType" et
SET title = '15-Minute VCPeer Call',
    description = 'A quick 15-minute video call with the VCPeer team — ask questions or get set up fast. Joins a private VCPeer video room, no account needed.'
FROM users u
WHERE u.role = 'ADMIN' AND et."userId" = u.id AND et.slug = '15min';

UPDATE "EventType" et
SET title = '30-Minute VCPeer Call',
    description = 'Book a free 30-minute video call with the VCPeer team for a live walkthrough of VCPeer video calls, screen sharing, file transfer, and this scheduling tool. Joins a private VCPeer video room, no account needed.'
FROM users u
WHERE u.role = 'ADMIN' AND et."userId" = u.id AND et.slug = '30min';

COMMIT;

-- Verification (printed when run with `psql ... -f` or piped via stdin;
-- harmless no-op information, not required for the writes above).
\echo '--- Verification: admin branding ---'
SELECT username, "hideBranding", "brandColor", "darkBrandColor"
FROM users WHERE role = 'ADMIN';

\echo '--- Verification: Jitsi app keys ---'
SELECT slug, keys FROM "App" WHERE slug = 'jitsi';

\echo '--- Verification: event type titles + locations ---'
SELECT slug, title, locations FROM "EventType" WHERE slug IN ('15min', '30min');
