# VCPeer Book branding

Cal.com / **cal.diy** (MIT, github.com/calcom/cal.diy — `calcom/cal.com` now
redirects here) self-hosted, re-skinned as VCPeer's booking product. Every
change below is env-var, in-app-settings, or a compiled-output string patch
run by the vendor's own tooling at container start (see "Privacy/Terms links
are hardcoded, not runtime-configurable" below for the one case that needed
that) — **no Cal.com source is forked or edited**, per the adoption rule
(only clone source if branding needs go beyond env/theming, which it hasn't
here).

## What's branded, and how

| What | How | Where |
|---|---|---|
| App name shown in page titles, emails, support links | `NEXT_PUBLIC_APP_NAME=VCPeer Book`, `NEXT_PUBLIC_COMPANY_NAME=VCPeer`, `NEXT_PUBLIC_SUPPORT_MAIL_ADDRESS=support@vcpeer.com` | `.env` |
| Outbound email From name/address | `EMAIL_FROM=bookings@vcpeer.com`, `EMAIL_FROM_NAME=VCPeer` | `.env` |
| Brand accent color on the public booking page (buttons, selected date) | Settings → My Account → Appearance → **Custom brand colors**: light `#4678F9`, dark `#4678F9` — matches the single current `vcpeer` brand token (see drift note below) | In-app setting, stored in the `users` table — survives container restarts because it's in Postgres, not in the image. **Reproducible via `deploy/apply-vcpeer-branding.sql`**, see "Reproducible branding seed" below. |
| "Powered by Cal.com" footer on public booking pages | Settings → My Account → Appearance → **Disable Cal.com branding** → ON | Same in-app setting; also reproducible via the seed script |
| Privacy policy / Terms of service links on the public booking form | `docker-compose.yml`'s `calcom` service `command:` (patches the compiled `.next` output at container start) — **env vars alone do NOT work**, see "Privacy/Terms links are hardcoded, not runtime-configurable" below | `docker-compose.yml` + `.env` |
| Signups | `NEXT_PUBLIC_DISABLE_SIGNUP=true` in production (this is an internal team booking tool, not a public multi-tenant SaaS) | `.env` |

## Reproducible branding seed (2026-10-22 follow-up)

Everything in the table above that lives in Postgres (brand colors,
"Disable Cal.com branding", the Jitsi Video app install + per-event-type
location, the 15min/30min title/description copy) was, until this pass, only
ever set by hand once — through the browser or a one-off `psql` command —
with nothing in git able to reproduce it. A fresh install, a
disaster-recovery restore onto an empty DB, or a second/staging environment
would all silently regress to stock, unbranded Cal.com defaults with no
signal anywhere that something was missing.

`deploy/apply-vcpeer-branding.sql` (and its wrapper,
`deploy/apply-vcpeer-branding.sh`, which adds container/precondition checks
and a plain-English verification summary) now applies all of that in one
idempotent pass: `deploy/apply-vcpeer-branding.sh`. Run it once after the
one-time `/auth/setup` admin wizard (or any time later to re-assert the
correct config). Verified locally end-to-end: perturbed every value back to
Cal.com's stock defaults (unhid branding, wrong colors, deleted the Jitsi
credential, reset event-type titles/locations), ran the script, confirmed
every value was restored, then ran it again to confirm it's a true no-op the
second time (no errors, no duplicate rows, same end state) — see the script's
own header for the exact mechanism per field.

## Privacy/Terms links are hardcoded, not runtime-configurable (found 2026-10-22)

`.env.example`/`.env` have carried
`NEXT_PUBLIC_WEBSITE_PRIVACY_POLICY_URL=https://vcpeer.com/privacy` since the
2026-10-21 pass, on the assumption that setting it would make the public
booking form's "Privacy Policy" link point at VCPeer's own page. **This does
not work** — verified by reproducing it locally, not just reading the code:

- The real booker-facing booking-confirmation form (`/<username>/<slug>`,
  right before the "Confirm" button) renders "Terms" and "Privacy Policy"
  links. Before this pass's fix, both resolved to **`https://cal.com/terms`**
  and **`https://cal.com/privacy`** — Cal.com's own legal pages, not VCPeer's
  — even with `NEXT_PUBLIC_WEBSITE_PRIVACY_POLICY_URL` correctly set and
  confirmed present inside the running container (`docker exec
  vcpeer-book-calcom printenv` showed the right value).
