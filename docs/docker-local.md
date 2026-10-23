# Panduan Docker Lokal — Futsal Academy Management System

Panduan ini menjelaskan cara menjalankan aplikasi secara lokal menggunakan Docker dengan database PostgreSQL nyata. Cocok untuk pengujian manual sebelum deploy ke Netlify.

## Prasyarat

- Docker Engine (versi 20+)
- Docker Compose (versi 2+)

Verifikasi:
```bash
docker --version
docker compose version
```

## Langkah 1: Buat File `.env.docker`

Buat file `.env.docker` di root proyek dengan konten berikut. Ganti nilai secrets dengan yang Anda buat sendiri.

```bash
# .env.docker — JANGAN COMMIT file ini (sudah di-gitignore via .env*)

# PostgreSQL container credentials: choose a URL-safe local password.
POSTGRES_USER=futsal
POSTGRES_PASSWORD=replace_with_a_local_database_password
POSTGRES_DB=futsal_academy

# Database PostgreSQL (connection to Compose service 'db')
DATABASE_URL=postgresql://futsal:replace_with_a_local_database_password@db:5432/futsal_academy?sslmode=disable

# Auth secrets — WAJIB ≥32 karakter. Generate dengan: openssl rand -hex 32
# JANGAN gunakan placeholder "replace_with_random_64_hex_chars" (ditolak di production).
SESSION_SECRET=<generate_dengan_openssl_rand_hex_32>
CSRF_SECRET=<generate_dengan_openssl_rand_hex_32>

# Environment
NODE_ENV=production
ACADEMY_TIMEZONE=Asia/Jakarta

# Database pool (untuk Docker lokal, bukan serverless)
DB_POOL_MAX=5

# PgLite — tidak digunakan ketika DATABASE_URL di-set. Biarkan kosong.
PGLITE_DATA_DIR=
```

Generate secrets:
```bash
openssl rand -hex 32  # untuk SESSION_SECRET
openssl rand -hex 32  # untuk CSRF_SECRET
```

## Mode Development: Hot Reload

Development memakai PostgreSQL container yang sama, bind mount source workspace, dan volume `/app/node_modules` terpisah. Saat container app mulai, `bun install --frozen-lockfile` menyelaraskan dependency dalam volume; restart app setelah mengubah `package.json` atau `bun.lock`. Salin `.env.example` ke `.env.docker`; set `POSTGRES_PASSWORD`, samakan password di `DATABASE_URL`, dan ganti kedua secret dengan nilai acak minimal 32 karakter. File lokal `.env.docker` tidak ikut Docker build context.

```bash
docker compose --env-file .env.docker -f docker-compose.yml -f docker-compose.dev.yml config --quiet
docker compose --env-file .env.docker -f docker-compose.yml -f docker-compose.dev.yml up -d --build
docker compose --env-file .env.docker -f docker-compose.yml -f docker-compose.dev.yml exec app bun run db:migrate
docker compose --env-file .env.docker -f docker-compose.yml -f docker-compose.dev.yml exec app bun run db:seed
```

Akses `http://localhost:3000`. Perubahan source dari workspace lokal terpantau Next.js. PostgreSQL menggunakan named volume `futsal_academy_pg_data`; host port hanya terikat ke `127.0.0.1:5432`.

## Mode Production-like: Build Docker Image



```bash
docker compose --env-file .env.docker build
```

Build pertama akan memakan waktu beberapa menit (install dependencies + `next build`).

## Langkah 3: Jalankan PostgreSQL + Aplikasi

```bash
docker compose --env-file .env.docker up -d
```

Perintah ini:
1. Memulai PostgreSQL (dengan health check)
2. Menunggu PostgreSQL siap
3. Memulai aplikasi Next.js

Cek status:
```bash
docker compose --env-file .env.docker ps
```

## Langkah 4: Jalankan Migrasi Database

```bash
docker compose --env-file .env.docker exec app bun run db:migrate
```

Ini menjalankan seluruh file migrasi SQL yang belum diterapkan (schema, index, constraint, dan kebijakan attendance).

## Langkah 5: (Opsional) Jalankan Seed Data

```bash
docker compose --env-file .env.docker exec app bun run db:seed
```

Membuat data contoh: akademi, kelas (Semangat, Membara), paket (4 sesi, 8 sesi), jadwal.

## Langkah 6: Buat Admin Pertama

Atur `INITIAL_ADMIN_EMAIL` di `.env.docker`, lalu jalankan dari terminal interaktif:

```bash
docker compose --env-file .env.docker exec -it app bun run provision-admin
```

Password diminta tanpa echo. Script harus diarahkan ke PostgreSQL Compose dan hanya berjalan setelah migration serta seed berhasil. User yang sudah ada tidak akan diganti password-nya.

## Langkah 7: Buka Aplikasi di Browser

Buka: **http://localhost:3000**

Anda akan melihat:
- Halaman landing publik (atau "Halaman akademi segera hadir" jika belum publish)
- Tombol "Masuk" untuk login admin

Login dengan email + password yang Anda buat di Langkah 6.

## Melihat Log Aplikasi

```bash
# Log aplikasi (real-time)
docker compose --env-file .env.docker logs -f app

# Log PostgreSQL
docker compose --env-file .env.docker logs -f db

# Semua log
docker compose --env-file .env.docker logs -f
```

## Menghentikan dan Menjalankan Ulang (Data Tetap)

```bash
# Hentikan (data PostgreSQL tetap di volume)
docker compose --env-file .env.docker down

# Jalankan lagi
docker compose --env-file .env.docker up -d
```

Data database, admin, siswa, dll. tetap ada setelah restart.

