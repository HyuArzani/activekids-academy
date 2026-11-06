# Laporan Implementasi Phase A & B

**Tanggal laporan:** 23 Oktober 2026  
**Lingkup:** Docker development/environment/Admin provisioning; authorization dan attendance; dokumentasi YouTube Unlisted.  
**Repo saat laporan ini dibuat:** branch `main`, commit `24269b8` (`fix dependencies`), working tree bersih. Commit tersebut berisi 29 file implementasi yang dirangkum di bawah.

## Ringkasan pekerjaan

### A. Docker dan konfigurasi lingkungan

- Menambahkan `.env.example` dengan placeholder konfigurasi, serta `.gitignore` dan `.dockerignore` untuk mengabaikan file lingkungan lokal, dependency, hasil build, dan file database.
- Menambahkan `Dockerfile.dev` dan `docker-compose.dev.yml` untuk pengembangan dengan source bind mount, hot reload, volume `node_modules` terpisah, dan sinkronisasi dependency saat container berjalan.
- Memperbarui `docker-compose.yml` agar konfigurasi PostgreSQL menggunakan environment variable dan health check mengikuti user/database yang dikonfigurasi.
- Memperbarui panduan Docker lokal untuk setup, migrasi, seed, provisioning Admin, log, dan penghentian container tanpa menghapus volume. Panduan juga memperingatkan bahwa variabel PostgreSQL tidak mengganti kredensial pada volume yang sudah diinisialisasi.

### B. Provisioning Admin

- Mengubah `scripts/provision-admin.ts` agar menggunakan database adapter aplikasi dan PostgreSQL dari konfigurasi aplikasi.
- Provisioning mensyaratkan akademi sudah di-seed dan menolak berjalan jika `TEST_DATABASE_URL` terisi.
- Password dimasukkan melalui prompt tersembunyi; password akun yang sudah ada tidak ditimpa.
- Memperbarui validasi placeholder secret di `src/lib/env.ts`.

### C. Authorization dan attendance

- Menambahkan API Coach untuk melihat occurrence yang ditugaskan, melihat roster siswa yang ditugaskan, mencatat attendance, dan memperbarui attendance.
- Operasi Coach memeriksa role, akademi, penugasan, dan CSRF pada request tulis.
- Status attendance aktif dibatasi pada `present`, `absent`, dan `excused` di domain, API, UI Admin, dan migration.
- Menambahkan `migrations/0017_attendance_status_policy.sql`. Data historis `late` dikonversi ke status kanonis `present` dan nilai lamanya disimpan di `legacy_status`, agar informasi historis tetap tersedia untuk pelaporan.
- Memperbarui domain attendance dan entitlement, ringkasan dashboard, laporan, seed dashboard, dan tampilan Admin agar mendukung kebijakan baru serta menampilkan data historis.
- Penguncian reguler berlaku mulai **pukul 00:00 Asia/Jakarta pada tanggal occurrence + 7 hari kalender**. Contoh: occurrence 1 Oktober terkunci mulai 8 Oktober pukul 00:00 WIB.
- Koreksi historis tetap melalui jalur khusus Admin, memerlukan alasan, dan menghasilkan audit.
- Operasi Parent untuk move/skip entitlement menggunakan kebijakan lock yang sama.

### D. Dokumentasi privasi video

Dokumentasi menjelaskan bahwa YouTube Unlisted memberi akses berbasis tautan, bukan privasi kuat: tautan dapat dibagikan. Dokumentasi juga membedakan video Unlisted dari highlights YouTube publik.

## File yang berubah

**Docker, environment, dan panduan:**
- `.dockerignore`
- `.env.example`
- `.gitignore`
- `Dockerfile.dev`
- `docker-compose.dev.yml`
- `docker-compose.yml`
- `docs/docker-local.md`

**Provisioning dan konfigurasi:**
- `scripts/provision-admin.ts`
- `scripts/seed-dashboard.ts`
- `src/lib/env.ts`

**Migration, domain, dan UI attendance:**
- `migrations/0017_attendance_status_policy.sql`
- `src/lib/domain/attendance-policy.ts`
- `src/lib/domain/attendance.ts`
- `src/lib/domain/coach-attendance.ts`
- `src/lib/domain/dashboard.ts`
- `src/lib/domain/entitlements.ts`
- `src/lib/domain/reports.ts`
- `src/components/admin/AttendanceManagement.tsx`

**API:**
- `src/app/api/admin/attendance/[id]/correct/route.ts`
- `src/app/api/admin/attendance/[id]/route.ts`
- `src/app/api/admin/occurrences/[id]/attendance/route.ts`
- `src/app/api/coach/attendance/[id]/route.ts`
- `src/app/api/coach/occurrences/route.ts`
- `src/app/api/coach/occurrences/[id]/attendance/route.ts`
- `src/app/api/coach/occurrences/[id]/roster/route.ts`

**Tests:**
- `tests/unit/attendance-policy.test.ts`
- `tests/unit/env-validation.test.ts`
- `tests/integration/api/attendance.test.ts`
- `tests/integration/api/dashboard-summary.test.ts`

## Verifikasi yang tercatat

- `git diff --check` — berhasil.
- `node --experimental-strip-types --check` — pemeriksaan sintaks berhasil pada 20 file TypeScript.
- Smoke check kebijakan attendance — berhasil untuk status yang diizinkan, batas waktu Jakarta, konversi `Date`, dan tanggal tidak valid.
- `bun test tests/unit/attendance-policy.test.ts` — tidak berjalan karena Bun tidak tersedia.
- `npm run lint` — gagal dijalankan karena ESLint/dependency lokal tidak tersedia.
- `npm run build` — gagal dijalankan karena dependency proyek tidak tersedia.
- Docker/Compose tidak tersedia; karena itu konfigurasi Compose maupun image tidak diuji.
- Migration, seed, provisioning, PostgreSQL integration tests, dan pengujian integrasi tidak dijalankan. Tidak ada database atau volume yang diubah.

Pemeriksaan di atas adalah hasil dari sesi implementasi sebelumnya; tidak dijalankan ulang saat laporan ini dibuat.

## Batasan dan hal yang belum diverifikasi

- Migration `0017_attendance_status_policy.sql` belum diterapkan ke database.
- Build, lint penuh, unit test Bun, dan integration test belum tervalidasi di lingkungan dengan dependency serta Docker/PostgreSQL tersedia.
- Coach yang ditambahkan berupa API/domain; halaman UI Coach khusus belum dibuat.
- Tidak ada dependency baru dan konfigurasi Netlify tidak diubah.
- Tidak ada operasi destruktif database/Docker dan tidak ada commit baru yang dibuat saat penulisan laporan ini.
