/**
 * Database adapter.
 *
 * The `DbClient` interface is the only adapter boundary application code
 * should depend on. The concrete implementation today is `PgLiteAdapter`
 * (in-process real PostgreSQL, WASM-compiled). A `pg`-driver adapter for
 * real PostgreSQL servers is planned but not yet implemented — see the
 * portability section in `worklog.md`.
 *
 * IMPORTANT limitations of the PgLite adapter (vs. a real PostgreSQL server):
 *   1. Single-process: there is exactly one connection. Multi-connection
 *      concurrency, `pg_advisory_lock`, and `SERIALIZABLE` contention
 *      behavior are NOT equivalent to a real server. Tests that pass under
 *      PgLite are NOT proof of real-server concurrency semantics. Real
 *      PostgreSQL integration tests are mandatory before production.
 *   2. Persistence: PgLite persists to a local directory. It is not a
 *      production datastore. Do not deploy PgLite as the production database
 *      on Netlify or any other host.
 *   3. Extensions: PgLite supports a curated set of extensions, not all of
 *      them. The migrations deliberately avoid extension dependencies
 *      (`gen_random_uuid()`, `btree_gist`, etc.) so they work under both
 *      PgLite and real PostgreSQL. UUIDs are generated application-side via
 *      `crypto.randomUUID()`.
 *
 * --- Turbopack asset handling (evidence-based, not a workaround) ---------
 * Next.js 16 + Turbopack treats the three PgLite artifacts
 * (`pglite.wasm`, `initdb.wasm`, `pglite.data`) as **static assets**: it
 * copies them to `.next/static/media/<name>.<hash>.<ext>` and gives PgLite
 * an HTTP path like `/_next/static/media/pglite.<hash>.data` instead of a
 * file path. PgLite's default loader then calls
 * `fs.promises.readFile(<http-url>)` which fails because there is no file
 * at that path on disk.
 *
 * PgLite's documented `PGliteOptions` interface exposes:
 *   - `pgliteWasmModule?: WebAssembly.Module`  — bypasses pglite.wasm URL load
 *   - `initdbWasmModule?: WebAssembly.Module` — bypasses initdb.wasm URL load
 *   - `fsBundle?: Blob | File`                 — bypasses pglite.data URL load
 *
 * These options exist **precisely** for environments where URL-based asset
 * loading doesn't work (bundlers, sandboxes, custom runtimes). The adapter
 * reads the three artifacts from disk via `fs.readFileSync` using a STRING
 * path (which always works — no URL involved) and passes them as the
 * documented options. This is the intended API, not a hack.
 *
 * The disk path is resolved from `process.cwd()` + `node_modules/.../dist`
 * because Turbopack's static analyzer cannot resolve subpath exports not
 * listed in the package's `exports` map (only the main entry is exposed).
 */

import { PGlite, type PGliteOptions } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { env, isTest } from "@/lib/env";
import { Err } from "@/lib/errors";
import { PgAdapter } from "@/lib/db/pg-adapter";

/** Resolve the PgLite package dist directory from `process.cwd()`. */
function resolvePgliteDistDir(): string {
  return join(process.cwd(), "node_modules", "@electric-sql", "pglite", "dist");
}

let cachedPgliteWasm: WebAssembly.Module | null = null;
let cachedInitdbWasm: WebAssembly.Module | null = null;
let cachedFsBundle: Blob | null = null;

/**
 * Pre-compile the WASM modules and read the emscripten filesystem bundle
 * from STRING file paths (no URLs), so PgLite's URL-based loader is
 * bypassed via the documented `pgliteWasmModule`, `initdbWasmModule`,
 * and `fsBundle` options. Cached for the process lifetime.
 */
function loadPgliteArtifacts(): PGliteOptions {
  const distDir = resolvePgliteDistDir();
  if (!cachedPgliteWasm) {
    cachedPgliteWasm = new WebAssembly.Module(readFileSync(join(distDir, "pglite.wasm")));
  }
  if (!cachedInitdbWasm) {
    cachedInitdbWasm = new WebAssembly.Module(readFileSync(join(distDir, "initdb.wasm")));
  }
  if (!cachedFsBundle) {
    // `pglite.data` is the emscripten filesystem bundle (~6.3MB). PgLite's
    // `fsBundle` option accepts a Blob; `r.fsBundle.arrayBuffer()` is called
    // internally instead of `getFsBundle(URL)`.
    const buf = readFileSync(join(distDir, "pglite.data"));
    // Copy into a fresh ArrayBuffer so the Blob owns the bytes (Node Buffers
    // may share their underlying buffer with the pool).
    const ab = new ArrayBuffer(buf.byteLength);
    new Uint8Array(ab).set(buf);
    cachedFsBundle = new Blob([ab]);
  }
  return {
    pgliteWasmModule: cachedPgliteWasm,
    initdbWasmModule: cachedInitdbWasm,
    fsBundle: cachedFsBundle,
  };
}

/** Normalized query result. */
export interface QueryResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount: number;
}

/** A transaction-scoped or top-level client. */
export interface TxClient {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}