Data database tetap disimpan pada named volume `futsal_academy_pg_data`. Panduan ini hanya memakai perintah stop yang mempertahankan data; jangan hapus volume jika database lokal masih dibutuhkan.

Jika named volume sudah pernah diinisialisasi, variabel `POSTGRES_USER`, `POSTGRES_DB`, dan `POSTGRES_PASSWORD` tidak mengubah role/database yang sudah ada. Jangan hapus volume untuk mengatasi login gagal. Pertahankan kredensial role yang sudah berlaku di `.env.docker`, atau ubah password role secara interaktif melalui `psql` (perintah `\password futsal`), lalu samakan `POSTGRES_PASSWORD` dan password pada `DATABASE_URL`.

## Mengakses PostgreSQL Langsung

PostgreSQL tersedia di `localhost:5432` (localhost-only):

```bash
# Menggunakan psql (jika terpasang lokal)
psql -h localhost -p 5432 -U futsal -d futsal_academy

# Atau via Docker
docker compose --env-file .env.docker exec db psql -U futsal -d futsal_academy
```

## Environment Variables yang Diperlukan

| Variable | Wajib | Keterangan |
|---|---|---|
| `POSTGRES_PASSWORD` | Ya (Compose) | Password lokal Postgres; samakan dengan URL aplikasi. |
| `POSTGRES_USER`, `POSTGRES_DB` | Opsional | Default Compose: `futsal`, `futsal_academy`. |
| `DATABASE_URL` | Ya (Docker/production) | PostgreSQL URL; host `db` dari container app. |
| `SESSION_SECRET`, `CSRF_SECRET` | Ya | Minimal 32 karakter; production menolak placeholder. |
| `INITIAL_ADMIN_EMAIL` | Saat provisioning | Email Admin awal; password selalu diminta tersembunyi. |
| `NODE_ENV`, `ACADEMY_TIMEZONE`, cookie/session/rate-limit/pool settings | Opsional | Nilai default tercantum pada `.env.example` dan `src/lib/env.ts`. |
| `PGLITE_DATA_DIR`, `PGLITE_DEBUG` | Opsional | PgLite lokal/test; tidak digunakan jika `DATABASE_URL` valid. |
| `TEST_DATABASE_URL` | Khusus integration test | Wajib DB terisolasi berakhiran `_test`; jangan set ke DB dev/prod. |

`.env.example` adalah daftar nama dan nilai default yang konsisten dengan schema aplikasi. `NETLIFY` dan `BUN_TEST` merupakan flag runtime, bukan secrets konfigurasi Docker.

## Privasi YouTube Unlisted

Video siswa tetap hanya dapat direferensikan melalui API yang memeriksa hubungan/assignment pengguna. Namun YouTube Unlisted **bukan privasi kuat**: siapa pun yang memiliki URL dapat membagikan dan menontonnya sesuai perilaku YouTube. Jangan gunakan untuk konten yang mensyaratkan pembatasan berbasis akun. Highlights YouTube publik di landing page merupakan konten publik yang berbeda.

## Batas Perubahan Riwayat Attendance

Perubahan reguler oleh Parent/Coach terkunci mulai pukul **00:00 Asia/Jakarta pada tanggal occurrence + 7 hari kalender**. Contoh: occurrence 1 Oktober terkunci mulai 8 Oktober pukul 00:00 WIB. Koreksi historis hanya melalui jalur Admin, dengan alasan wajib dan audit.

## Tes: PgLite dan PostgreSQL

`bun run test` memakai test setup proyek dan terutama PgLite untuk feedback cepat. PgLite tidak membuktikan perilaku concurrency PostgreSQL. Tes integrasi di `tests/integration/pg` perlu PostgreSQL khusus test; baca guard `tests/integration/pg/_helpers.ts`, gunakan nama database berakhiran `_test`, dan jangan arahkan ke development atau production karena setup dapat menghapus tabel.

## Perbedaan dengan Deployment Netlify

| Aspek | Docker Lokal | Netlify |
|---|---|---|
| Database | PostgreSQL di container (volume persistent) | PostgreSQL managed (eksternal) |
| Runtime | `next start` (Node.js, long-running) | Netlify serverless functions |
| DB Pool | `DB_POOL_MAX=5` (multi-request per instance) | `DB_POOL_MAX=1` (satu request per instance) |
| Build | `docker compose --env-file .env.docker build` | `npm run build` di Netlify CI |
| Migrasi | `docker compose --env-file .env.docker exec app bun run db:migrate` | Manual sebelum deploy |

## Troubleshooting

### Aplikasi tidak bisa connect ke database

1. Pastikan PostgreSQL sehat: `docker compose --env-file .env.docker ps db`
2. Cek log database: `docker compose --env-file .env.docker logs db`
3. Pastikan `DATABASE_URL` di `.env.docker` menggunakan hostname `db` (bukan `localhost`)
4. Pastikan `sslmode=disable` (PostgreSQL di Docker tidak menggunakan SSL)

### Build gagal

1. Pastikan `.dockerignore` tidak mengexclude file yang diperlukan
2. Cek log build: `docker compose --env-file .env.docker build --no-cache`
3. Pastikan `bun.lock` ada di root proyek

### Port 3000 sudah digunakan

Ubah port mapping di `docker-compose.yml`:
```yaml
ports:
  - "3001:3000"  # Akses di http://localhost:3001
```

### Port 5432 sudah digunakan

Ubah port mapping PostgreSQL di `docker-compose.yml`:
```yaml
ports:
  - "127.0.0.1:5433:5432"  # Akses di localhost:5433
```
