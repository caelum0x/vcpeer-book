# VCPeer Book

Self-hosted scheduling/booking, re-skinned as VCPeer's booking product:
share a link, let people pick a free slot, every booking gets its own
unique video-call room (no shared-room privacy bug — each booking mints a
fresh UUID).

Composed from off-the-shelf OSS, not hand-written:
- [Cal.com / cal.diy](https://github.com/calcom/cal.diy) (MIT) — the
  booking application itself, run as the official Docker image, unmodified.
  `calcom/cal.com` on GitHub now redirects to `cal.diy`.
- This repo is deployment config, branding, and docs on top: `docker-compose.yml`
  (Postgres + Cal.com + Mailpit for local dev), env-var/in-app branding (see
  `branding/README.md` for exactly what's changed and how), and per-booking
  unique video rooms via Cal.com's built-in Jitsi Video conferencing app.

## Status

No longer under active feature development by the original team — open
sourced so others can fork, self-host, or build on it. Issues and PRs
welcome.

## Quick start (local)

```
cp .env.example .env
# fill in NEXTAUTH_SECRET, CALENDSO_ENCRYPTION_KEY (see .env.example for how)
docker-compose up -d
```

- Cal.com: http://localhost:3000
- Mailpit (dev-only SMTP capture): http://localhost:8025

## Branding

See `branding/README.md` for exactly what's rebranded (app name, email
From, brand color, "Powered by Cal.com" footer, privacy/terms links) and
how, plus `deploy/apply-vcpeer-branding.sh` — a reproducible seed script
for the parts of the branding that live in Postgres rather than env vars
(so a fresh install or disaster-recovery restore doesn't silently regress
to stock, unbranded defaults).

## Video rooms

Each event type's Location is Cal.com's built-in Jitsi Video app, configured
with `jitsiHost` pointed at a VCPeer call room base URL. Jitsi's own
`createMeeting()` hook mints a fresh UUID per booking, so two different
bookings of the same event type never land in the same room. See
`branding/README.md` ("Video room integration v2") for the full writeup.

## Deploy

See `deploy/RUNBOOK.md` for the production box procedure (Caddy site block,
Postgres backup/restore, rollback, upstream-image-check procedure, and the
Jitsi app-key setup steps).

## License

MIT, see `LICENSE`. The Cal.com / cal.diy application itself is licensed
separately (MIT) by its own authors; no Cal.com source is vendored here.
