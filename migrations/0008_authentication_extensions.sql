-- 0008_authentication_extensions.sql
-- Adds the `login_attempts` table for DB-backed rate limiting.
--
-- Why DB-backed (not in-memory):
--   The user's Phase 2 brief explicitly requires rate limiting that "remains
--   effective across multiple serverless instances; do not rely solely on
--   in-memory counters." In-memory counters are per-process and do not
--   survive serverless instance recycling. The DB is the shared source of
--   truth across all instances.
--
-- CSRF tokens are NOT stored in the DB. CSRF uses a stateless HMAC-tied
-- double-submit pattern: `csrf_cookie = HMAC(session_token, CSRF_SECRET)`.
-- The server recomputes the HMAC from the session cookie and compares it to
-- both the CSRF cookie and the X-CSRF-Token header. This requires no DB
-- storage and is rotation-safe (the CSRF token changes whenever the session
-- token changes).
--
-- DB-enforced invariants:
--   - login_attempts.identifier_type CHECK enum
--   - Indexes on (identifier, attempted_at DESC) for fast rate-limit queries
--   - Index on (attempted_at) for periodic cleanup

CREATE TABLE login_attempts (
    id              uuid         PRIMARY KEY,
    -- The identifier being rate-limited: a lowercased email or an IP address.
    identifier      text         NOT NULL,
    -- 'email' or 'ip' — allows different thresholds per type if needed.
    identifier_type text         NOT NULL
                    CHECK (identifier_type IN ('email', 'ip')),
    attempted_at    timestamptz  NOT NULL DEFAULT now(),
    succeeded       boolean      NOT NULL DEFAULT false,
    -- The IP and user-agent are recorded for audit/security review only;
    -- they are NOT used for rate-limit keys (the identifier column is).
    ip              text,
    user_agent      text
);

-- Fast lookup: "how many attempts for this identifier in the last N minutes?"
CREATE INDEX login_attempts_identifier_time_idx
    ON login_attempts(identifier, attempted_at DESC);

-- Fast cleanup: "delete all rows older than N days"
CREATE INDEX login_attempts_cleanup_idx
    ON login_attempts(attempted_at);
