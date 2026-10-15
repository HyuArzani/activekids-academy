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

# Database PostgreSQL (koneksi ke service 'db' di Compose)
DATABASE_URL=postgresql://futsal:futsal_local_dev@db:5432/futsal_academy?sslmode=disable

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

## Langkah 2: Build Docker Image

```bash
docker compose build
```

Build pertama akan memakan waktu beberapa menit (install dependencies + `next build`).

## Langkah 3: Jalankan PostgreSQL + Aplikasi

```bash
docker compose up -d
```

Perintah ini:
1. Memulai PostgreSQL (dengan health check)
2. Menunggu PostgreSQL siap
3. Memulai aplikasi Next.js

Cek status:
```bash
docker compose ps
```

## Langkah 4: Jalankan Migrasi Database

```bash
docker compose exec app bun run db:migrate
```

Ini menjalankan 16 file migrasi SQL (membuat semua tabel, index, constraint).

## Langkah 5: (Opsional) Jalankan Seed Data

```bash
docker compose exec app bun run db:seed
```

Membuat data contoh: akademi, kelas (Semangat, Membara), paket (4 sesi, 8 sesi), jadwal.

## Langkah 6: Buat Admin Pertama

```bash
docker compose exec app INITIAL_ADMIN_EMAIL=admin@futsal.local bun run provision-admin
```

Script akan meminta password via stdin. Gunakan password yang aman (min 8 karakter).

Alternatif (password via env, kurang aman):
```bash
docker compose exec -e INITIAL_ADMIN_EMAIL=admin@futsal.local -e INITIAL_ADMIN_PASSWORD=YourPassword123 app bun run provision-admin
```

## Langkah 7: Buka Aplikasi di Browser

Buka: **http://localhost:3000**

Anda akan melihat:
- Halaman landing publik (atau "Halaman akademi segera hadir" jika belum publish)
- Tombol "Masuk" untuk login admin

Login dengan email + password yang Anda buat di Langkah 6.

## Melihat Log Aplikasi

```bash
# Log aplikasi (real-time)
docker compose logs -f app

# Log PostgreSQL
docker compose logs -f db

# Semua log
docker compose logs -f
```

## Menghentikan dan Menjalankan Ulang (Data Tetap)

```bash
# Hentikan (data PostgreSQL tetap di volume)
docker compose down

# Jalankan lagi
docker compose up -d
```

Data database, admin, siswa, dll. tetap ada setelah restart.

## Menghapus Semua Data Lokal (PERINGATAN)

```bash
# HENTIKAN + HAPUS VOLUME (menghapus SEMUA data database — tidak bisa dibatalkan!)
docker compose down -v
```

Gunakan ini hanya ketika Anda ingin memulai dari nol. Volume `futsal_academy_pg_data` akan dihapus.

## Mengakses PostgreSQL Langsung

PostgreSQL tersedia di `localhost:5432` (localhost-only):

```bash
# Menggunakan psql (jika terpasang lokal)
psql -h localhost -p 5432 -U futsal -d futsal_academy

# Atau via Docker
docker compose exec db psql -U futsal -d futsal_academy
```

## Environment Variables yang Diperlukan

| Variable | Wajib | Contoh | Keterangan |
|---|---|---|---|
| `DATABASE_URL` | Ya | `postgresql://futsal:futsal_local_dev@db:5432/futsal_academy?sslmode=disable` | Connection string PostgreSQL |
| `SESSION_SECRET` | Ya | 64-char hex string | Secret untuk HMAC session token |
| `CSRF_SECRET` | Ya | 64-char hex string | Secret untuk CSRF token HMAC |
| `NODE_ENV` | Ya | `production` | Mode produksi (validasi secrets + DB URL) |
| `ACADEMY_TIMEZONE` | Tidak | `Asia/Jakarta` | Default: Asia/Jakarta |
| `DB_POOL_MAX` | Tidak | `5` | Pool size. Default: 10 |
| `PGLITE_DATA_DIR` | Tidak | (kosong) | Tidak digunakan ketika DATABASE_URL di-set |

## Perbedaan dengan Deployment Netlify

| Aspek | Docker Lokal | Netlify |
|---|---|---|
| Database | PostgreSQL di container (volume persistent) | PostgreSQL managed (eksternal) |
| Runtime | `next start` (Node.js, long-running) | Netlify serverless functions |
| DB Pool | `DB_POOL_MAX=5` (multi-request per instance) | `DB_POOL_MAX=1` (satu request per instance) |
| Build | `docker compose build` | `npm run build` di Netlify CI |
| Migrasi | `docker compose exec app bun run db:migrate` | Manual sebelum deploy |

## Troubleshooting

### Aplikasi tidak bisa connect ke database

1. Pastikan PostgreSQL sehat: `docker compose ps db`
2. Cek log database: `docker compose logs db`
3. Pastikan `DATABASE_URL` di `.env.docker` menggunakan hostname `db` (bukan `localhost`)
4. Pastikan `sslmode=disable` (PostgreSQL di Docker tidak menggunakan SSL)

### Build gagal

1. Pastikan `.dockerignore` tidak mengexclude file yang diperlukan
2. Cek log build: `docker compose build --no-cache`
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