- Why: `packages/lib/constants.ts` in `calcom/cal.diy` computes
  `WEBSITE_PRIVACY_POLICY_URL = process.env.NEXT_PUBLIC_WEBSITE_PRIVACY_POLICY_URL
  || "https://cal.com/privacy"` — and Next.js inlines every
  `NEXT_PUBLIC_*` reference into the compiled `.next` output **at the image's
  own build time** (Cal.com's CI, when they built the `v6.2.0-arm` Docker Hub
  image), not read fresh from the container's environment at request time.
  Confirmed directly: `grep -rl 'cal.com/privacy'
  /calcom/apps/web/.next --include='*.js'` inside the running container
  matched 10 compiled chunk files (both server SSR chunks and client static
  chunks) containing the literal fallback string — this is dead config, not
  a live one, for any self-hoster pulling the prebuilt image.
- The fix: Cal.com's own `scripts/start.sh` (ships inside the image) already
  solves exactly this class of problem for one other var,
  `NEXT_PUBLIC_WEBAPP_URL`, by calling its own
  `scripts/replace-placeholder.sh FROM TO` — a vendor-provided tool that
  `sed`-patches every matching compiled `.next`/`public` file in place at
  container start, before the server starts serving. `docker-compose.yml`'s
  `calcom` service now overrides `command:` to call that exact same
  vendor script for `https://cal.com/privacy` →
  `$NEXT_PUBLIC_WEBSITE_PRIVACY_POLICY_URL`, then falls through to the
  unmodified `scripts/start.sh` for everything else (migrations, app-store
  seed, `yarn start`). **No Cal.com source is forked or edited** — only two
  already-compiled literal strings get swapped, using the vendor's own
  tool, the same way upstream already uses it for `NEXT_PUBLIC_WEBAPP_URL`.
- `NEXT_PUBLIC_WEBSITE_TERMS_URL` is deliberately left empty in `.env`
  (no terms-of-service page exists on `vcpeer.com` yet — same reasoning
  `.env.example` already documents) — the command is written to skip that
  replacement entirely when the var is empty, so the Terms link keeps
  pointing at Cal.com's real terms page rather than an empty/broken href.
  Fill in `NEXT_PUBLIC_WEBSITE_TERMS_URL` once `vcpeer.com/terms` exists and
  this starts working for Terms too, with zero further code changes.
- Verified end-to-end locally: perturbed the running container back to a
  fresh pull (no patch applied), confirmed the booking form showed
  `cal.com/privacy`; applied the `docker-compose.yml` change, recreated the
  container, confirmed (via a from-scratch browser profile — not just a
  cache-bypassed `fetch`, since Next.js serves `/_next/static/chunks/*.js`
  with long-lived immutable cache headers and a browser that had visited the
  unpatched page earlier in the same session will keep serving its own
  cached copy of the file even after the server-side content changes) that
  "Privacy Policy" now resolves to `https://vcpeer.com/privacy`. Also
  confirmed restart-idempotent: restarting the container re-runs the patch
  against already-patched files harmlessly (no matches left to replace, no
  error) and the container still reaches `healthy`.

## Brand color drift vs. `vcpeer` — re-checked 2026-10-21

The light/dark split above (`#2563EB` / `#4678F9`) was correct when set on
2026-10-15, sourced from `vcpeer/public/css/_tokens.css`'s `--ds-brand-500`
variable and `vcpeer/public/images/logo.svg`. Re-reading both files today
(cross-product consistency check) found the source has moved:

- `vcpeer/public/css/_tokens.css` now defines a **single**
  `--ds-brand-500: #4678f9` — no separate light-mode value, no
  `prefers-color-scheme` override anywhere in that file. `vcpeer` stopped
  splitting brand color by theme; `#4678f9` is simply *the* brand blue now,
  used across `whiteboard.css`, `login.css`, `landing.css`,
  `waitingRoom.css`, and `client.css`.
- `#2563EB` survives in exactly two places in `vcpeer`: the left circle of
  `public/images/logo.svg` (the two-tone mark — blue + `#10B981` green, a
  deliberate two-color logo choice, not a UI accent) and two files that
  haven't been migrated to the shared token system yet
  (`public/css/activeRooms.css`'s `--accent-hover`, and an inline
  `background: var(--color-primary, #2563eb)` fallback in
  `public/views/launchboard.html`).

**Net effect**: VCPeer Book's live light-mode accent (`#2563EB`) is one
shade off from what the rest of the VCPeer suite now renders
(`#4678F9`) in light mode; dark mode already matches. Correct fix (in-app
only, same as the original setup — no source change): Settings → My
Account → Appearance → Custom brand colors → set **both** light and dark to
`#4678F9`, matching the single current token. **Still not applied in
production** — requires an interactive admin login to
`https://book.vcpeer.com/auth/login` with real credentials, which this pass
didn't have either; see the main repo's `NOTES.md` and
`deploy/RUNBOOK.md` section 9. Applied and verified **locally** this pass
(2026-10-22) via `deploy/apply-vcpeer-branding.sql` — same value, same
mechanism, reproducible for the live box once access is back.

