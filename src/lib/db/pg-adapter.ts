/**
 * PostgreSQL adapter — implements the `DbClient` interface using the `pg`
 * (node-postgres) driver against a real PostgreSQL server.
 *
 * Design:
 *   - Uses `pg.Pool` for connection management.
 *   - `query()`: delegates to `pool.query()` (auto-connect + release).
 *   - `withTx()` / `withTxSerializable()`: checks out a dedicated client
 *     from the pool, issues BEGIN/COMMIT/ROLLBACK on that client, and
 *     releases it when done. The `fn` callback receives a `TxClient` that
 *     delegates to the checked-out client — all queries within the
 *     transaction run on the SAME connection.
 *   - `close()`: ends the pool (`pool.end()`). After close, the adapter
 *     is unusable.
 *
 * Error handling:
 *   - PostgreSQL errors (`pg.DatabaseError` with SQLSTATE) are classified
 *     via `classifyPgError()` into safe `AppError` instances. The original
 *     error is stored in `serverCause` for server-side logging. Client-facing
 *     messages are generic — never revealing SQLSTATE, table, or constraint.
 *   - No automatic retry. Serialization failures (40001) and deadlocks
 *     (40P01) propagate as retryable CONFLICT errors.
 *
 * Transaction semantics:
 *   - SERIALIZABLE isolation is set via `BEGIN ISOLATION LEVEL SERIALIZABLE`.
 *     Under real PostgreSQL, this provides actual serializable isolation
 *     (concurrent transactions that conflict will abort with 40001).
 *   - ROLLBACK is best-effort: if ROLLBACK fails, the original error is
 *     re-thrown (the connection is released back to the pool in a
 *     potentially-dirty state; `pg.Pool` will reset it).
 *
 * Server-only. Never import from client code.
 */

import { Pool, type PoolClient, type QueryResult as PgQueryResult, types as pgTypes } from "pg";
import type { DbClient, QueryResult, TxClient } from "@/lib/db";
import { classifyPgError } from "@/lib/db/pg-errors";
import { Err, AppError } from "@/lib/errors";

/**
 * Configure the pg driver to return DATE columns as strings (not Date
 * objects) to avoid timezone-dependent conversion. PostgreSQL DATE
 * represents calendar dates (no timezone); returning the raw string
 * preserves the exact value. OID 1082 = DATE.
 *
 * This uses the global `pg.types` registry. This is safe for this
 * application because the `PgAdapter` is the ONLY `pg` consumer —
 * there are no other `pg.Pool` instances or direct `pg` connections.
 * The parser only affects DATE (OID 1082); all other types (including
 * TIMESTAMPTZ) are unaffected.
 *
 * A pool-scoped `TypeOverrides` would be more isolated, but the `pg`
 * package does not export the `TypeOverrides` class from its main entry
 * point. Using the global registry is the standard approach for single-
 * consumer applications.
 */
pgTypes.setTypeParser(1082, (val: string) => val);

/** PostgreSQL-backed adapter implementing the `DbClient` interface. */
export class PgAdapter implements DbClient {
  private readonly pool: Pool;

  constructor(connectionString: string, poolMax?: number) {
    const max = poolMax ?? (Number(process.env.DB_POOL_MAX) || 10);
    this.pool = new Pool({
      connectionString,
      // Configurable via DB_POOL_MAX env var (default 10 for local dev).
      // Set to 1 for serverless: each function instance handles one request;
      // multiple instances scale horizontally. Prevents connection exhaustion
      // when many serverless instances each create a pool.
      max,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
  }

  async query<T = Record<string, unknown>>(
    text: string,
    params: unknown[] = [],
  ): Promise<QueryResult<T>> {
    try {
      const result: PgQueryResult = await this.pool.query(text, params as never[]);
      const rows = (result.rows ?? []) as T[];
      const rowCount =
        rows.length > 0 ? rows.length : (result.rowCount ?? 0);
      return { rows, rowCount };
    } catch (err) {
      throw classifyPgError(err);
    }
  }

  async withTx<T>(fn: (tx: TxClient) => Promise<T>): Promise<T> {
    return this.runTx(fn, "READ COMMITTED");
  }

  async withTxSerializable<T>(fn: (tx: TxClient) => Promise<T>): Promise<T> {
    return this.runTx(fn, "SERIALIZABLE");
  }

  private async runTx<T>(
    fn: (tx: TxClient) => Promise<T>,
    isolation: "READ COMMITTED" | "SERIALIZABLE",
  ): Promise<T> {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
      const txClient: TxClient = {
        query: <T2 = Record<string, unknown>>(
          text: string,
          params: unknown[] = [],
        ): Promise<QueryResult<T2>> => {
          return client
            .query(text, params as never[])
            .then((result: PgQueryResult) => {
              const rows = (result.rows ?? []) as T2[];
              const rowCount =
                rows.length > 0 ? rows.length : (result.rowCount ?? 0);
              return { rows, rowCount };
            })
            .catch((err: unknown) => {
              throw classifyPgError(err);
            });
        },
      };

      const result = await fn(txClient);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      // ROLLBACK — best effort. If ROLLBACK itself fails, log it but
      // re-throw the ORIGINAL error (not the rollback error).
      try {
        await client.query("ROLLBACK");
      } catch (rollbackErr) {
        console.error("rollback failed", rollbackErr);
      }

      // If the error is already an AppError (classified by our txClient
      // query wrapper), re-throw it as-is. Otherwise, classify it.
      if (err instanceof AppError) {
        throw err;
      }
      throw classifyPgError(err);
    } finally {
      // Always release the client back to the pool. `pg.Pool` will
      // reset the connection state if needed.
      client.release();
    }
  }

  async close(): Promise<void> {
    try {
      await this.pool.end();
    } catch {
      // ignore — closing is best-effort
    }
  }
}
