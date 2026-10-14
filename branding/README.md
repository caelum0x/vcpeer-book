# VCPeer Book branding

Cal.com / **cal.diy** (MIT, github.com/calcom/cal.diy — `calcom/cal.com` now
redirects here) self-hosted, re-skinned as VCPeer's booking product. Every
change below is env-var or in-app-settings only — **no source was forked or
edited**, per the adoption rule (only clone source if branding needs go
beyond env/theming, which it didn't here).

## What's branded, and how

| What | How | Where |
|---|---|---|
| App name shown in page titles, emails, support links | `NEXT_PUBLIC_APP_NAME=VCPeer Book`, `NEXT_PUBLIC_COMPANY_NAME=VCPeer`, `NEXT_PUBLIC_SUPPORT_MAIL_ADDRESS=support@vcpeer.com` | `.env` |
| Outbound email From name/address | `EMAIL_FROM=bookings@vcpeer.com`, `EMAIL_FROM_NAME=VCPeer` | `.env` |
| Brand accent color on the public booking page (buttons, selected date) | Settings → My Account → Appearance → **Custom brand colors**: light `#2563EB`, dark `#4678F9` — the exact two colors used in `vcpeer/public/images/logo.svg` and `vcpeer/public/css/_tokens.css` (`--ds-brand-500`/the mark's blue circle) | In-app setting, stored in the `users` table — survives container restarts because it's in Postgres, not in the image |
| "Powered by Cal.com" footer on public booking pages | Settings → My Account → Appearance → **Disable Cal.com branding** → ON | Same in-app setting |
| Signups | `NEXT_PUBLIC_DISABLE_SIGNUP=true` in production (this is an internal team booking tool, not a public multi-tenant SaaS) | `.env` |

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

## Logo asset used

`branding/vcpeer-logo.svg` is a copy of `vcpeer/public/images/logo.svg` (two
overlapping circles, `#2563EB` + `#10B981`) kept here for reference/future
use if a proper fork ever replaces the Cal.com wordmark.
