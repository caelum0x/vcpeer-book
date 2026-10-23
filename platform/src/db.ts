import { Pool, PoolClient } from "pg";
import fs from "fs";
import path from "path";

// Reuses the exact same Postgres credentials Cal.com itself uses
// (DATABASE_URL, same container/host) — this service is deployed alongside
// `calcom`/`postgres` in docker-compose.yml, not a separate database. All
// of this service's own tables live in the `platform` Postgres schema
// (see migrations.sql) and are never read or written by Cal.com itself.
const connectionString =
  process.env.DATABASE_URL ||
  `postgresql://${process.env.POSTGRES_USER || "calcom"}:${process.env.POSTGRES_PASSWORD}@${
    process.env.POSTGRES_HOST || "postgres"
  }:${process.env.POSTGRES_PORT || "5432"}/${process.env.POSTGRES_DB || "calcom"}`;

export const pool = new Pool({ connectionString, max: 10 });

export async function runMigrations(): Promise<void> {
  const sql = fs.readFileSync(path.join(__dirname, "migrations.sql"), "utf8");
  await pool.query(sql);
}

export async function query<T = any>(text: string, params: any[] = []): Promise<T[]> {
  const result = await pool.query(text, params);
  return result.rows as T[];
}

export async function queryOne<T = any>(text: string, params: any[] = []): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

/**
 * Runs `fn` inside a single BEGIN/COMMIT transaction on one checked-out
 * client, rolling back on any error. Required for onboarding.ts's
 * multi-statement Cal.com provisioning (Team + VerificationToken): without
 * this, a failure partway through leaves an orphaned Team row behind with
 * no VerificationToken pointing at it, which then collides with the next
 * retry's identical slug — caught live during this round's own
 * verification (see BUILD-LOG-2026-10-23.md).
 */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
