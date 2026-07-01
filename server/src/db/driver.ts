/**
 * AegisLink — DB driver (backend detection + query dispatch)
 *
 * Extracted from db/client.ts (M4 god-file split). Routes every query to the
 * active backend: PostgreSQL when DATABASE_URL is a postgres:// URL, otherwise
 * the default node:sqlite handle. Pure relocation — no logic changes.
 */

import { getSqlite } from './sqlite';
import { getPool } from './pg';

const DATABASE_URL = process.env.DATABASE_URL ?? '';
export const USE_PG = DATABASE_URL.startsWith('postgres://') || DATABASE_URL.startsWith('postgresql://');

type SqlParam = null | number | bigint | string | Uint8Array;

function toSqlParams(params: unknown[]): SqlParam[] {
  return params as SqlParam[];
}

function toPgParams(params: unknown[]): unknown[] {
  return params;
}

export async function dbRun(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
  if (USE_PG) {
    let i = 0;
    const pgSql = sql.replace(/\?/g, () => `$${++i}`);
    const result = await getPool().query(pgSql, toPgParams(params));
    return { changes: result.rowCount ?? 0 };
  } else {
    const stmt = getSqlite().prepare(sql);
    const result = stmt.run(...toSqlParams(params)) as { changes: number };
    return result;
  }
}

export async function dbAll<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  if (USE_PG) {
    let i = 0;
    const pgSql = sql.replace(/\?/g, () => `$${++i}`);
    const result = await getPool().query(pgSql, toPgParams(params));
    return result.rows as T[];
  } else {
    const stmt = getSqlite().prepare(sql);
    return stmt.all(...toSqlParams(params)) as unknown as T[];
  }
}

export async function dbGet<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
  if (USE_PG) {
    let i = 0;
    const pgSql = sql.replace(/\?/g, () => `$${++i}`);
    const result = await getPool().query(pgSql, toPgParams(params));
    return result.rows[0] as T | undefined;
  } else {
    const stmt = getSqlite().prepare(sql);
    return stmt.get(...toSqlParams(params)) as unknown as T | undefined;
  }
}

// PG-specific: run multiple statements in a transaction, consuming an OPK atomically.
export async function pgPopOpk(aegisId: string, deviceId = 'default'): Promise<{ key_id: number; public_key_b64: string } | undefined> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const sel = await client.query(
      `SELECT key_id, public_key_b64 FROM prekeys_onetime WHERE aegis_id = $1 AND device_id = $2 ORDER BY key_id ASC LIMIT 1 FOR UPDATE SKIP LOCKED`,
      [aegisId, deviceId]
    );
    if (sel.rows.length === 0) {
      await client.query('COMMIT');
      return undefined;
    }
    const opk = sel.rows[0] as { key_id: number; public_key_b64: string };
    await client.query(
      `DELETE FROM prekeys_onetime WHERE aegis_id = $1 AND device_id = $2 AND key_id = $3`,
      [aegisId, deviceId, opk.key_id]
    );
    await client.query('COMMIT');
    return opk;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
