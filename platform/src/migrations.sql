-- VCPeer Book Platform — own Postgres schema, additive only.
--
-- Lives in the SAME Postgres database/container as Cal.com (connects with
-- the same DATABASE_URL credentials already in /etc/products/vcpeer-book.env)
-- but in its own `platform` schema, so it never collides with or alters any
-- Cal.com/Prisma-managed table (those are all in the `public` schema, no
-- schema prefix). Every statement is idempotent (CREATE ... IF NOT EXISTS) —
-- safe to run on every service boot.

CREATE SCHEMA IF NOT EXISTS platform;

-- One row per self-serve tenant signup (item 1: self-serve signup wizard).
-- status lifecycle: pending_signup -> provisioning -> active | abandoned
CREATE TABLE IF NOT EXISTS platform.orgs (
  id               BIGSERIAL PRIMARY KEY,
  slug             TEXT NOT NULL UNIQUE,
  email            TEXT NOT NULL,
  plan             TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro')),
  requested_event_type TEXT NOT NULL DEFAULT 'demo_30',
  status           TEXT NOT NULL DEFAULT 'pending_signup'
                     CHECK (status IN ('pending_signup', 'provisioning', 'active', 'abandoned')),
  calcom_team_id   INTEGER,
  calcom_user_id   INTEGER,
  invite_token     TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  activated_at     TIMESTAMPTZ
);

-- Per-org feature flags (owner decision 2026-10-27: VCPeer is free for
-- everyone, no more billing - custom domain + white-label now default on
-- for every org; routes/domains.ts and routes/billing.ts no longer read
-- these two columns to gate anything, they're kept only as a record).
CREATE TABLE IF NOT EXISTS platform.feature_flags (
  org_id                  BIGINT PRIMARY KEY REFERENCES platform.orgs(id) ON DELETE CASCADE,
  custom_domain_enabled   BOOLEAN NOT NULL DEFAULT true,
  white_label_enabled     BOOLEAN NOT NULL DEFAULT true,
  dodo_customer_id        TEXT,
  dodo_subscription_id    TEXT,
  subscription_status     TEXT NOT NULL DEFAULT 'none'
                            CHECK (subscription_status IN ('none', 'active', 'past_due', 'cancelled')),
  logo_url                TEXT,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Custom-domain provisioning state (item 4).
CREATE TABLE IF NOT EXISTS platform.domains (
  id            BIGSERIAL PRIMARY KEY,
  org_id        BIGINT NOT NULL REFERENCES platform.orgs(id) ON DELETE CASCADE,
  domain        TEXT NOT NULL UNIQUE,
  cf_record_id  TEXT,
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'dns_created', 'propagated', 'live', 'failed')),
  last_error    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Booking-funnel analytics events (item 5).
-- event_type: page_view | slot_selected | booking_confirmed | booking_cancelled | call_joined
CREATE TABLE IF NOT EXISTS platform.analytics_events (
  id              BIGSERIAL PRIMARY KEY,
  event_type      TEXT NOT NULL,
  event_type_slug TEXT,
  tenant_slug      TEXT,
  session_id      TEXT,
  booking_uid     TEXT,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS analytics_events_event_type_idx ON platform.analytics_events (event_type);
CREATE INDEX IF NOT EXISTS analytics_events_created_at_idx ON platform.analytics_events (created_at);
CREATE INDEX IF NOT EXISTS analytics_events_booking_uid_idx ON platform.analytics_events (booking_uid);

-- Raw Cal.com webhook delivery log (item 6), for debugging/replay.
CREATE TABLE IF NOT EXISTS platform.webhook_log (
  id              BIGSERIAL PRIMARY KEY,
  source          TEXT NOT NULL, -- 'calcom' | 'dodo' | 'vcpeer'
  trigger_event   TEXT,
  payload         JSONB NOT NULL,
  processed_ok    BOOLEAN NOT NULL DEFAULT false,
  error           TEXT,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Booking lifecycle tracking for no-show detection + recovery + review
-- requests (item 6 + item 12). Populated from Cal.com's BOOKING_CREATED
-- webhook, updated by BOOKING_CANCELLED/RESCHEDULED and by the vcpeer.com
-- room-join beacon (item 6's /webhooks/vcpeer-join endpoint).
CREATE TABLE IF NOT EXISTS platform.bookings_tracked (
  booking_uid       TEXT PRIMARY KEY,
  event_type_slug   TEXT,
  attendee_email    TEXT,
  organizer_email   TEXT,
  start_time        TIMESTAMPTZ,
  end_time          TIMESTAMPTZ,
  status            TEXT NOT NULL DEFAULT 'created'
                      CHECK (status IN ('created', 'cancelled', 'rescheduled', 'completed', 'no_show')),
  joined_at         TIMESTAMPTZ,
  no_show_notified_at TIMESTAMPTZ,
  recovery_sent_at  TIMESTAMPTZ,
  review_requested_at TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bookings_tracked_start_time_idx ON platform.bookings_tracked (start_time);

-- API keys for the public REST API layer (item 9) + the embeddable widget
-- (item 8, which uses a restricted "widget" scope key).
CREATE TABLE IF NOT EXISTS platform.api_keys (
  id            BIGSERIAL PRIMARY KEY,
  key_hash      TEXT NOT NULL UNIQUE,
  label         TEXT NOT NULL,
  scope         TEXT NOT NULL DEFAULT 'full' CHECK (scope IN ('full', 'widget')),
  org_id        BIGINT REFERENCES platform.orgs(id) ON DELETE CASCADE,
  rate_limit_per_min INTEGER NOT NULL DEFAULT 60,
  revoked       BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ
);
