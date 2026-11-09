# ActiveKids Academy

ActiveKids Academy is a Next.js application. It uses its own authentication
system and can use Supabase as its PostgreSQL database; Supabase Auth and
Supabase API keys are not required.

## Run locally with Supabase

These steps use PowerShell on Windows. Use a dedicated Supabase development
project, especially before running migrations or seed data.

### 1. Install prerequisites and dependencies

Install [Bun](https://bun.sh/) and Git, then open PowerShell in the repository:

```powershell
bun --version
git --version
bun install --frozen-lockfile
```

### 2. Create a Supabase project and get its connection string

Create a project in Supabase and wait for it to finish provisioning. In the
project dashboard, open **Connect** and copy the PostgreSQL **Session pooler**
connection string (port `5432`). The session pooler is suitable for the app's
database sessions and transactions.

Use the connection string supplied by Supabase. It should start with
`postgresql://` and include your project's database password. If that password
contains reserved URL characters, use the URL-encoded password in the URI.
Keep this URI private.

### 3. Create and configure `.env`

Copy the example environment file and open it for editing:

```powershell
Copy-Item .env.example .env
code .env
```

Set at least these values in `.env`:

```dotenv
NODE_ENV=development
DATABASE_URL=postgresql://postgres.<project-ref>:<url-encoded-password>@<session-pooler-host>:5432/postgres?sslmode=require
SESSION_SECRET=<unique-random-secret-at-least-32-characters>
CSRF_SECRET=<different-unique-random-secret-at-least-32-characters>
INITIAL_ADMIN_EMAIL=admin@example.com
ACADEMY_TIMEZONE=Asia/Jakarta
DB_POOL_MAX=5
```

Replace the example `DATABASE_URL` with the full URI from your Supabase
dashboard. Generate two separate random secrets (this PowerShell command prints
two 64-character hexadecimal values):

```powershell
$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
1..2 | ForEach-Object {
  $bytes = New-Object byte[] 32
  $rng.GetBytes($bytes)
  [BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant()
}
$rng.Dispose()
```

```terminal
openssl rand -hex 32
openssl rand -hex 32
```

Use one generated value for each secret. Leave `TEST_DATABASE_URL` empty; it is
for tests and takes precedence over `DATABASE_URL` when set. Do not put
Supabase credentials in `NEXT_PUBLIC_*` variables. `.env` is ignored by Git.

### 4. Apply the database migrations

First check which migrations are pending, then apply them:

```powershell
bun run db:migrate:status
bun run db:migrate
```

The migration runner applies the numbered SQL files in `migrations/` to the
database selected by `DATABASE_URL` and records their checksums in
`schema_migrations`. Run this against a new or otherwise appropriate
development database: migrations create the app schema and are not a process
for adopting an existing, unrelated schema.

### 5. Add the starter data

Seed the default academy, classes, schedules, and package plans:

```powershell
bun run db:seed
```

This is needed before creating the first admin because the admin belongs to the
seeded default academy. The seed is idempotent, but it does write data, so only
run it against a project where this starter data is wanted. Skip it if you are
intentionally connecting to an existing app database that is already set up.

### 6. Create the first admin account

Confirm `INITIAL_ADMIN_EMAIL` is set in `.env`, then run:

```powershell
bun run provision-admin
```

Enter an initial password when prompted. It is not echoed in the terminal.
The configured `INITIAL_ADMIN_EMAIL` is treated as the super admin and can
sign in directly with this password. Keep that value set in `.env` while
running the app. Other provisioned accounts are still required to change
their initial password.

Provisioning does not replace the password for an existing account. To
intentionally reset the configured admin's password, use the explicit reset
mode; it prompts twice without echoing the password, clears that account's
login lockout, and revokes its active sessions:

```powershell
bun run --bun scripts/provision-admin.ts --reset-password
```

### 7. Start the app

```powershell
bun run dev
```

Open [http://localhost:3001/domain](http://localhost:3001/domain) for the public
landing page. Sign in at [http://localhost:3001/admin](http://localhost:3001/admin).
The other dashboard routes are `/parent` and `/coach`. Keep the terminal
running while you use the app; press `Ctrl+C` to stop it.

## Customize the public pages

The public landing page is `/domain`; the public coach profiles are at
`/coaches`. The protected coach dashboard remains at `/coach`.

Use [`src/config/public-site.ts`](./src/config/public-site.ts) for placeholder
brand assets and content: set `logo.image` and `logo.imageAlt`, replace the
Unsplash URLs with academy photos, update the three sample coach profiles and
training video thumbnails, and fill in the contact, social-link, and YouTube
video ID fields. Leave video IDs empty until real videos are available.

Published CMS content takes precedence for editable landing details such as
the hero, programs, schedules, coaches, location, contact information, gallery,
and videos. Update those through the admin website-content tools and publish
the page; the public pages only read published snapshots. The local config
provides visibly identified preview content when no published page exists.

## Troubleshooting

- **It is not using Supabase:** Check that `.env` is in the repository root and
  `DATABASE_URL` starts with `postgres://` or `postgresql://`. Without a valid
  PostgreSQL URL, development uses embedded PgLite instead.
- **DNS or network error with Supabase:** If `DATABASE_URL` uses a host like
  `db.<project-ref>.supabase.co`, it is the direct database endpoint, which
  may require IPv6. In the Supabase dashboard, open **Connect**, choose
  **Session pooler** (port `5432`), and replace `DATABASE_URL` with that full
  connection URI. Do not use the direct endpoint or the transaction pooler for
  this local setup.
- **The database connection fails:** Re-copy the Session pooler URI from the
  Supabase dashboard, check that its password is current and URL-encoded, and
  ensure your network can reach the pooler. Supabase TLS is detected
  automatically; `sslmode=require` may also be included in the URI.
- **Admin provisioning says to seed the database:** Run `bun run db:seed`
  against the same database URL, then retry provisioning.
- **A migration fails:** Check the connection with
  `bun run db:migrate:status` and confirm this is the intended development
  database. Do not manually edit already-applied migration files; the runner
  checks their checksums.

## More documentation

- [Deployment guide](./docs/deployment.md)
- [Local Docker guide](./docs/docker-local.md)