/** Full database client: queries + transaction helpers. */
export interface DbClient extends TxClient {
  withTx<T>(fn: (tx: TxClient) => Promise<T>): Promise<T>;
  withTxSerializable<T>(fn: (tx: TxClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/**
 * Build PGlite options. Always passes the three pre-loaded artifacts to
 * bypass the URL-based loader. `PGLITE_DEBUG` (1-5) enables PgLite's
 * debug mode (Postgres stdout/stderr → console.debug/console.error).
 */
function buildPgliteOptions(): PGliteOptions {
  const opts: PGliteOptions = { ...loadPgliteArtifacts() };
  const debugRaw = process.env.PGLITE_DEBUG;
  if (debugRaw) {
    const debug = parseInt(debugRaw, 10);
    if (Number.isFinite(debug) && debug >= 1) {
      opts.debug = Math.min(Math.max(debug, 1), 5) as 1 | 2 | 3 | 4 | 5;
    }
  }
  return opts;
}

/** PgLite-backed adapter. */
class PgLiteAdapter implements DbClient {
  private readonly pg: PGlite;

  constructor(pg: PGlite) {
    this.pg = pg;
  }

  async query<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<QueryResult<T>> {
    try {
      const result = await this.pg.query(text, params);
      const rows = (result.rows ?? []) as T[];
      const affected = typeof result.affectedRows === "number" ? result.affectedRows : 0;
      const rowCount = rows.length > 0 ? rows.length : affected;
      return { rows, rowCount };
    } catch (err) {
      // Never leak SQL or params to clients. Throw a sanitized AppError.
      throw Err.upstream("Database query failed", err);
    }
  }

  async withTx<T>(fn: (tx: TxClient) => Promise<T>): Promise<T> {
    return this.runTx(fn, "READ COMMITTED");
  }

  async withTxSerializable<T>(fn: (tx: TxClient) => Promise<T>): Promise<T> {
    return this.runTx(fn, "SERIALIZABLE");
  }

  private async runTx<T>(fn: (tx: TxClient) => Promise<T>, isolation: "READ COMMITTED" | "SERIALIZABLE"): Promise<T> {
    await this.pg.query(`BEGIN ISOLATION LEVEL ${isolation}`, []);
    const txClient: TxClient = { query: (t, p = []) => this.query(t, p) };
    try {
      const result = await fn(txClient);
      await this.pg.query("COMMIT", []);
      return result;
    } catch (err) {
      try {
        await this.pg.query("ROLLBACK", []);
      } catch (rollbackErr) {
        console.error("rollback failed", rollbackErr);
      }
      throw err;
    }
  }

  async close(): Promise<void> {
    try {
      await this.pg.close();
    } catch {
      // ignore
    }
  }
}

let singleton: DbClient | null = null;

/**
 * Construct a DbClient from a PGlite instance. Used by tests to inject a
 * fresh in-memory PGlite; production uses `getDb()` which constructs a
 * singleton backed by `PGLITE_DATA_DIR`.
 */
export function createPgLiteAdapter(pg: PGlite): DbClient {
  return new PgLiteAdapter(pg);
}

/**
 * Returns true if `DATABASE_URL` is set to a real PostgreSQL connection
 * string (`postgres://` or `postgresql://`). Used to detect production
 * intent. Other values (e.g., leftover SQLite URLs from previous
 * scaffolding, empty strings) are treated as dev/test intent.
 */
function isPostgresUrl(s: string): boolean {
  if (!s) return false;
  const lower = s.toLowerCase();
  return lower.startsWith("postgres://") || lower.startsWith("postgresql://");
}

/**
 * Get the process-wide DbClient. Adapter selection:
 *
 *   1. If `TEST_DATABASE_URL` is set → use the `PgAdapter` (real
 *      PostgreSQL, for integration tests).
 *   2. If `DATABASE_URL` is a real PostgreSQL URL (`postgres://` or
 *      `postgresql://`) → use the `PgAdapter` (production).
 *   3. Otherwise → use the `PgLiteAdapter` (dev/test fallback).
 *
 * A real PostgreSQL URL NEVER silently falls back to PgLite. If the
 * `PgAdapter` is selected but the connection fails, the error propagates
 * as `UPSTREAM_ERROR` — it does NOT catch and fall back.
 *
 * PORTABILITY STATUS:
 *   - Both `PgAdapter` (real PostgreSQL via `pg`) and `PgLiteAdapter`
 *     (in-process PgLite) are implemented and implement the same
 *     `DbClient` interface.
 *   - Migrations and domain services use `DbClient` and work with either
 *     adapter.
 *   - Real PostgreSQL concurrency (SERIALIZABLE, FOR UPDATE) is verified
 *     only when `TEST_DATABASE_URL` is set and the integration tests run
 *     (see `tests/integration/pg/`). Without a real server, concurrency
 *     is NOT verified.
 */
export function getDb(): DbClient {
  if (singleton) return singleton;
  const e = env;

  // 1. Integration test path: TEST_DATABASE_URL takes precedence.
  const testDbUrl = process.env.TEST_DATABASE_URL;
  if (isPostgresUrl(testDbUrl ?? "")) {
    singleton = new PgAdapter(testDbUrl!);
    return singleton;
  }

  // 2. Production path: real PostgreSQL URL.
  if (isPostgresUrl(e.DATABASE_URL)) {
    singleton = new PgAdapter(e.DATABASE_URL);
    return singleton;
  }

  // 3. Dev/test fallback: PgLite.
  const dataDir = e.PGLITE_DATA_DIR || (isTest() ? "" : "");
  const pg = new PGlite(dataDir || undefined, buildPgliteOptions());
  singleton = new PgLiteAdapter(pg);
  return singleton;
}

/** Test-only: inject a custom DbClient. */
export function __setDbForTesting(client: DbClient | null): void {
  singleton = client;
}

/** Helper: escape nothing — we use parameterized queries everywhere. */
export function paramList(n: number): string {
  return Array.from({ length: n }, (_, i) => `$${i + 1}`).join(", ");
}
