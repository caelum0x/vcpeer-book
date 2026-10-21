#!/usr/bin/env bash
# VCPeer Book — apply the idempotent branding/config seed
# (deploy/apply-vcpeer-branding.sql) against a running Postgres container.
#
# Why this exists: the Jitsi conferencing setup, "Disable Cal.com branding",
# brand colors, and the 15min/30min title+description copy are all
# Postgres-row state, not env vars or files in this repo (see
# apply-vcpeer-branding.sql's own header for the full why). This wrapper adds
# the preconditions and a plain-English verification pass so running it is a
# single command instead of "remember which psql invocation and which four
# manual settings pages".
#
# Usage:
#   deploy/apply-vcpeer-branding.sh                       # uses defaults below
#   POSTGRES_CONTAINER=my-pg POSTGRES_DB=calcom deploy/apply-vcpeer-branding.sh
#
# Safe to run repeatedly — the underlying SQL is idempotent (see its header).
# Must run AFTER the ENTIRE /auth/setup + onboarding wizard finishes (not
# just after creating the admin account) — this script checks that an admin
# user exists and fails with a clear message if not, but the 15min/30min
# event types themselves aren't seeded until the wizard redirects to
# /event-types (verified locally: they don't exist yet right after account
# creation or after any single onboarding step). Running this script earlier
# is harmless (brand colors still get applied, Jitsi/EventType steps just
# affect 0 rows) — just re-run it once onboarding is done.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SQL_FILE="${SCRIPT_DIR}/apply-vcpeer-branding.sql"

POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-vcpeer-book-postgres}"
POSTGRES_USER="${POSTGRES_USER:-calcom}"
POSTGRES_DB="${POSTGRES_DB:-calcom}"

if [ ! -f "${SQL_FILE}" ]; then
  echo "ERROR: ${SQL_FILE} not found (expected next to this script)." >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: docker CLI not found on PATH." >&2
  exit 1
fi

if ! docker inspect -f '{{.State.Running}}' "${POSTGRES_CONTAINER}" 2>/dev/null | grep -q true; then
  echo "ERROR: container '${POSTGRES_CONTAINER}' is not running." >&2
  echo "  Check the name with: docker ps --filter name=postgres" >&2
  echo "  Override with: POSTGRES_CONTAINER=<name> $0" >&2
  exit 1
fi

ADMIN_COUNT="$(docker exec "${POSTGRES_CONTAINER}" psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" -tAc \
  "SELECT count(*) FROM users WHERE role = 'ADMIN';" 2>/dev/null || true)"

if [ -z "${ADMIN_COUNT}" ]; then
  echo "ERROR: could not query users table in '${POSTGRES_DB}' on '${POSTGRES_CONTAINER}'." >&2
  echo "  Is the calcom app container's first-boot migration finished? Check:" >&2
  echo "  docker logs ${POSTGRES_CONTAINER/postgres/calcom} --tail 50" >&2
  exit 1
fi

if [ "${ADMIN_COUNT}" -eq 0 ]; then
  echo "ERROR: no admin user exists yet (users.role = 'ADMIN' has 0 rows)." >&2
  echo "  Run the one-time setup wizard first: http://<host>:3000/auth/setup" >&2
  echo "  (see deploy/RUNBOOK.md section 2), then re-run this script." >&2
  exit 1
fi

if [ "${ADMIN_COUNT}" -gt 1 ]; then
  echo "WARNING: ${ADMIN_COUNT} admin users found — this script was written for" >&2
  echo "  the single-admin internal-tool setup this project documents" >&2
  echo "  (NEXT_PUBLIC_DISABLE_SIGNUP=true). It will apply branding to every" >&2
  echo "  admin row; double-check that's what you want before relying on it." >&2
fi

echo "Applying VCPeer Book branding/config to '${POSTGRES_DB}' on '${POSTGRES_CONTAINER}'..."
docker exec -i "${POSTGRES_CONTAINER}" psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" < "${SQL_FILE}"
echo "Done."