One thing to know before applying this live: Cal.com's own appearance
settings UI flags `#4678F9` as **failing its button-contrast check** in
light mode ("Light theme color doesn't pass contrast check. We recommend you
change this colour so your buttons will be more visible.") — confirmed by
setting it through the real local admin UI. Rough math backs this up:
`#4678F9` against white is ~3.98:1, under the ~4.5:1 WCAG AA threshold
Cal.com's checker wants for normal text (it clears the 3:1 AA threshold for
large text/UI components, just not the stricter one). This is advisory
only — the save still succeeds, confirmed — and is not a reason to deviate:
`#4678F9` is the one brand blue the rest of the VCPeer suite renders
everywhere today, so matching it exactly here is still the right call.
Flagging it so whoever applies this on the live box doesn't mistake the
warning for a failed save.

## What's NOT branded (known gap, honest callout)

The **"Cal.com" wordmark logo** in the top-left nav of the dashboard and the
"Cal.com" logo shown mid-screen in the onboarding/plan-selection modal are
static SVG/image assets baked into the Docker image
(`apps/web/public/cal-com-icon.svg` and friends in the source tree). Community
edition self-host does **not** expose an env var or admin-settings toggle to
replace this logo — that requires either:

1. An Enterprise/organization-tier "custom logo upload" feature (gated,
   not available on the free community edition used here), or
2. Forking `cal.diy` source and replacing the logo assets at build time,
   which means cloning the ~monorepo and building our own image — exactly
   the case the task said to avoid unless branding needs go beyond
   env/theming.

Decision: leave it for now. The booking pages attendees actually interact
with (the public `/username/event-slug` scheduler, the confirmation page,
and the confirmation email) show **zero** "Cal.com" text once "Disable
Cal.com branding" is on and the brand color is set — verified in
`/tmp/vcpeer-book-final-booking-page-*.png`. Only the internal
admin dashboard (which only the VCPeer team sees, never a customer) still
shows the stock wordmark. If this needs to go away too, the real fix is a
`docs/VCPEER-BOOK-FORK.md`-style plan to fork `cal.diy` properly (same
pattern as the already-planned `recoder` t3code/herdr forks) — not a quick
env change.

## Video room integration (the actual point of this adoption)

Every booking needs its confirmation to carry a VCPeer video-call room link,
and — this is the important part, fixed in the 2026-10-15 follow-up below —
**a different room per booking**, not one shared room strangers could walk
into.

### v1 (superseded): static "Link meeting" — had a privacy bug

The first pass used Cal.com's built-in **"Link meeting"** location type
(paste any URL as the meeting location) pointed at one fixed URL per event
type, e.g. `https://vcpeer.com/join/vcpeer-book-30min-9f2k`. **This was
wrong**: every booking of that event type shared the exact same room, so two
different attendees who booked two different time slots would land in the
same VCPeer room if their links ever got reused or compared — a real privacy
bug, not a cosmetic one. Superseded by the fix below; kept here only as the
rejected option for the record.

### v2 (current): Cal.com's built-in Jitsi conferencing app — per-booking unique room, still no fork

Cal.com ships a real conferencing **app** (not just a location type) called
**Jitsi Video** (`packages/app-store/jitsivideo`, MIT, part of the standard
v6.2.0 app-store catalog — confirmed by reading
`lib/VideoApiAdapter.ts` and `zod.ts` directly from the `calcom/cal.diy`
source on GitHub). Its `createMeeting()` hook already generates a **fresh
UUID per booking** and builds the URL as `${jitsiHost}/${meetingId}` — the
exact per-booking-unique mechanism we needed, and it ships in the box, no
forking required:

```ts
// packages/app-store/jitsivideo/lib/VideoApiAdapter.ts (upstream, unmodified)
const meetingPattern = appKeys.jitsiPathPattern || "{uuid}";
const hostUrl = appKeys.jitsiHost || "https://meet.jit.si/cal";
const meetingID = meetingPattern.replaceAll("{uuid}", uuidv4())...;
url: `${hostUrl}/${encodeURIComponent(meetingID)}`
```

**Exact steps taken (all in-app, zero source changes):**
1. Settings → My Account → Conferencing → **Add** → install "Jitsi Video"
   (App Store listing at `/apps/jitsi`).
2. Settings → Admin → Apps → Conferencing → **Jitsi Video → edit (pencil
   icon) → Edit keys**:
   - `jitsiHost` = `https://vcpeer.com/join`
   - `jitsiPathPattern` = *(left blank → defaults to `{uuid}`)*
   - Save → "Keys have been saved".
3. Per event type: Basics → Location → select **Jitsi Video** from the
   dropdown (it appears automatically once the app above is installed) →
   Save.

