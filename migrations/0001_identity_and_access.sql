-- 0001_identity_and_access.sql
-- Foundation tables for identity, authentication, and academy membership.
-- All UUIDs are generated application-side (crypto.randomUUID) to avoid
-- depending on the pgcrypto extension. All status fields use text + CHECK
-- (not enum) to allow safe additive evolution.
--
-- DB-enforced invariants in this file:
--   - users.email UNIQUE
--   - user_credentials.user_id UNIQUE (1:1 with users)
--   - sessions.token_hash UNIQUE (lookup key — only the hash is stored)
--   - academy_memberships UNIQUE (user_id, academy_id, role)
--   - users.status, academy_memberships.role, academy_memberships.status CHECK
--   - users.failed_login_count >= 0
-- Domain-enforced (NOT DB-enforced) in this file: none — all identity
-- invariants are DB-level here. Authentication invariants (forced password
-- change enforcement, inactive-user rejection) are enforced in the
-- application domain layer (Phase 2) on top of these constraints.

CREATE TABLE academies (
    id           uuid         PRIMARY KEY,
    name         text         NOT NULL,
    slug         text         UNIQUE,
    timezone     text         NOT NULL DEFAULT 'Asia/Jakarta',
    is_active    boolean      NOT NULL DEFAULT true,
    created_at   timestamptz  NOT NULL DEFAULT now(),
    updated_at   timestamptz  NOT NULL DEFAULT now(),
    CHECK (name <> '')
);

CREATE TABLE users (
    id                    uuid         PRIMARY KEY,
    email                 text         NOT NULL,
    full_name             text,
    status                text         NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active', 'inactive', 'suspended')),
    must_change_password  boolean      NOT NULL DEFAULT false,
    failed_login_count    integer      NOT NULL DEFAULT 0,
    locked_until          timestamptz,
    last_login_at         timestamptz,
    last_pw_change_at     timestamptz,
    created_at            timestamptz  NOT NULL DEFAULT now(),
    updated_at            timestamptz  NOT NULL DEFAULT now(),
    UNIQUE (email),
    CHECK (failed_login_count >= 0),
    CHECK (email <> '')
);

CREATE TABLE user_credentials (
    user_id        uuid         PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    argon2id_hash  text         NOT NULL,
    argon2_params  jsonb        NOT NULL,
    updated_at     timestamptz  NOT NULL DEFAULT now(),
    CHECK (argon2id_hash <> '')
);

CREATE TABLE sessions (
    id              uuid         PRIMARY KEY,
    user_id         uuid         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- Only the SHA-256 hash of the opaque session token is stored.
    -- Lookup: hash(provided token) = token_hash.
    token_hash      text         NOT NULL UNIQUE,
    -- Absolute expiry; sliding expiry is enforced application-side.
    expires_at      timestamptz NOT NULL,
    -- Creation time is used for absolute-max-age enforcement (≤ 7d).
    created_at      timestamptz NOT NULL DEFAULT now(),
    -- Soft expiry/revocation: a row remains for audit; active = revoked_at IS NULL AND now() < expires_at.
    revoked_at      timestamptz,
    ip              text,
    user_agent      text,
    CHECK (token_hash <> '')
);

CREATE INDEX sessions_user_id_idx ON sessions(user_id) WHERE revoked_at IS NULL;
CREATE INDEX sessions_expires_idx ON sessions(expires_at);

CREATE TABLE academy_memberships (
    id           uuid         PRIMARY KEY,
    user_id      uuid         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    academy_id   uuid         NOT NULL REFERENCES academies(id) ON DELETE RESTRICT,
    role         text         NOT NULL
                 CHECK (role IN ('admin', 'coach', 'parent')),
    status       text         NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active', 'inactive')),
    created_at   timestamptz  NOT NULL DEFAULT now(),
    updated_at   timestamptz  NOT NULL DEFAULT now(),
    UNIQUE (user_id, academy_id, role)
);

CREATE INDEX academy_memberships_academy_idx ON academy_memberships(academy_id) WHERE status = 'active';
CREATE INDEX academy_memberships_user_idx ON academy_memberships(user_id) WHERE status = 'active';
