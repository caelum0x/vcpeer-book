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

Every booking needs its confirmation to carry a VCPeer video-call room link.
Cal.com ships a built-in **"Link meeting"** location type (no app install,
no custom code) that lets the event owner paste any URL as the meeting
location. We use VCPeer's real room-join route
(`app/src/server.js` → `app.get('/join/:roomId', ...)`, confirmed live in
the `vcpeer` repo) as the pattern:

```
https://vcpeer.com/join/<room-slug>
```

**Chosen method:** set the event type's Location to **Link meeting** with a
room URL like `https://vcpeer.com/join/vcpeer-book-30min-9f2k`. This is a
**per-event-type, persistent room** (generate the slug once when you create
the event type — e.g. `vcpeer-book-<event-slug>-<4-char-random>` — and never
reuse it for anything else), not a fresh random room per individual booking.

Why not per-booking dynamic rooms? Cal.com's only way to mint a brand-new
meeting URL on every booking is a **conferencing "app"** (the mechanism Zoom/
Google Meet/Daily.co use) with a `createMeeting()` handler that runs
server-side — which does not exist as an env/config option; it requires
writing and registering a new app package inside the Cal.com monorepo, i.e.
exactly the "goes beyond env/theming" case we're avoiding for this pass. A
webhook-based alternative (listen for `BOOKING_CREATED`, generate a room,
`PATCH` the booking's location via the Cal.com API) was considered and
rejected: the confirmation email is sent synchronously at booking time,
before any webhook-driven patch could land, so the email would still show
the old location — it doesn't actually solve "the confirmation email
contains the room link."

**What you get with the static Link-meeting approach** (verified live, see
`deploy/RUNBOOK.md` and the task screenshots):
- The attendee's confirmation page shows `Where: Link ↗` linking to the
  VCPeer room.
- The confirmation email (sent via SMTP, captured locally by Mailpit) shows
  `Where → Link → Meeting URL: https://vcpeer.com/join/vcpeer-book-30min-9f2k`.
- The organizer and attendee both land in the **same** VCPeer room for every
  booking of that event type — correct behavior for "my recurring 30-minute
  slot", same as how a Calendly/Cal.com user normally reuses one Zoom
  Personal Meeting Room across all their bookings.

**Known limitation:** two different attendees booking two different time
slots of the *same* event type would, if both showed up, land in the same
VCPeer room. For a single-organizer scheduling tool where slots don't
overlap (that's the whole point of availability-based booking) this is a
non-issue in practice. If VCPeer Book ever needs guaranteed-unique rooms per
booking (e.g. group/webinar event types with overlapping concurrent
attendees), the real fix is the conferencing-app path above — tracked as a
follow-up in `deploy/RUNBOOK.md`, not built here.

**Room URL is hidden until after booking** by design: the "Display on
booking page" checkbox under the Meeting link field is left unchecked, so
the VCPeer room URL is not exposed to anyone just browsing the public
scheduling page — only to the two parties who actually have a confirmed
booking (same privacy model as Cal Video's own default behavior).

## Logo asset used

`branding/vcpeer-logo.svg` is a copy of `vcpeer/public/images/logo.svg` (two
overlapping circles, `#2563EB` + `#10B981`) kept here for reference/future
use if a proper fork ever replaces the Cal.com wordmark.