**Result:** every booking's location becomes
`https://vcpeer.com/join/<uuid-v4>` — a brand-new random room per booking,
generated server-side by Cal.com itself at booking time (so it's already
correct in the very first confirmation email, no webhook race).

**Verified live** (2026-10-15 follow-up, two independent bookings of the
same "30 min meeting" event type, from two separate browser contexts):

| Booking | Attendee | Room link (confirmation page + email, identical) |
|---|---|---|
| 1 | guest1@example.com | `https://vcpeer.com/join/76c797ff-dbfa-4622-9b0d-cfb1ca2822f3` |
| 2 | guest2@example.com | `https://vcpeer.com/join/c446f8ac-5ea7-42f3-a869-e7e3896c4fab` |
| 3 (mobile, 390×844) | guest3@example.com | `https://vcpeer.com/join/9e1d53ef-1716-46c7-a284-ca0b0a79fdce` |

Three bookings, three different rooms — confirmed both on the Cal.com
confirmation page (`Where: Jitsi Video ↗`, href `vcpeer.com/join/<uuid>`)
and in the Mailpit-captured confirmation emails (grepped the raw HTML for
each booking's distinct UUID).

### Does VCPeer's `/join/:roomId` actually accept a UUID slug?

Yes, verified directly against the live `vcpeer` source, not just read —
ran `Validate.isValidRoomName()` from `vcpeer/app/src/validate.js` in Node
against both UUIDs above: both return `true`. Reading the function confirms
why: it only rejects XSS-unsafe content (via DOMPurify) and path-traversal
sequences (`../`, etc.) — a lowercase-hex-and-dashes UUID trips neither
check, and Express's `app.get('/join/:roomId', ...)` route has no additional
character allowlist. **No change was needed in the `vcpeer` repo.** If a
future Cal.com version ever changes the default `jitsiPathPattern` to emit
characters VCPeer's validator does reject (e.g. a literal `/` or `..`), the
smallest fix would be in `vcpeer/app/src/validate.js`'s `hasPathTraversal`
allowlist, not in Cal.com — documented here so nobody goes looking for it in
the wrong repo.

### Why this is still "no fork"

`jitsiHost`/`jitsiPathPattern` are **app keys** — rows in Cal.com's own
`App` table, edited through its existing admin UI
(`/settings/admin/apps/conferencing`). This is the same category of change
as the brand-color settings above: in-app configuration, zero lines of
Cal.com source touched, zero rebuild.

**Room URL is hidden until after booking**, same as v1: the public
scheduling page shows "Jitsi Video" as the location but not the actual URL;
only the two parties with a confirmed booking see the real
`vcpeer.com/join/<uuid>` link, on the confirmation page and in their email.

## Event type titles/descriptions (distribution, 2026-10-21)

Both public event types (`admin/15min`, `admin/30min`) still had Cal.com's
seed defaults — `"15 min meeting"` / `"30 min meeting"`, empty description —
live in production a week after launch. Found while verifying SEO metadata
on the live page (`og:title` was literally `" 30 min meeting | VCPeer
Admin"`, no description at all). Generic seed copy on a public, SEO-indexed,
socially-shared booking link is a real distribution gap (nothing in the
title/share card says what VCPeer is or why to book), so this was fixed:

| Slug | Old title | New title | New description |
|---|---|---|---|
| `15min` | 15 min meeting | 15-Minute VCPeer Call | "A quick 15-minute video call with the VCPeer team — ask questions or get set up fast. Joins a private VCPeer video room, no account needed." |
| `30min` | 30 min meeting | 30-Minute VCPeer Call | "Book a free 30-minute video call with the VCPeer team for a live walkthrough of VCPeer video calls, screen sharing, file transfer, and this scheduling tool. Joins a private VCPeer video room, no account needed." |

Applied via a direct `UPDATE "EventType" SET title = ..., description = ...`
against the production Postgres container (same data the admin-UI "Event
Type → Basics" form would write — no source/schema change), **after** a
fresh `pg_dump -Fc` backup (see `deploy/RUNBOOK.md` section 5). Verified
live: both pages' `<title>`/`og:title` now show the new copy, and the
description renders in the page body for human visitors. One honest gap
found while verifying: cal.diy's `<meta name="description">` and
`og:description` always mirror the event title, not the `description`
field — so the longer copy above only reaches readers on the page itself
and isn't in the raw meta/share-card text. That's upstream behavior, not a
misconfiguration here.

The third, pre-existing event type (`secret`, "Secret meeting") is
Cal.com's own seeded demo type and is already `hidden = true` — not public,
left as-is.

## Logo asset used

`branding/vcpeer-logo.svg` is a copy of `vcpeer/public/images/logo.svg` (two
overlapping circles, `#2563EB` + `#10B981`) kept here for reference/future
use if a proper fork ever replaces the Cal.com wordmark.
