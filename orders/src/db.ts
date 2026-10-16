import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';

export const PG_POOL = Symbol('PG_POOL');

export const createPool = (connectionString: string) => new pg.Pool({ connectionString, max: 10 });

/** Run `fn` in a transaction, committing on success and rolling back on any error. */
export async function tx<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Applies migrations/*.sql in name order, once each. An advisory lock means
 * several replicas starting together cannot run the same migration twice.
 */
export async function migrate(pool: pg.Pool, dir: string): Promise<string[]> {
  return tx(pool, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(4242)');
    await c.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Set((await c.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    const applied: string[] = [];
    for (const name of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
      if (done.has(name)) continue;
      await c.query(await readFile(join(dir, name), 'utf8'));
      await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
      applied.push(name);
    }
    return applied;
  });
}
